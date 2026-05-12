import config from "../../config";
import { AgentContext } from "../../core/context";
import { run_build_dom_tree } from "./build_dom_tree";
import { buildA11yElementTree, A11yElementResult, injectDomHighlightOverlays, removeDomHighlightOverlays, run_build_dom_a11y_tree, captureScreenshotViaCDP } from "./build_dom_a11y_tree";
import { BaseBrowserAgent, AGENT_NAME } from "./browser_base";
import { capture_dom_state, DomState, detectDomChanges } from "./dom_ckpt";
import {
  PageStateChange,
  BeforeState,
  captureWithTimeout,
  capturePageStateWithTimeout,
  buildBrowserToolResult,
  detectPageStateChange,
} from "./page_state_detector";
import {
  navigateWithRetry,
  isNavigationFailure,
  describeNavigationFailure,
} from "./navigate_retry";
import { tryCaptureSnapshotForHistory } from "./snapshot_recovery";
import {
  isSnapshotUploadEnabled,
  createSnapshotContext,
  uploadScreenshot,
  uploadPseudoDom,
  uploadFullDom,
  logInferenceTimePageDrift,
} from "./snapshot_uploader";
import {
  LanguageModelV2Prompt,
  LanguageModelV2FilePart,
  LanguageModelV2ToolCallPart,
} from "@ai-sdk/provider";
import { Tool, ToolResult, IMcpClient } from "../../types";
import { mark_screenshot_highlight_elements } from "./utils";
import { getLabelStyle } from "./label_style";
import { getScreenshotDescription } from "./screenshot_prompt";
import { run_install_noocclude_label_hook, run_revalidate_area_map } from "./highlight_label";
import { run_install_is_top_element_multi_probe_hook } from "./is_top_element_multi_probe";
import {
  run_install_action_landing_watchdog_hook,
  run_flush_action_landing_events,
} from "./action_landing_watchdog";
import { mergeTools, sleep, toImage, compressImageData } from "../../common/utils";
import { PARAM_SOURCES_PROMPT } from "../../common/param_source";

/**
 * Selector type for element resolution.
 * Can be a numeric index or an object with semantic properties.
 */
export type BrowserSelector = number | {
  index?: number;
  id?: string;
  name?: string;
  ariaLabel?: string;
  title?: string;
  value?: string;
  text?: string;
  textContains?: string;
  placeholder?: string;
  tag?: string;
  type?: string;
  role?: string;
  class?: string;
};

export default abstract class BaseBrowserLabelsAgent extends BaseBrowserAgent {
  // Step counter for debug snapshot filenames
  private _debugStepCounter: number = 0;
  
  // Stores the DomState captured after the last tool execution.
  // Used by onBeforeToolExecute to detect page drift during LLM inference time.
  private _lastAfterDomState: DomState | null = null;
  
  private getDebugStepNumber(): string {
    this._debugStepCounter++;
    return this._debugStepCounter.toString().padStart(3, '0');
  }

  /**
   * Override hook to detect inference-time drift before each tool execution.
   * Captures a lightweight DOM fingerprint and compares it with the state captured
   * after the previous tool, to measure how much the page changed during LLM inference time.
   * Skipped for parallel tool calls since concurrent mutations make drift measurement meaningless.
   */
  protected async onBeforeToolExecute(
    agentContext: AgentContext,
    toolCall: LanguageModelV2ToolCallPart,
    isParallel: boolean = false
  ): Promise<void> {
    // Skip drift detection for parallel tool calls — concurrent mutations
    // from sibling tools make the measurement meaningless
    if (isParallel || !this._lastAfterDomState) {
      return;
    }
    
    try {
      const currentDomState = await this.execute_script(
        agentContext, capture_dom_state, []
      ) as DomState;
      
      if (!currentDomState) {
        return;
      }
      
      const { hasSignificantChange, changes, changeDescriptions } = detectDomChanges(
        this._lastAfterDomState,
        currentDomState
      );
      
      const timeSinceLastSnapshot = currentDomState.timestamp - this._lastAfterDomState.timestamp;
      
      const driftData = {
        hasDrift: hasSignificantChange,
        timeSinceLastSnapshotMs: timeSinceLastSnapshot,
        addedCount: changes.addedCount,
        removedCount: changes.removedCount,
        modifiedCount: changes.modifiedCount,
        summary: changes.summary,
        details: changeDescriptions.slice(0, 5),
      };
      
      // Log to progress.json for analysis
      logInferenceTimePageDrift(
        agentContext.agent.Name,
        toolCall.toolName,
        toolCall.toolCallId || 'unknown',
        driftData
      );
      
      if (hasSignificantChange) {
        console.log(
          '[Page Drift] Detected drift before tool execution.',
          'Tool:', toolCall.toolName,
          'ToolCallId:', toolCall.toolCallId,
          'TimeSinceLastSnapshot:', timeSinceLastSnapshot, 'ms',
          'Summary:', changes.summary,
          'Details:', changeDescriptions.slice(0, 5).join('; ')
        );
      } else {
        console.log(
          '[Page Drift] No drift detected.',
          'Tool:', toolCall.toolName,
          'TimeSinceLastSnapshot:', timeSinceLastSnapshot, 'ms'
        );
      }
    } catch (e) {
      console.error('[Page Drift] Exception in onBeforeToolExecute:', e);
    }
  }

  /**
   * Override hook to upload screenshot after each tool execution.
   * This is called from the base Agent class after every tool call completes.
   */
  protected async onAfterToolExecute(
    agentContext: AgentContext,
    toolCall: LanguageModelV2ToolCallPart,
    toolResult: ToolResult,
    isParallel: boolean = false
  ): Promise<void> {
    // ── Action-landing watchdog: drain events, attach to toolResult ─────
    // Events are produced in-page by action_landing_watchdog.ts when the
    // `actionLandingWatchdog` flag is on. We attach them as a TOP-LEVEL
    // field on the ToolResult wrapper (NOT inside content[0].text) so the
    // LLM never sees them. The websape tool_result handler reads them
    // off the wrapper and writes them to progress.json.
    if (config.actionLandingWatchdog && !isParallel) {
      try {
        const events = (await this.execute_script(
          agentContext,
          run_flush_action_landing_events,
          []
        )) as any[] | null;
        if (Array.isArray(events) && events.length > 0) {
          (toolResult as any).actionLandingEvents = events;
        }
      } catch (e) {
        // Non-critical: if flush fails (e.g., page navigated), skip silently.
        console.warn('[ActionLandingWatchdog] Failed to flush events:', e);
      }
    }

    // Upload screenshot and DOM to server for debugging (all browser tools)
    if (isSnapshotUploadEnabled()) {
      try {
        // Small delay to allow page to settle after tool execution
        // Note: Navigation-triggering tools (click_element, input_text with enter) 
        // already wait for page load in their own implementations.
        //
        // Under noocclude we bump this from 100→250ms to give CSS
        // open/close animations (modal fades, dropdowns) a chance to
        // finish before we sample bounding rects — paired with the
        // pre-screenshot revalidation pass in screenshot_and_html_*
        // it eliminates stale-rect annotations.
        await sleep(getLabelStyle() === "noocclude" ? 250 : 100);
        
        const stepNum = this.getDebugStepNumber();
        const toolCallId = toolCall.toolCallId || 'unknown';
        const context = createSnapshotContext(stepNum, toolCallId);
        console.log('[Screenshot Debug] After tool execution - Accumulating snapshot, Step:', stepNum, 'ToolCallId:', toolCallId, 'Tool:', toolCall.toolName);
        
        // Take screenshot and get pseudo DOM
        const result = await this.screenshot_and_html(agentContext);
        
        // Upload screenshot
        if (result.imageBase64) {
          uploadScreenshot({
            imageBase64: result.imageBase64,
            imageType: result.imageType,
          }, context);
        }
        
        // Upload Pseudo DOM
        if (result.pseudoHtml) {
          uploadPseudoDom(result.pseudoHtml, context);
        }

        // Upload Full DOM HTML
        try {
          const fullDomHtml = await this.execute_script(agentContext, () => {
            return document.documentElement.outerHTML;
          }, []) as string;
          
          if (fullDomHtml) {
            uploadFullDom(fullDomHtml, context);
          }
        } catch (domErr) {
          console.error('[Screenshot Debug] Failed to get full DOM:', domErr);
        }
      } catch (e) {
        console.error('[Screenshot Debug] Exception in onAfterToolExecute:', e);
      }
    }
    
    // Capture DomState after tool execution for drift detection.
    // Skip for parallel tool calls — concurrent mutations mean the captured state
    // is non-deterministic and not a reliable baseline for the next step.
    if (!isParallel) {
      try {
        this._lastAfterDomState = await this.execute_script(
          agentContext, capture_dom_state, []
        ) as DomState;
      } catch (e) {
        // Non-critical: if capture fails (e.g., page navigating), just clear the state
        this._lastAfterDomState = null;
      }
    }
  }

  /**
   * Override to remove 'interactive_elements' field and 'domChanges' from pageStateChange in tool results 
   * before adding to message history. This reduces token cost since these data can be very large.
   */
  protected sanitizeToolResultForHistory(toolResult: ToolResult): ToolResult {
    if (!toolResult || !toolResult.content) {
      return toolResult;
    }

    // Process each content item
    const sanitizedContent = toolResult.content.map((item) => {
      if (item.type === 'text' && item.text) {
        try {
          // Check if the text is JSON
          if ((item.text.startsWith('{') && item.text.endsWith('}')) ||
              (item.text.startsWith('[') && item.text.endsWith(']'))) {
            const parsed = JSON.parse(item.text);
            // Process object (not array)
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              let modified = false;
              let result = { ...parsed };
              
              // Remove 'interactive_elements' field if present
              if ('interactive_elements' in result) {
                const { interactive_elements, ...rest } = result;
                result = rest;
                modified = true;
              }
              
              // Remove 'domChanges' from pageStateChange if present
              if (result.pageStateChange && typeof result.pageStateChange === 'object' && 'domChanges' in result.pageStateChange) {
                const { domChanges, ...restPageStateChange } = result.pageStateChange;
                result = { ...result, pageStateChange: restPageStateChange };
                modified = true;
              }
              
              if (modified) {
                return {
                  ...item,
                  text: JSON.stringify(result),
                };
              }
            }
          }
        } catch (e) {
          // Not valid JSON, return as-is
        }
      }
      return item;
    }) as ToolResult['content'];

    return {
      ...toolResult,
      content: sanitizedContent,
    };
  }

  constructor(llms?: string[], ext_tools?: Tool[], mcpClient?: IMcpClient) {
    let description = `You are a browser operation agent, use structured commands to interact with the browser.
* This is a browser GUI interface where you need to analyze webpages by taking screenshot and page element structures, and specify action sequences to complete designated tasks.
* For your first visit, please start by calling either the \`navigate_to\` or \`current_page\` tool. After each action you perform, I will provide you with updated information about the current state, including page screenshots and structured element data that has been specially processed for easier analysis.
* During execution, please output user-friendly step information. Do not output HTML-related element and index information to users, as this would cause user confusion.

${getScreenshotDescription(getLabelStyle(), config.markImageMode)}
* Element interaction:
  - CRITICAL SELECTOR PRIORITY: When selecting elements for click_element or input_text, you MUST prefer semantic selectors over index:
    1. FIRST: Use 'id' if the element has an id attribute (most stable)
    2. SECOND: Use 'name' if the element has a name attribute (especially for form fields)
    3. THIRD: Use 'ariaLabel' if the element has an aria-label
    4. FOURTH: Use 'value' if the element has a value attribute (buttons, tabs, options)
    5. FIFTH: Use 'text' or 'textContains' for buttons/links with visible text
    6. SIXTH: Use 'placeholder' for input fields
    7. SEVENTH: Use 'tag' + 'type' combination (e.g., {tag: "input", type: "submit"})
    8. LAST RESORT ONLY: Use 'index' - only when NO semantic identifier exists
  - NEVER use index if the element has id, name, ariaLabel, value, text, or placeholder available
  - Browser tools only return elements in visible viewport by default
  - Each element has a unique index number (e.g., "[33]:<button>Submit</button>")
  - Elements marked with "[]:" are non-interactive (for context only, e.g., "[]: Google")
  - Use the latest element data, do not rely on historical outdated elements
  - Due to technical limitations, not all interactive elements may be identified; use coordinates to interact with unlisted elements
${PARAM_SOURCES_PROMPT}
* Error handling:
  - If no suitable elements exist, use other functions to complete the task
  - If stuck, try alternative approaches, don't refuse tasks
  - Handle popups/cookies by accepting or closing them
  - When encountering scenarios that require user assistance such as login, verification codes, QR code scanning, Payment, etc, you can request user help.
  - CRITICAL FOR LOGIN/AUTHENTICATION: When you see ANY of the following, you MUST immediately call human_interact with interactType="request_help" and helpType="request_login":
    * Login pages (email/username input, password input, sign-in buttons)
    * Passkey/biometric authentication prompts (Windows Hello, fingerprint, face recognition)
    * Multi-factor authentication (MFA/2FA) prompts
    * Security verification dialogs or popups
    * "Choose an account" or account picker screens
    * Any page asking user to authenticate or verify identity
    DO NOT just output text asking user to complete it - you MUST call the human_interact tool. DO NOT use interactType="input" for credentials.
* Browser operation:
  - Use scroll to find elements you are looking for, When extracting content, prioritize using extract_page_content, only scroll when you need to load more content
  - If possible, prefer to just leverage "interactive_elements" tool call results of the immediate prior navigate_to/current_page/etc tool call, as the "interactive_elements" field for new selected tools without any extra modification.
  - Please follow user instructions and don't be lazy until the task is completed. For example, if a user asks you to find 30 people, don't just find 10 - keep searching until you find all 30.
* SEQUENTIAL TOOL BATCHING:
  - When you know the next several steps with certainty, output ALL those tool calls in one response instead of one at a time.
  - For example: if you need to fill a form with multiple fields, output all input_text calls together.
  - If you need to click a button and then wait for the page, output both click_element and wait calls together.
  - The system executes tool calls in the order you provide them. Only pause and wait for feedback when you genuinely need to see the result before deciding what to do next.
  - This approach is more efficient and reduces the number of LLM round-trips.
    `;
    if (config.parallelToolCalls) {
      description += `
* Parallelism:
   - Do not call navigate_to, click_element, scroll_mouse_wheel, or switch_tab simultaneously
   - Operations that support parallelism are limited to input_text operations
   - When filling out a form, input fields that are not dependent on each other can be filled simultaneously
   - Avoid parallel processing for dependent operations, such as those that need to wait for page loading, DOM changes, redirects, subsequent operations that depend on the results of previous operations, or operations that may interfere with each other and affect the same page elements. In these cases, please do not use parallelization.`;
    }
    const _tools_ = [] as Tool[];
    super({
      name: AGENT_NAME,
      description: description,
      tools: _tools_,
      llms: llms,
      mcpClient: mcpClient,
      planDescription:
        "Browser operation agent, interact with the browser using the mouse and keyboard.",
    });
    let init_tools = this.buildInitTools();
    if (ext_tools && ext_tools.length > 0) {
      init_tools = mergeTools(init_tools, ext_tools);
    }
    init_tools.forEach((tool) => _tools_.push(tool));
  }

  protected async input_text(
    agentContext: AgentContext,
    selector: BrowserSelector,
    text: string,
    enter: boolean
  ): Promise<{ canonicalSelector?: any }> {
    // Ensure the element resolver is available (may have been lost after page navigation)
    await this.ensureElementResolver(agentContext);
    
    const result = await this.execute_script(agentContext, typing, [{ selector, text, enter }]);
    
    // Check if typing succeeded
    if (result && !result.success) {
      throw new Error(`Typing failed: ${result.error}`);
    }
    
    // Wait for blur event handlers and UI updates to complete
    // This is important for frameworks like React/Fluent UI that process blur asynchronously
    await sleep(100);
    
    if (enter) {
      // Enter key may trigger form submission/navigation
      // Wait for page to fully load before continuing
      await this.waitForPageLoad(agentContext, 5000);
    }
    
    return { canonicalSelector: result?.canonicalSelector };
  }

  /**
   * Wait for page to finish loading after navigation.
   * Polls document.readyState and waits for 'complete' state.
   * @param agentContext The agent context
   * @param timeout Maximum time to wait in milliseconds
   */
  protected async waitForPageLoad(
    agentContext: AgentContext,
    timeout: number = 5000
  ): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 100;
    
    // First, give a small initial delay for navigation to start
    await sleep(200);
    
    while (Date.now() - startTime < timeout) {
      try {
        const state = await this.execute_script(agentContext, () => {
          return {
            readyState: document.readyState,
            url: window.location.href
          };
        }, []) as { readyState: string; url: string } | null;
        
        if (state && state.readyState === 'complete') {
          console.log('[Screenshot Debug] Page load complete:', state.url);
          // Additional small delay for any post-load JavaScript to execute
          await sleep(300);
          return;
        }
        
        console.log('[Screenshot Debug] Waiting for page load, current state:', state?.readyState);
      } catch (e) {
        // Script execution might fail during navigation, this is expected
        console.log('[Screenshot Debug] Page in transition, waiting...');
      }
      
      await sleep(pollInterval);
    }
    
    console.log('[Screenshot Debug] Page load wait timed out after', timeout, 'ms');
  }

  /**
   * Ensure that window.resolve_element_by_selector is available in the page context.
   * This function is set up by screenshot_and_html but is lost after page navigation.
   * If not available, we call screenshot_and_html to set it up.
   */
  protected async ensureElementResolver(agentContext: AgentContext): Promise<void> {
    // Check if resolver exists
    const hasResolver = await this.execute_script(agentContext, () => {
      return typeof (window as any).resolve_element_by_selector === 'function';
    }, []);
    
    if (!hasResolver) {
      console.log('[ensureElementResolver] resolve_element_by_selector not available, calling screenshot_and_html to set it up...');
      await this.screenshot_and_html(agentContext);
      console.log('[ensureElementResolver] Element resolver should now be available');
    }
  }

  protected async click_element(
    agentContext: AgentContext,
    selector: BrowserSelector,
    num_clicks: number,
    button: "left" | "right" | "middle"
  ): Promise<{ canonicalSelector?: any }> {
    // Ensure the element resolver is available (may have been lost after page navigation)
    await this.ensureElementResolver(agentContext);
    
    // Step 1: Hover first to trigger any lazy-loaded event handlers or DOM updates
    const hoverResult = await this.execute_script(agentContext, hover_to, [{ selector }]);
    
    // Check if hover succeeded - element must exist
    if (hoverResult && !hoverResult.success) {
      throw new Error(`Hover failed: ${hoverResult.error}`);
    }
    
    // Step 2: Wait for DOM to stabilize after hover (some UIs update on hover)
    await sleep(100);
    
    // Step 3: Perform the click - do_click will re-resolve the element in case DOM changed
    const clickResult = await this.execute_script(agentContext, do_click, [
      { selector, num_clicks, button },
    ]);
    
    // Check if click succeeded
    if (clickResult && !clickResult.success) {
      throw new Error(`Click failed: ${clickResult.error}`);
    }
    
    // Step 4: Click may trigger navigation, wait for page to fully load
    await this.waitForPageLoad(agentContext, 5000);
    
    // Return the canonical selector from the click result
    return { canonicalSelector: clickResult?.canonicalSelector };
  }

  protected async scroll_to_element(
    agentContext: AgentContext,
    selector: BrowserSelector
  ): Promise<void> {
    // Ensure the element resolver is available
    await this.ensureElementResolver(agentContext);
    
    const result = await this.execute_script(
      agentContext,
      scroll_to_element,
      [{ selector }]
    );
    
    // Check if scroll succeeded
    if (result && !result.success) {
      throw new Error(`Scroll to element failed: ${result.error}`);
    }
    
    await sleep(200);
  }

  protected async scroll_mouse_wheel(
    agentContext: AgentContext,
    amount: number,
    extract_page_content: boolean
  ): Promise<any> {
    await this.execute_script(agentContext, scroll_by, [{ amount }]);
    await sleep(200);
    if (!extract_page_content) {
      const tools = this.toolUseNames(
        agentContext.agentChain.agentRequest?.messages
      );
      let scroll_count = 0;
      for (let i = tools.length - 1; i >= Math.max(tools.length - 8, 0); i--) {
        if (tools[i] == "scroll_mouse_wheel") {
          scroll_count++;
        }
      }
      if (scroll_count >= 3) {
        extract_page_content = true;
      }
    }
    if (extract_page_content) {
      let page_result = await this.extract_page_content(agentContext);
      return {
        result:
          "The current page content has been extracted, latest page content:\n" +
          "title: " +
          page_result.title +
          "\n" +
          "page_url: " +
          page_result.page_url +
          "\n" +
          "page_content: " +
          page_result.page_content,
      };
    }
  }

  protected async hover_to_element(
    agentContext: AgentContext,
    selector: BrowserSelector
  ): Promise<{ canonicalSelector?: any }> {
    const result = await this.execute_script(agentContext, hover_to, [{ selector }]);
    
    // Check if hover succeeded
    if (result && !result.success) {
      throw new Error(`Hover failed: ${result.error}`);
    }
    
    return { canonicalSelector: result?.canonicalSelector };
  }

  protected async drag_element(
    agentContext: AgentContext,
    selector: BrowserSelector,
    offsetX: number,
    offsetY: number
  ): Promise<{ success: boolean; newValue?: string; canonicalSelector?: any }> {
    const result = await this.execute_script(agentContext, drag_element, [{ selector, offsetX, offsetY }]);
    
    // Check if drag succeeded
    if (result && !result.success) {
      throw new Error(`Drag failed: ${result.error}`);
    }
    
    return { success: true, newValue: result?.newValue, canonicalSelector: result?.canonicalSelector };
  }

  protected async get_select_options(
    agentContext: AgentContext,
    selector: BrowserSelector
  ): Promise<{ options: any; name: string }> {
    const result = await this.execute_script(agentContext, get_select_options, [
      { selector },
    ]);
    
    // Check if get_select_options succeeded
    if (result && !result.success) {
      throw new Error(`Get select options failed: ${result.error}`);
    }
    
    return result;
  }

  protected async select_option(
    agentContext: AgentContext,
    selector: BrowserSelector,
    option: string
  ): Promise<{ canonicalSelector?: any }> {
    const result = await this.execute_script(agentContext, select_option, [
      { selector, option },
    ]);
    
    // Check if select_option succeeded
    if (result && !result.success) {
      throw new Error(`Select option failed: ${result.error}`);
    }
    
    return { canonicalSelector: result?.canonicalSelector };
  }

  protected async screenshot_and_html(agentContext: AgentContext): Promise<{
    imageBase64?: string;
    imageType?: "image/jpeg" | "image/png";
    pseudoHtml: string;
    double_screenshots?: {
      imageBase64: string;
      imageType: "image/jpeg" | "image/png";
    };
    client_rect: { width: number; height: number };
  }> {
    // Check if we should use accessibility tree mode
    if (config.treeBuildMode === "a11y") {
      return await this.screenshot_and_html_a11y(agentContext);
    }
    return await this.screenshot_and_html_dom(agentContext);
  }

  
  /**
   * Build element tree using accessibility tree via CDP.
   * This is an alternative to the DOM-based approach that provides
   * a more accurate representation of what assistive technologies see.
   */
  protected async screenshot_and_html_a11y(agentContext: AgentContext): Promise<{
    imageBase64?: string;
    imageType?: "image/jpeg" | "image/png";
    pseudoHtml: string;
    double_screenshots?: {
      imageBase64: string;
      imageType: "image/jpeg" | "image/png";
    };
    client_rect: { width: number; height: number };
  }> {
    const cdp = await this.getCDPSession(agentContext);
    
    // Fail hard if CDP is not available — never silently degrade to eko-native DOM
    if (!cdp) {
      throw new Error("[screenshot_and_html_a11y] CDP session not available. Cannot build a11y tree without CDP.");
    }

    try {
      let element_result: A11yElementResult | null = null;
      let double_screenshots;

      // Build accessibility tree (always get bounding boxes for highlighting)
      for (let i = 0; i < 3; i++) {
        try {
          await sleep(200);
          element_result = await buildA11yElementTree(cdp as any, {
            markHighlightElements: false, // We always get area_map now
            includeNonIndexedElements: config.includeNonIndexedElements,
          });
          if (element_result && element_result.element_str) {
            break;
          }
        } catch (e) {
          console.warn(`[screenshot_and_html_a11y] Attempt ${i + 1} failed:`, e);
          if (i === 2) {
            // Last attempt failed — throw instead of silently falling back
            await cdp.detach();
            throw new Error(`[screenshot_and_html_a11y] All 3 attempts to build a11y tree failed. Last error: ${e}`);
          }
        }
      }

      if (!element_result) {
        await cdp.detach();
        throw new Error("[screenshot_and_html_a11y] a11y tree building returned no results after retries.");
      }

      // Set up window.clickable_elements and window.resolve_element_by_selector for a11y mode
      // This resolves backendDOMNodeIds to actual DOM elements for click/type/hover operations
      if (element_result.selector_map) {
        console.log(`[screenshot_and_html_a11y] Calling run_build_dom_a11y_tree with ${Object.keys(element_result.selector_map).length} elements...`);
        await run_build_dom_a11y_tree(cdp as any, element_result.selector_map);
      } else {
        console.warn(`[screenshot_and_html_a11y] selector_map is empty or undefined, skipping run_build_dom_a11y_tree`);
      }

      const areaMapSize = element_result.area_map ? Object.keys(element_result.area_map).length : 0;
      const shouldHighlight = config.mode !== "fast" && areaMapSize > 0;
      console.log(`[screenshot_and_html_a11y] shouldHighlight=${shouldHighlight}, mode=${config.mode}, markImageMode=${config.markImageMode}, area_map size=${areaMapSize}`);

      // Noocclude: re-check each highlighted element's visibility/rect just
      // before either DOM overlay injection or canvas drawing, so closing
      // modals / fading dropdowns / detached nodes are NOT annotated. The
      // DOM tree was sampled at T0 but the screenshot will be captured at
      // T0+~300ms, long enough for in-flight CSS transitions to finish.
      // injectDomHighlightOverlays + mark_screenshot_highlight_elements
      // both already honour `area.noDraw === true` and skip rendering.
      if (
        shouldHighlight &&
        getLabelStyle() === "noocclude" &&
        element_result.area_map
      ) {
        try {
          const reval = (await this.execute_script(
            agentContext,
            run_revalidate_area_map,
            [{ areaMap: element_result.area_map, threshold: 8 }]
          )) as { stale: number[] };
          if (reval && reval.stale && reval.stale.length > 0) {
            for (const idx of reval.stale) {
              const entry: any = (element_result.area_map as any)[idx];
              if (entry) entry.noDraw = true;
            }
            console.log(`[screenshot_and_html_a11y] Marked ${reval.stale.length} stale area_map entries as noDraw`);
          }
        } catch (e) {
          console.warn('[screenshot_and_html_a11y] revalidate_area_map failed:', e);
        }
      }

      // For "dom" mode: inject DOM overlays before screenshot
      if (shouldHighlight && config.markImageMode === "dom") {
        // Install noocclude label hook if that style is active (same as eko-native path)
        if (getLabelStyle() === "noocclude") {
          await this.execute_script(agentContext, run_install_noocclude_label_hook, []);
        }
        // Install multi-probe isTopElement override if configured (rescues partially-occluded elements)
        if (config.multiProbeIsTopElement) {
          await this.execute_script(agentContext, run_install_is_top_element_multi_probe_hook, []);
        }
        // Install action-landing watchdog if configured (rescues covered click/hover via scrollIntoView)
        if (config.actionLandingWatchdog) {
          await this.execute_script(agentContext, run_install_action_landing_watchdog_hook, []);
        }
        console.log(`[screenshot_and_html_a11y] Injecting ${Object.keys(element_result.area_map!).length} DOM highlight overlays`);
        await injectDomHighlightOverlays(cdp as any, element_result.area_map!);
        await sleep(200); // Allow overlays to render
      }

      await sleep(100);

      let screenshot: { imageBase64: string; imageType: "image/jpeg" | "image/png" } | undefined;
      
      if (config.mode === "fast") {
        screenshot = undefined;
      } else if (shouldHighlight && config.markImageMode === "dom") {
        // Use CDP screenshot when DOM overlays are injected - this guarantees we capture the overlays
        console.log(`[screenshot_and_html_a11y] Using CDP Page.captureScreenshot for DOM overlay mode`);
        screenshot = await captureScreenshotViaCDP(cdp as any, { format: "jpeg", quality: 60 });
      } else {
        screenshot = await this.screenshot_and_compress(
          agentContext,
          element_result.client_rect
        );
      }

      // Remove DOM overlays after screenshot (for "dom" mode)
      if (shouldHighlight && config.markImageMode === "dom") {
        await removeDomHighlightOverlays(cdp as any);
      }
      
      // Store original screenshot before any modifications
      if (screenshot?.imageBase64) {
        double_screenshots = { ...screenshot };
      }

      // For "draw" mode: draw bounding boxes on the screenshot image
      if (
        shouldHighlight &&
        config.markImageMode === "draw" &&
        screenshot?.imageBase64
      ) {
        console.log(`[screenshot_and_html_a11y] Drawing ${Object.keys(element_result.area_map!).length} bounding boxes on screenshot`);
        const markImageBase64 = await mark_screenshot_highlight_elements(
          screenshot,
          element_result.area_map!,
          element_result.client_rect
        );
        screenshot.imageBase64 = markImageBase64;
      }

      const pseudoHtml = element_result.element_str || "";
      return {
        double_screenshots: double_screenshots,
        imageBase64: screenshot?.imageBase64,
        imageType: screenshot?.imageType,
        pseudoHtml: pseudoHtml,
        client_rect: element_result.client_rect,
      };
    } finally {
      try {
        await cdp.detach();
      } catch (e) {}
    }
  }

  /**
   * Build element tree using DOM traversal (original implementation).
   */
  protected async screenshot_and_html_dom(agentContext: AgentContext): Promise<{
    imageBase64?: string;
    imageType?: "image/jpeg" | "image/png";
    pseudoHtml: string;
    double_screenshots?: {
      imageBase64: string;
      imageType: "image/jpeg" | "image/png";
    };
    client_rect: { width: number; height: number };
  }> {
    try {
      let element_result;
      let double_screenshots;
      for (let i = 0; i < 5; i++) {
        await sleep(200);
        // Install noocclude label hook if that style is active
        if (getLabelStyle() === "noocclude") {
          await this.execute_script(agentContext, run_install_noocclude_label_hook, []);
        }
        // Install multi-probe isTopElement override if configured (rescues partially-occluded elements)
        if (config.multiProbeIsTopElement) {
          await this.execute_script(agentContext, run_install_is_top_element_multi_probe_hook, []);
        }
        // Install action-landing watchdog if configured (rescues covered click/hover via scrollIntoView)
        if (config.actionLandingWatchdog) {
          await this.execute_script(agentContext, run_install_action_landing_watchdog_hook, []);
        }
        await this.execute_script(agentContext, run_build_dom_tree, []);
        await sleep(50);
        element_result = (await this.execute_script(
          agentContext,
          (params: { markHighlightElements: boolean; includeAttributes: any; includeNonIndexedElements: boolean; viewportExpansion: number | null }) => {
            return (window as any).get_clickable_elements(
              params.markHighlightElements,
              params.includeAttributes,
              params.includeNonIndexedElements,
              params.viewportExpansion
            );
          },
          [{ markHighlightElements: config.mode != "fast" && config.markImageMode == "dom", includeAttributes: null, includeNonIndexedElements: config.includeNonIndexedElements, viewportExpansion: config.viewportExpansion }]
        )) as any;
        if (element_result) {
          break;
        }
      }

      if (!element_result) {
        throw new Error("[screenshot_and_html_dom] DOM tree building returned no results after 5 retries.");
      }

      // Noocclude: re-check rects/visibility just before screenshot so
      // mid-animation elements (closing modals, fading dropdowns) are not
      // annotated. mark_screenshot_highlight_elements honours noDraw.
      if (
        getLabelStyle() === "noocclude" &&
        element_result.area_map &&
        Object.keys(element_result.area_map).length > 0
      ) {
        try {
          const reval = (await this.execute_script(
            agentContext,
            run_revalidate_area_map,
            [{ areaMap: element_result.area_map, threshold: 8 }]
          )) as { stale: number[] };
          if (reval && reval.stale && reval.stale.length > 0) {
            for (const idx of reval.stale) {
              const entry: any = (element_result.area_map as any)[idx];
              if (entry) entry.noDraw = true;
            }
            console.log(`[screenshot_and_html_dom] Marked ${reval.stale.length} stale area_map entries as noDraw`);
          }
        } catch (e) {
          console.warn('[screenshot_and_html_dom] revalidate_area_map failed:', e);
        }
      }

      await sleep(100);
      const screenshot =
        config.mode == "fast"
          ? undefined
          : await this.screenshot_and_compress(
              agentContext,
              element_result.client_rect
            );
      if (
        config.markImageMode == "draw" &&
        screenshot?.imageBase64 &&
        element_result.area_map
      ) {
        double_screenshots = { ...screenshot };
        const markImageBase64 = await mark_screenshot_highlight_elements(
          screenshot,
          element_result.area_map,
          element_result.client_rect
        );
        screenshot.imageBase64 = markImageBase64;
      }
      const pseudoHtml = element_result.element_str || "";
      return {
        double_screenshots: double_screenshots,
        imageBase64: screenshot?.imageBase64,
        imageType: screenshot?.imageType,
        pseudoHtml: pseudoHtml,
        client_rect: element_result.client_rect,
      };
    } finally {
      try {
        await this.execute_script(
          agentContext,
          () => {
            return (window as any).remove_highlight();
          },
          []
        );
      } catch (e) {}
    }
  }

  protected async screenshot_and_compress(
    agentContext: AgentContext,
    client_rect?: { width: number; height: number }
  ): Promise<{
    imageBase64: string;
    imageType: "image/jpeg" | "image/png";
  }> {
    const screenshot = await this.screenshot(agentContext);
    if (!client_rect || !screenshot) {
      return screenshot;
    }
    const compressedImage = await compressImageData(
      screenshot.imageBase64,
      screenshot.imageType,
      {
        resizeWidth: client_rect.width,
        resizeHeight: client_rect.height,
      }
    );
    return {
      imageBase64: compressedImage.imageBase64,
      imageType: compressedImage.imageType,
    };
  }

  protected get_element_script(index: number): string {
    return `window.get_highlight_element(${index});`;
  }


  public canParallelToolCalls(
    toolCalls?: LanguageModelV2ToolCallPart[]
  ): boolean {
    if (toolCalls) {
      for (let i = 0; i < toolCalls.length; i++) {
        const toolCall = toolCalls[i];
        if (
          toolCall.toolName == "wait" ||
          toolCall.toolName == "navigate_to" ||
          toolCall.toolName == "switch_tab" ||
          toolCall.toolName == "scroll_mouse_wheel" ||
          toolCall.toolName == "click_element"
        ) {
          return false;
        }
      }
    }
    return super.canParallelToolCalls(toolCalls);
  }

  private buildInitTools(): Tool[] {
    return [
      {
        name: "navigate_to",
        description:
          "Navigate to a specific URL in the browser. Use this tool when you need to visit a webpage or change the current page location. Returns page info (url, title, tabId) and produces an 'elements' array containing all interactive elements on the page. Each element includes semantic properties (id, name, ariaLabel, text, type, placeholder) when available - prefer these for click_element/input_text selectors. Use 'index' only as a last resort when no semantic identifier exists.",
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "A brief explanation of why this tool is being called, what input triggered this action, and what output is expected. This helps with debugging and understanding the agent's decision-making process.",
            },
            param_sources: {
              type: "object",
              description: "Documents where each parameter value comes from. See 'param_sources Expression Format' section above for available expressions (from_llm, string, number, boolean, tool_call, selector, subset, etc.).",
              additionalProperties: { type: "string" }
            },
            url: {
              type: "string",
              description: "The complete URL to navigate to",
            },
          },
          required: ["reason", "param_sources", "url"],
        },
        execute: async (
          args: Record<string, unknown>,
          agentContext: AgentContext
        ): Promise<ToolResult> => {
          return await this.callInnerTool(async () => {
            // Capture state before navigation with timeout protection
            const beforeCapture = await capturePageStateWithTimeout(
              () => this.get_current_page(agentContext),
              () => this.get_all_tabs(agentContext)
            );
            const beforeState = beforeCapture.data;
            
            // Capture DOM state before navigation for domChanges diff
            let beforeDomState: Record<number, DomState> | null = null;
            if (beforeState && !beforeCapture.timedOut) {
              const tabId = beforeState.currentPage.tabId;
              const domCapture = await captureWithTimeout(
                () => this.execute_script(agentContext, capture_dom_state, []) as Promise<DomState>
              );
              if (domCapture.data && tabId !== undefined) {
                beforeDomState = { [tabId]: domCapture.data };
              }
            }
            
            // Navigate to URL with bounded retry on transient failures.
            // Retry policy + failure classification live in ./navigate_retry.ts.
            const { outcome: navResult, attempts } = await navigateWithRetry(
              () => this.navigate_to(agentContext, args.url as string),
              () => this.waitForPageLoad(agentContext, 10000)
            );

            // If the navigation ultimately failed (after retries), short-circuit
            // and return a structured tool result so the agent can recover with
            // go_back / a corrected URL — capturing snapshots against a
            // chrome-error://chromewebdata/ frame fails with
            // "Frame with ID 0 is showing error page" and otherwise kills the workflow.
            if (isNavigationFailure(navResult)) {
              const reason = describeNavigationFailure(navResult);
              const attemptSuffix = attempts > 1 ? ` after ${attempts} attempts` : '';
              const warning = `Navigation to ${args.url} failed${attemptSuffix} (${reason}). The page is likely an error page; do not rely on its DOM. Try a different URL or use go_back.`;
              console.warn('[navigate_to]', warning);
              return buildBrowserToolResult({
                action: 'navigate_to',
                pageStateChange: { type: 'none', details: 'Navigation failed; skipping state capture.', domChanges: {} } as any,
                interactive_elements: [],
                captureTimedOut: true,
                warning,
                extra: {
                  url: navResult.url,
                  title: navResult.title,
                  responseStatus: navResult.responseStatus,
                  responseError: navResult.responseError,
                  navigationFailed: true,
                  attempts,
                },
              });
            }
            
            // Detect page state changes using unified approach
            const stateChangeResult = await detectPageStateChange(
              beforeState,
              beforeDomState, // Include before DOM state for domChanges diff
              () => this.get_current_page(agentContext),
              () => this.get_all_tabs(agentContext),
              (_tabId: number) => this.execute_script(agentContext, capture_dom_state, []) as Promise<DomState>,
              'navigate_to',
              { skipPolling: true, postActionDelay: 300 }
            );
            
            console.log('[navigate_to] State change result:', {
              type: stateChangeResult.pageStateChange.type,
              captureTimedOut: stateChangeResult.captureTimedOut,
              domChanges: stateChangeResult.pageStateChange.domChanges,
              domChangesKeys: Object.keys(stateChangeResult.pageStateChange.domChanges || {})
            });
            
            // Capture elements with timeout protection
            // Add extra delay when a new tab opened to ensure it's fully loaded
            let elements: Array<any> = [];
            let elementCaptureWarning: string | undefined;
            if (!stateChangeResult.captureTimedOut) {
              // Extra delay for new tab scenarios
              if (stateChangeResult.pageStateChange.type === 'new_tab_opened') {
                console.log('[navigate_to] New tab detected, adding extra delay before capturing elements');
                await sleep(500);
              }
              
              const snapshotCapture = await captureWithTimeout(
                () => this.screenshot_and_html(agentContext),
                { timeout: 30000 }  // 30 seconds for complex pages like Wikipedia with 4000+ elements
              );
              
              console.log('[navigate_to] Snapshot capture result:', {
                success: snapshotCapture.success,
                timedOut: snapshotCapture.timedOut,
                hasData: !!snapshotCapture.data,
                hasPseudoHtml: !!snapshotCapture.data?.pseudoHtml,
                error: snapshotCapture.error?.message
              });
              
              if (snapshotCapture.success && snapshotCapture.data) {
                elements = this.parsePseudoHtmlToElements(snapshotCapture.data.pseudoHtml);
                console.log('[navigate_to] Parsed elements count:', elements.length);
              } else if (snapshotCapture.timedOut) {
                elementCaptureWarning = "Timed out while capturing page elements.";
              } else if (snapshotCapture.error) {
                console.warn('[navigate_to] Snapshot capture failed:', snapshotCapture.error.message);
                elementCaptureWarning = `Failed to capture page elements: ${snapshotCapture.error.message}`;
              }
            } else {
              console.log('[navigate_to] Skipping element capture due to timeout');
              elementCaptureWarning = "Skipped element capture due to page state detection timeout.";
            }
            
            return buildBrowserToolResult({
              action: 'navigate_to',
              pageStateChange: stateChangeResult.pageStateChange,
              interactive_elements: elements,
              captureTimedOut: stateChangeResult.captureTimedOut || (elements.length === 0),
              warning: elementCaptureWarning,
              extra: { url: navResult.url, title: navResult.title }
            });
          });
        },
      },
      {
        name: "current_page",
        description:
          "Get the currently active webpage information, return tabId, URL and title",
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "A brief explanation of why this tool is being called, what input triggered this action, and what output is expected. This helps with debugging and understanding the agent's decision-making process.",
            },
            param_sources: {
              type: "object",
              description: "Documents where each parameter value comes from. See 'param_sources Expression Format' section above for available expressions (from_llm, string, number, boolean, tool_call, selector, subset, etc.).",
              additionalProperties: { type: "string" }
            },
          },
          required: ["reason", "param_sources"],
        },
        execute: async (
          args: Record<string, unknown>,
          agentContext: AgentContext
        ): Promise<ToolResult> => {
          return await this.callInnerTool(async () => {
            const result = await this.get_current_page(agentContext);
            return {
              ...result,
              pageStateChange: { type: 'none', details: 'Read-only operation' }
            };
          });
        },
      },
      {
        name: "go_back",
        description: "Go back to the previous page in browser history. Returns page state change information and updated elements.",
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "A brief explanation of why this tool is being called, what input triggered this action, and what output is expected. This helps with debugging and understanding the agent's decision-making process.",
            },
            param_sources: {
              type: "object",
              description: "Documents where each parameter value comes from. See 'param_sources Expression Format' section above for available expressions (from_llm, string, number, boolean, tool_call, selector, subset, etc.).",
              additionalProperties: { type: "string" }
            },
          },
          required: ["reason", "param_sources"],
        },
        execute: async (
          args: Record<string, unknown>,
          agentContext: AgentContext
        ): Promise<ToolResult> => {
          return await this.callInnerTool(async () => {
            // Capture state before going back with timeout protection
            const beforeCapture = await capturePageStateWithTimeout(
              () => this.get_current_page(agentContext),
              () => this.get_all_tabs(agentContext)
            );
            const beforeState = beforeCapture.data;
            
            // Capture DOM state before go_back for domChanges diff
            let beforeDomState: Record<number, DomState> | null = null;
            if (beforeState && !beforeCapture.timedOut) {
              const tabId = beforeState.currentPage.tabId;
              const domCapture = await captureWithTimeout(
                () => this.execute_script(agentContext, capture_dom_state, []) as Promise<DomState>
              );
              if (domCapture.data && tabId !== undefined) {
                beforeDomState = { [tabId]: domCapture.data };
              }
            }
            
            // Execute go_back
            await this.go_back(agentContext);
            
            // Detect page state changes using unified approach
            const stateChangeResult = await detectPageStateChange(
              beforeState,
              beforeDomState, // Include before DOM state for domChanges diff
              () => this.get_current_page(agentContext),
              () => this.get_all_tabs(agentContext),
              (_tabId: number) => this.execute_script(agentContext, capture_dom_state, []) as Promise<DomState>,
              'go_back',
              { skipPolling: true, postActionDelay: 300 }
            );
            
            // Capture new page elements (skip if already timed out)
            let elements: Array<any> | undefined;
            if (!stateChangeResult.captureTimedOut) {
              const snapshotCapture = await captureWithTimeout(async () => {
                await sleep(200);
                return this.screenshot_and_html(agentContext);
              });
              
              if (snapshotCapture.success && snapshotCapture.data) {
                elements = this.parsePseudoHtmlToElements(snapshotCapture.data.pseudoHtml);
              }
            }
            
            return buildBrowserToolResult({
              action: 'go_back',
              pageStateChange: stateChangeResult.pageStateChange,
              interactive_elements: elements ?? [],
              captureTimedOut: stateChangeResult.captureTimedOut
            });
          });
        },
      },
      {
        name: "input_text",
        description: `Inputs text into an element using a flexible selector.

IMPORTANT: Do NOT use this tool for range sliders (input type="range") or slider components.
For sliders, use the drag_element tool instead - input_text will not work on sliders.

SELECTOR PRIORITY (prefer in this order):
1. id - Most reliable, use when element has an id attribute
2. name - For form fields with name attribute
3. ariaLabel - For accessible elements with aria-label
4. title - For elements with title attribute
5. value - For elements with value attribute (buttons, tabs, options)
6. placeholder - For input fields with placeholder text
7. tag + text - For buttons/links with specific text
8. tag + type - For specific input types
9. role - For elements with ARIA roles
10. index - LAST RESORT only when no semantic selector works

CRITICAL - Pseudo HTML to Selector Mapping:
When you see attributes in the pseudo HTML, use the corresponding selector property:
- aria-label="..." in pseudo HTML → use ariaLabel (camelCase) in selector
- title="..." in pseudo HTML → use title in selector
- value="..." in pseudo HTML → use value in selector
- class="..." in pseudo HTML → use class in selector
- role="..." in pseudo HTML → use role in selector
- id="..." in pseudo HTML → use id in selector
- name="..." in pseudo HTML → use name in selector
NEVER use 'title' selector for elements that only have 'aria-label' in pseudo HTML!

Selector properties:
- id: Element's id attribute (PREFERRED)
- name: Element's name attribute (PREFERRED for forms)
- ariaLabel: Element's aria-label attribute (for aria-label="..." in pseudo HTML)
- title: Element's title attribute (for title="..." in pseudo HTML)
- value: Element's value attribute (for buttons, tabs, options with value="...")
- placeholder: Input element's placeholder
- tag: Element tag name (input, textarea, etc.)
- text: Exact text content
- textContains: Partial text match
- type: Input element's type attribute
- role: Element's role attribute
- class: Element's class attribute (partial match supported)
- index: Direct element index (USE AS LAST RESORT)

Example usage (in priority order):
- input_text({selector: {id: "email-input"}, text: "user@example.com"})
- input_text({selector: {name: "username"}, text: "john"})
- input_text({selector: {value: "rules"}, text: "test"}) - for elements with value attribute
- input_text({selector: {placeholder: "Enter email"}, text: "test@test.com"})
- input_text({selector: {index: 5}, text: "fallback"}) - only if no id/name/placeholder available`,
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "A brief explanation of why this tool is being called, what input triggered this action, and what output is expected. This helps with debugging and understanding the agent's decision-making process.",
            },
            param_sources: {
              type: "object",
              description: "Documents where each parameter value comes from. See 'param_sources Expression Format' section above for available expressions (from_llm, string, number, boolean, tool_call, selector, subset, etc.).",
              additionalProperties: { type: "string" }
            },
            selector: {
              oneOf: [
                {
                  type: "number",
                  description: "Direct element index (USE AS LAST RESORT)"
                },
                {
                  type: "object",
                  description: "Element selector object - prefer id, name, ariaLabel over index",
                  properties: {
                    id: { type: "string", description: "Element id attribute (PREFERRED)" },
                    name: { type: "string", description: "Element name attribute (PREFERRED for forms)" },
                    ariaLabel: { type: "string", description: "Element aria-label attribute (use for aria-label='...' in pseudo HTML)" },
                    title: { type: "string", description: "Element title attribute (use for title='...' in pseudo HTML)" },
                    placeholder: { type: "string", description: "Input placeholder attribute" },
                    tag: { type: "string", description: "Element tag name" },
                    text: { type: "string", description: "Exact text content" },
                    textContains: { type: "string", description: "Partial text match" },
                    type: { type: "string", description: "Input type attribute" },
                    role: { type: "string", description: "Element role attribute" },
                    class: { type: "string", description: "Element class attribute (partial match supported)" },
                    value: { type: "string", description: "Element value attribute (for buttons, options, inputs with value)" },
                    index: { type: "number", description: "Direct element index (LAST RESORT)" }
                  }
                }
              ],
              description: "Element selector - prefer id/name/ariaLabel over index"
            },
            text: {
              type: "string",
              description: "The text to input",
            },
            enter: {
              type: "boolean",
              description:
                "When text input is completed, press Enter (applicable to search boxes)",
              default: false,
            },
          },
          required: ["reason", "param_sources", "selector", "text"],
        },
        execute: async (
          args: Record<string, unknown>,
          agentContext: AgentContext
        ): Promise<ToolResult> => {
          const text = args.text as string;
          const selectorInput = args.selector as BrowserSelector;
          const pressEnter = args.enter as boolean;
          
          return await this.callInnerTool(async () => {
            if (selectorInput === undefined) {
              throw new Error("'selector' must be provided");
            }
            
            // Capture state before input (especially if enter will be pressed) with timeout protection
            let beforeState: BeforeState | null = null;
            let beforeDomState: Record<number, DomState> | null = null;
            
            if (pressEnter) {
              const beforeCapture = await capturePageStateWithTimeout(
                () => this.get_current_page(agentContext),
                () => this.get_all_tabs(agentContext)
              );
              beforeState = beforeCapture.data;
              
              if (beforeState && !beforeCapture.timedOut) {
                try {
                  const tabId = beforeState.currentPage.tabId;
                  const domCapture = await captureWithTimeout(
                    () => this.execute_script(agentContext, capture_dom_state, []) as Promise<DomState>
                  );
                  if (domCapture.data && tabId !== undefined) {
                    beforeDomState = { [tabId]: domCapture.data };
                  }
                  console.log('[input_text] Captured beforeState URL:', beforeState.currentPage.url);
                } catch (e) {
                  console.log('[input_text] Error capturing beforeDomState:', e);
                }
              }
            }
            
            const inputResult = await this.input_text(agentContext, selectorInput, text, pressEnter);
            
            // Get the canonical selector from the input result
            const canonicalSelector = inputResult.canonicalSelector;
            
            // Check for state changes if enter was pressed
            let pageStateChange: PageStateChange | undefined;
            let elements: Array<any> | undefined;
            let captureTimedOut = false;
            
            if (pressEnter && beforeState) {
              // Use unified page state detection with polling
              const stateChangeResult = await detectPageStateChange(
                beforeState,
                beforeDomState,
                () => this.get_current_page(agentContext),
                () => this.get_all_tabs(agentContext),
                (_tabId: number) => this.execute_script(agentContext, capture_dom_state, []) as Promise<DomState>,
                'input_text',
                { skipPolling: false, logPrefix: '[input_text]' }
              );
              
              pageStateChange = stateChangeResult.pageStateChange;
              captureTimedOut = stateChangeResult.captureTimedOut;
              
              // Always capture elements after action (unless timed out)
              if (!captureTimedOut) {
                try {
                  await sleep(200);
                  const snapshot = await this.screenshot_and_html(agentContext);
                  elements = this.parsePseudoHtmlToElements(snapshot.pseudoHtml);
                  console.log('[input_text] Captured', elements?.length, 'new elements after state change');
                } catch (e) {
                  console.log('[input_text] Error capturing new elements:', e);
                }
              }
            }
            
            const result: Record<string, any> = {
              selector: selectorInput,
              canonicalSelector,
              textEntered: text,
              pressedEnter: pressEnter || false
            };
            
            // Always include pageStateChange when enter was pressed
            if (pressEnter) {
              const stateChange = pageStateChange || {
                type: 'none' as const,
                details: 'Enter was pressed but no state change was detected.',
                domChanges: {}
              };
              
              return buildBrowserToolResult({
                action: 'input_text',
                pageStateChange: stateChange,
                interactive_elements: elements ?? [],
                captureTimedOut,
                extra: result
              });
            }
            
            return buildBrowserToolResult({
              action: 'input_text',
              interactive_elements: [],
              extra: result
            });
          });
        },
      },
      {
        name: "click_element",
        description: `Click on an element using a flexible selector.

IMPORTANT: Do NOT use this tool for range sliders or slider handles.
For adjusting sliders, use the drag_element tool instead - clicking won't move slider values.

SELECTOR PRIORITY (prefer in this order):
1. id - Most reliable, use when element has an id attribute
2. name - For form elements with name attribute
3. ariaLabel - For accessible elements with aria-label
4. title - For elements with title attribute
5. value - For elements with value attribute (buttons, tabs, options)
6. tag + text - For buttons/links with specific text (e.g., {tag: "button", text: "Submit"})
7. role - For elements with ARIA roles
8. index - LAST RESORT only when no semantic selector works

CRITICAL - Pseudo HTML to Selector Mapping:
When you see attributes in the pseudo HTML, use the corresponding selector property:
- aria-label="..." in pseudo HTML → use ariaLabel (camelCase) in selector
- title="..." in pseudo HTML → use title in selector
- value="..." in pseudo HTML → use value in selector
- class="..." in pseudo HTML → use class in selector
- role="..." in pseudo HTML → use role in selector
- id="..." in pseudo HTML → use id in selector
- name="..." in pseudo HTML → use name in selector
NEVER use 'title' selector for elements that only have 'aria-label' in pseudo HTML!

Selector properties:
- id: Element's id attribute (PREFERRED)
- name: Element's name attribute (PREFERRED)
- ariaLabel: Element's aria-label attribute (for aria-label="..." in pseudo HTML)
- title: Element's title attribute (for title="..." in pseudo HTML)
- value: Element's value attribute (for buttons, tabs, options with value="...")
- tag: Element tag name (button, a, input, etc.)
- text: Exact text content of the element
- textContains: Partial text match
- role: Element's role attribute
- type: Input element's type attribute
- placeholder: Input element's placeholder
- class: Element's class attribute (partial match supported)
- index: Direct element index (USE AS LAST RESORT)

RETURN VALUE - pageStateChange object:
The tool returns a 'pageStateChange' object that indicates what happened after the click:
- type: 'none' | 'new_tab_opened' | 'tab_closed' | 'tab_switched'
- details: Human-readable description of the change
- beforeUrl, afterUrl: URLs before and after the click
- beforeTabCount, afterTabCount: Number of tabs before and after
- newTabId: ID of newly opened tab (when type='new_tab_opened')
- closedTabId: ID of closed tab (when type='tab_closed')
- currentTabId: Current active tab ID after the click
- domChanges: Object with hasChange, addedCount, removedCount, modifiedCount, changedElements (detailed diff info for LLM), and summary. Check this field to detect DOM changes.

IMPORTANT - When URL changes (beforeUrl !== afterUrl) or DOM changes (check domChanges.hasChange):
- The response will include an updated 'elements' array with all interactive elements on the updated page
- You MUST use these new elements for subsequent click_element/input_text operations
- The old elements are no longer valid after navigation or DOM changes
- This is similar to what navigate_to returns

DOM Change Detection (check domChanges field):
- Detects when significant DOM changes occur after the click (new elements, structure changes)
- Useful for Single Page Applications (SPAs) where clicking opens content without URL change
- Triggers when: new elements added, fixed/high-z-index elements appear, body structure changes
- When detected, new 'elements' array is returned with the updated page content

Use pageStateChange to determine next actions:
- If type='new_tab_opened', you may want to switch_tab to the newTabId
- If type='tab_closed', check if you need to switch to another tab
- If beforeUrl !== afterUrl, the URL has changed
- If domChanges.hasChange is true, the page content changed

Example usage (in priority order):
- click_element({selector: {id: "submit-btn"}})
- click_element({selector: {name: "login"}})
- click_element({selector: {ariaLabel: "Close dialog"}})
- click_element({selector: {value: "rules"}}) - for tabs/buttons with value attribute
- click_element({selector: {role: "tab", value: "rules"}}) - combining role and value
- click_element({selector: {tag: "button", text: "Submit"}})
- click_element({selector: {index: 5}}) - only if no id/name/ariaLabel/value available`,
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "A brief explanation of why this tool is being called, what input triggered this action, and what output is expected. This helps with debugging and understanding the agent's decision-making process.",
            },
            param_sources: {
              type: "object",
              description: "Documents where each parameter value comes from. See 'param_sources Expression Format' section above for available expressions (from_llm, string, number, boolean, tool_call, selector, subset, etc.).",
              additionalProperties: { type: "string" }
            },
            selector: {
              oneOf: [
                {
                  type: "number",
                  description: "Direct element index (USE AS LAST RESORT)"
                },
                {
                  type: "object",
                  description: "Element selector object - prefer id, name, ariaLabel over index",
                  properties: {
                    id: { type: "string", description: "Element id attribute (PREFERRED)" },
                    name: { type: "string", description: "Element name attribute (PREFERRED)" },
                    ariaLabel: { type: "string", description: "Element aria-label attribute (use for elements with aria-label='...' in pseudo HTML)" },
                    title: { type: "string", description: "Element title attribute (use for elements with title='...' in pseudo HTML)" },
                    tag: { type: "string", description: "Element tag name (button, a, input, etc.)" },
                    text: { type: "string", description: "Exact text content" },
                    textContains: { type: "string", description: "Partial text match" },
                    role: { type: "string", description: "Element role attribute" },
                    type: { type: "string", description: "Input type attribute" },
                    placeholder: { type: "string", description: "Input placeholder attribute" },
                    class: { type: "string", description: "Element class attribute (can be partial match)" },
                    value: { type: "string", description: "Element value attribute (for buttons, options with value)" },
                    index: { type: "number", description: "Direct element index (LAST RESORT)" }
                  }
                }
              ],
              description: "Element selector - prefer id/name/ariaLabel over index"
            },
            num_clicks: {
              type: "number",
              description: "Number of times to click the element, default 1",
            },
            button: {
              type: "string",
              description: "Mouse button type, default left",
              enum: ["left", "right", "middle"],
            },
          },
          required: ["reason", "param_sources", "selector"],
        },
        execute: async (
          args: Record<string, unknown>,
          agentContext: AgentContext
        ): Promise<ToolResult> => {
          const selectorInput = args.selector as BrowserSelector;
          const numClicks = (args.num_clicks as number) || 1;
          const button = (args.button as string) || 'left';
          
          // Log in extension context for debugging
          console.log('[click_element] Starting click operation', {
            selector: selectorInput,
            num_clicks: numClicks,
            button: button,
          });
          
          return await this.callInnerTool(async () => {
            if (selectorInput === undefined) {
              console.log('[click_element] ERROR: selector is undefined');
              throw new Error("'selector' must be provided");
            }
            
            console.log('[click_element] Capturing page state before click...');
            
            // Capture page state before click with timeout protection
            const beforeCapture = await capturePageStateWithTimeout(
              () => this.get_current_page(agentContext),
              () => this.get_all_tabs(agentContext)
            );
            const beforeState = beforeCapture.data;
            let beforeDomState: Record<number, DomState> | null = null;
            
            if (beforeState) {
              console.log('[click_element] Before state captured', { url: beforeState.currentPage.url, tabCount: beforeState.allTabs.length });
            } else if (beforeCapture.timedOut) {
              console.log('[click_element] Before state capture timed out - dialog may be blocking');
            }
            
            // Capture DOM state for change detection with timeout protection
            if (!beforeCapture.timedOut && beforeState) {
              const tabId = beforeState.currentPage.tabId;
              const domCapture = await captureWithTimeout(
                () => this.execute_script(agentContext, capture_dom_state, []) as Promise<DomState>
              );
              if (domCapture.data && tabId !== undefined) {
                beforeDomState = { [tabId]: domCapture.data };
              }
              if (domCapture.success) {
                console.log('[click_element] Before DOM state captured');
              } else if (domCapture.timedOut) {
                console.log('[click_element] Before DOM state capture timed out');
              }
            }
            
            console.log('[click_element] Executing click via execute_script...');
            
            // Use the protected method which handles selector resolution
            const clickResult = await this.click_element(
              agentContext,
              selectorInput,
              (args.num_clicks || 1) as number,
              (args.button || "left") as any
            );
            
            // Get the canonical selector from the click result
            const canonicalSelector = clickResult.canonicalSelector;
            
            console.log('[click_element] Click executed, checking for navigation...');
            
            // Use unified page state detection with polling
            const stateChangeResult = await detectPageStateChange(
              beforeState,
              beforeDomState,
              () => this.get_current_page(agentContext),
              () => this.get_all_tabs(agentContext),
              (_tabId: number) => this.execute_script(agentContext, capture_dom_state, []) as Promise<DomState>,
              'click_element',
              { skipPolling: false, logPrefix: '[click_element]' }
            );
            
            // Always capture new page elements after click (unless timed out)
            let elements: Array<any> | undefined;
            const pageStateChange = stateChangeResult.pageStateChange;
            
            if (!stateChangeResult.captureTimedOut) {
              try {
                await sleep(200);
                const snapshot = await this.screenshot_and_html(agentContext);
                elements = this.parsePseudoHtmlToElements(snapshot.pseudoHtml);
              } catch (e) {
                // Ignore errors when capturing elements
              }
            }
            
            console.log('[click_element] Click operation completed', {
              success: true,
              selector: selectorInput,
              canonicalSelector,
              pageStateChangeType: pageStateChange.type,
              pageStateChangeDetails: pageStateChange.details,
              newElementsCount: elements?.length || 0,
            });
            
            return buildBrowserToolResult({
              action: 'click_element',
              pageStateChange,
              interactive_elements: elements ?? [],
              captureTimedOut: stateChangeResult.captureTimedOut,
              extra: { selector: selectorInput, canonicalSelector }
            });
          });
        },
      },
      {
        name: "scroll_mouse_wheel",
        description:
          "Scroll the mouse wheel at current position, only scroll when you need to load more content. Returns page state change information if DOM changes are detected (e.g., lazy-loaded content).",
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "A brief explanation of why this tool is being called, what input triggered this action, and what output is expected. This helps with debugging and understanding the agent's decision-making process.",
            },
            param_sources: {
              type: "object",
              description: "Documents where each parameter value comes from. See 'param_sources Expression Format' section above for available expressions (from_llm, string, number, boolean, tool_call, selector, subset, etc.).",
              additionalProperties: { type: "string" }
            },
            amount: {
              type: "number",
              description: "Scroll amount (up / down)",
              minimum: 1,
              maximum: 10,
            },
            direction: {
              type: "string",
              enum: ["up", "down"],
            },
            extract_page_content: {
              type: "boolean",
              default: false,
              description:
                "After scrolling is completed, whether to extract the current latest page content",
            },
          },
          required: ["reason", "param_sources", "amount", "direction", "extract_page_content"],
        },
        execute: async (
          args: Record<string, unknown>,
          agentContext: AgentContext
        ): Promise<ToolResult> => {
          return await this.callInnerTool(async () => {
            const amount = args.amount as number;
            const direction = args.direction as string;
            const extractContent = args.extract_page_content === true;
            
            // Capture state before scroll with timeout protection
            const beforeCapture = await capturePageStateWithTimeout(
              () => this.get_current_page(agentContext),
              () => this.get_all_tabs(agentContext)
            );
            const beforeState = beforeCapture.data;
            let beforeDomState: Record<number, DomState> | null = null;
            
            if (!beforeCapture.timedOut && beforeState) {
              const tabId = beforeState.currentPage.tabId;
              const domCapture = await captureWithTimeout(
                () => this.execute_script(agentContext, capture_dom_state, []) as Promise<DomState>
              );
              if (domCapture.data && tabId !== undefined) {
                beforeDomState = { [tabId]: domCapture.data };
              }
            }
            
            // Execute scroll
            await this.scroll_mouse_wheel(
              agentContext,
              direction === "up" ? -amount : amount,
              extractContent
            );
            
            // Use unified page state detection (skip polling for scroll, just check DOM)
            const stateChangeResult = await detectPageStateChange(
              beforeState,
              beforeDomState,
              () => this.get_current_page(agentContext),
              () => this.get_all_tabs(agentContext),
              (_tabId: number) => this.execute_script(agentContext, capture_dom_state, []) as Promise<DomState>,
              'scroll_mouse_wheel',
              { skipPolling: true, postActionDelay: 300 }
            );
            
            // Always capture elements after scroll (unless timed out)
            let elements: Array<any> | undefined;
            if (!stateChangeResult.captureTimedOut) {
              try {
                await sleep(200);
                const snapshot = await this.screenshot_and_html(agentContext);
                elements = this.parsePseudoHtmlToElements(snapshot.pseudoHtml);
              } catch (e) {
                // Ignore errors when capturing elements
              }
            }
            
            return buildBrowserToolResult({
              action: 'scroll_mouse_wheel',
              pageStateChange: stateChangeResult.pageStateChange,
              interactive_elements: elements ?? [],
              captureTimedOut: stateChangeResult.captureTimedOut,
              extra: { direction, amount }
            });
          });
        },
      },
      {
        name: "hover_to_element",
        description:
          "Hover the mouse over an element using a flexible selector, use it when you need to hover to display more interactive information",
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "A brief explanation of why this tool is being called, what input triggered this action, and what output is expected. This helps with debugging and understanding the agent's decision-making process.",
            },
            param_sources: {
              type: "object",
              description: "Documents where each parameter value comes from. See 'param_sources Expression Format' section above for available expressions (from_llm, string, number, boolean, tool_call, selector, subset, etc.).",
              additionalProperties: { type: "string" }
            },
            selector: {
              oneOf: [
                {
                  type: "number",
                  description: "Direct element index"
                },
                {
                  type: "object",
                  description: "Element selector object",
                  properties: {
                    id: { type: "string", description: "Element id attribute" },
                    name: { type: "string", description: "Element name attribute" },
                    ariaLabel: { type: "string", description: "Element aria-label attribute (use for aria-label='...' in pseudo HTML)" },
                    title: { type: "string", description: "Element title attribute (use for title='...' in pseudo HTML)" },
                    tag: { type: "string", description: "Element tag name" },
                    text: { type: "string", description: "Exact text content" },
                    textContains: { type: "string", description: "Partial text match" },
                    role: { type: "string", description: "Element role attribute" },
                    type: { type: "string", description: "Input type attribute" },
                    placeholder: { type: "string", description: "Input placeholder attribute" },
                    class: { type: "string", description: "Element class attribute (partial match supported)" },
                    index: { type: "number", description: "Direct element index" }
                  }
                }
              ],
              description: "Element selector - can be index or object with semantic properties"
            },
          },
          required: ["reason", "param_sources", "selector"],
        },
        execute: async (
          args: Record<string, unknown>,
          agentContext: AgentContext
        ): Promise<ToolResult> => {
          const selectorInput = args.selector as BrowserSelector;
          
          return await this.callInnerTool(async () => {
            if (selectorInput === undefined) {
              throw new Error("'selector' must be provided");
            }
            
            // Capture state before hover with timeout protection
            const beforeCapture = await capturePageStateWithTimeout(
              () => this.get_current_page(agentContext),
              () => this.get_all_tabs(agentContext)
            );
            const beforeState = beforeCapture.data;
            let beforeDomState: Record<number, DomState> | null = null;
            
            if (!beforeCapture.timedOut && beforeState) {
              const tabId = beforeState.currentPage.tabId;
              const domCapture = await captureWithTimeout(
                () => this.execute_script(agentContext, capture_dom_state, []) as Promise<DomState>
              );
              if (domCapture.data && tabId !== undefined) {
                beforeDomState = { [tabId]: domCapture.data };
              }
            }
            
            // Execute hover
            const hoverResult = await this.hover_to_element(agentContext, selectorInput);
            
            // Get the canonical selector from the hover result
            const canonicalSelector = hoverResult.canonicalSelector;
            
            // Use unified page state detection (skip polling for hover, just check DOM)
            const stateChangeResult = await detectPageStateChange(
              beforeState,
              beforeDomState,
              () => this.get_current_page(agentContext),
              () => this.get_all_tabs(agentContext),
              (_tabId: number) => this.execute_script(agentContext, capture_dom_state, []) as Promise<DomState>,
              'hover_to_element',
              { skipPolling: true, postActionDelay: 300 }
            );
            
            // Always capture elements after hover (unless timed out)
            let elements: Array<any> | undefined;
            if (!stateChangeResult.captureTimedOut) {
              try {
                await sleep(100);
                const snapshot = await this.screenshot_and_html(agentContext);
                elements = this.parsePseudoHtmlToElements(snapshot.pseudoHtml);
              } catch (e) {
                // Ignore errors when capturing elements
              }
            }
            
            return buildBrowserToolResult({
              action: 'hover_to_element',
              pageStateChange: stateChangeResult.pageStateChange,
              interactive_elements: elements ?? [],
              captureTimedOut: stateChangeResult.captureTimedOut,
              extra: { selector: selectorInput, canonicalSelector }
            });
          });
        },
      },
      {
        name: "drag_element",
        description:
          `REQUIRED for range sliders and draggable elements. Do NOT use input_text or click_element for sliders - use this tool instead.

Drag an element by a specified pixel offset. This is the ONLY correct way to interact with:
- Range sliders (input type="range") - for price filters, volume controls, etc.
- Slider handles - any draggable slider knobs or thumbs
- Resizable handles - for resizing panels or elements
- Drag-and-drop elements - for reordering items
- Custom slider components - even if not using native input type="range"

WHEN TO USE THIS TOOL:
- When you see input type="range" in the DOM
- When you see elements with role="slider" or aria-valuenow attributes
- When the task involves adjusting a slider value (price, quantity, rating, etc.)
- When you see slider-related class names or elements with min/max attributes

DO NOT use input_text for sliders - it won't work! Use drag_element instead.

How to calculate offsetX/offsetY:
- For horizontal sliders: Calculate pixel offset based on slider width and desired value change
- Typical slider width is 200-400px. To move slider 50%, use offsetX of ~100-200px
- Positive offsetX = drag right (increase value), Negative = drag left (decrease value)
- Positive offsetY = drag down, Negative = drag up (for vertical sliders)

Returns:
- success: Whether the drag operation completed
- newValue: For input elements, the new value after dragging

Example usage:
- drag_element({selector: {id: "price-slider"}, offsetX: 100, offsetY: 0}) - drag right by 100px
- drag_element({selector: {ariaLabel: "Minimum price"}, offsetX: -50, offsetY: 0}) - drag left by 50px
- drag_element({selector: {type: "range", name: "volume"}, offsetX: 200, offsetY: 0}) - drag slider right
- drag_element({selector: {role: "slider"}, offsetX: 150, offsetY: 0}) - for ARIA slider roles`,
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "A brief explanation of why this tool is being called, what input triggered this action, and what output is expected.",
            },
            param_sources: {
              type: "object",
              description: "Documents where each parameter value comes from.",
              additionalProperties: { type: "string" }
            },
            selector: {
              oneOf: [
                {
                  type: "number",
                  description: "Direct element index"
                },
                {
                  type: "object",
                  description: "Element selector object",
                  properties: {
                    id: { type: "string", description: "Element id attribute" },
                    name: { type: "string", description: "Element name attribute" },
                    ariaLabel: { type: "string", description: "Element aria-label attribute" },
                    title: { type: "string", description: "Element title attribute" },
                    tag: { type: "string", description: "Element tag name" },
                    text: { type: "string", description: "Exact text content" },
                    textContains: { type: "string", description: "Partial text match" },
                    role: { type: "string", description: "Element role attribute" },
                    type: { type: "string", description: "Input type attribute (e.g., 'range')" },
                    placeholder: { type: "string", description: "Input placeholder attribute" },
                    class: { type: "string", description: "Element class attribute" },
                    index: { type: "number", description: "Direct element index" }
                  }
                }
              ],
              description: "Element selector - can be index or object with semantic properties"
            },
            offsetX: {
              type: "number",
              description: "Horizontal drag offset in pixels. Positive = drag right, Negative = drag left.",
            },
            offsetY: {
              type: "number",
              description: "Vertical drag offset in pixels. Positive = drag down, Negative = drag up. Usually 0 for horizontal sliders.",
            },
          },
          required: ["reason", "param_sources", "selector", "offsetX", "offsetY"],
        },
        execute: async (
          args: Record<string, unknown>,
          agentContext: AgentContext
        ): Promise<ToolResult> => {
          const selectorInput = args.selector as BrowserSelector;
          const offsetX = args.offsetX as number;
          const offsetY = args.offsetY as number;
          
          return await this.callInnerTool(async () => {
            if (selectorInput === undefined) {
              throw new Error("'selector' must be provided");
            }
            
            // Capture state before drag with timeout protection
            const beforeCapture = await capturePageStateWithTimeout(
              () => this.get_current_page(agentContext),
              () => this.get_all_tabs(agentContext)
            );
            const beforeState = beforeCapture.data;
            let beforeDomState: Record<number, DomState> | null = null;
            
            if (!beforeCapture.timedOut && beforeState) {
              const tabId = beforeState.currentPage.tabId;
              const domCapture = await captureWithTimeout(
                () => this.execute_script(agentContext, capture_dom_state, []) as Promise<DomState>
              );
              if (domCapture.data && tabId !== undefined) {
                beforeDomState = { [tabId]: domCapture.data };
              }
            }
            
            const result = await this.drag_element(agentContext, selectorInput, offsetX, offsetY);
            
            // Get the canonical selector from the drag result
            const canonicalSelector = result.canonicalSelector;
            
            // Use unified page state detection (skip polling for drag)
            const stateChangeResult = await detectPageStateChange(
              beforeState,
              beforeDomState,
              () => this.get_current_page(agentContext),
              () => this.get_all_tabs(agentContext),
              (_tabId: number) => this.execute_script(agentContext, capture_dom_state, []) as Promise<DomState>,
              'drag_element',
              { skipPolling: true, postActionDelay: 300 }
            );
            
            // Always capture elements after drag (unless timed out)
            let elements: Array<any> | undefined;
            if (!stateChangeResult.captureTimedOut) {
              const snapshotCapture = await captureWithTimeout(async () => {
                await sleep(200);
                return this.screenshot_and_html(agentContext);
              });
              
              if (snapshotCapture.success && snapshotCapture.data) {
                elements = this.parsePseudoHtmlToElements(snapshotCapture.data.pseudoHtml);
              }
            }
            
            return buildBrowserToolResult({
              action: 'drag_element',
              pageStateChange: stateChangeResult.pageStateChange,
              interactive_elements: elements ?? [],
              captureTimedOut: stateChangeResult.captureTimedOut,
              extra: {
                selector: selectorInput,
                canonicalSelector,
                offsetX,
                offsetY,
                newValue: result.newValue,
              }
            });
          });
        },
      },
      {
        name: "extract_page_content",
        description:
          "Extracts all content from the current webpage, including text and image links. Please use this tool when you need to retrieve webpage content.",
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "A brief explanation of why this tool is being called, what input triggered this action, and what output is expected. This helps with debugging and understanding the agent's decision-making process.",
            },
            param_sources: {
              type: "object",
              description: "Documents where each parameter value comes from. See 'param_sources Expression Format' section above for available expressions (from_llm, string, number, boolean, tool_call, selector, subset, etc.).",
              additionalProperties: { type: "string" }
            },
          },
          required: ["reason", "param_sources"],
        },
        execute: async (
          args: Record<string, unknown>,
          agentContext: AgentContext
        ): Promise<ToolResult> => {
          return await this.callInnerTool(async () => {
            const result = await this.extract_page_content(agentContext);
            return {
              ...result,
              pageStateChange: { type: 'none', details: 'Read-only operation' }
            };
          });
        },
      },
      {
        name: "get_select_options",
        description:
          "Get all options from a native dropdown element (<select>).",
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "A brief explanation of why this tool is being called, what input triggered this action, and what output is expected. This helps with debugging and understanding the agent's decision-making process.",
            },
            param_sources: {
              type: "object",
              description: "Documents where each parameter value comes from. See 'param_sources Expression Format' section above for available expressions (from_llm, string, number, boolean, tool_call, selector, subset, etc.).",
              additionalProperties: { type: "string" }
            },
            selector: {
              oneOf: [
                { type: "number", description: "Element index" },
                {
                  type: "object",
                  description: "Semantic element selector",
                  properties: {
                    index: { type: "number", description: "Element index from the elements list" },
                    tag: { type: "string", description: "HTML tag name (e.g., 'select', 'input')" },
                    text: { type: "string", description: "Exact visible text content" },
                    textContains: { type: "string", description: "Partial text match" },
                    ariaLabel: { type: "string", description: "Element aria-label attribute (use for aria-label='...' in pseudo HTML)" },
                    title: { type: "string", description: "Element title attribute (use for title='...' in pseudo HTML)" },
                    role: { type: "string", description: "ARIA role (e.g., 'listbox')" },
                    type: { type: "string", description: "Input type attribute" },
                    placeholder: { type: "string", description: "Placeholder text" },
                    id: { type: "string", description: "Element id attribute" },
                    name: { type: "string", description: "Element name attribute" },
                    class: { type: "string", description: "Element class attribute (partial match supported)" },
                  },
                },
              ],
              description: "Element selector - can be an index (number) or an object with semantic properties to identify the element (id, name, ariaLabel, title, text, textContains, placeholder, tag, role, type, class)",
            },
          },
          required: ["reason", "param_sources", "selector"],
        },
        execute: async (
          args: Record<string, unknown>,
          agentContext: AgentContext
        ): Promise<ToolResult> => {
          return await this.callInnerTool(async () => {
            const result = await this.get_select_options(agentContext, args.selector as number | Record<string, unknown>);
            return {
              ...result,
              pageStateChange: { type: 'none', details: 'Read-only operation' }
            };
          });
        },
      },
      {
        name: "select_option",
        description:
          "Select the native dropdown option, Use this after get_select_options and when you need to select an option from a dropdown.",
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "A brief explanation of why this tool is being called, what input triggered this action, and what output is expected. This helps with debugging and understanding the agent's decision-making process.",
            },
            param_sources: {
              type: "object",
              description: "Documents where each parameter value comes from. See 'param_sources Expression Format' section above for available expressions (from_llm, string, number, boolean, tool_call, selector, subset, etc.).",
              additionalProperties: { type: "string" }
            },
            selector: {
              oneOf: [
                { type: "number", description: "Element index" },
                {
                  type: "object",
                  description: "Semantic element selector",
                  properties: {
                    index: { type: "number", description: "Element index from the elements list" },
                    tag: { type: "string", description: "HTML tag name (e.g., 'select', 'input')" },
                    text: { type: "string", description: "Exact visible text content" },
                    textContains: { type: "string", description: "Partial text match" },
                    ariaLabel: { type: "string", description: "Element aria-label attribute (use for aria-label='...' in pseudo HTML)" },
                    title: { type: "string", description: "Element title attribute (use for title='...' in pseudo HTML)" },
                    role: { type: "string", description: "ARIA role (e.g., 'listbox')" },
                    type: { type: "string", description: "Input type attribute" },
                    placeholder: { type: "string", description: "Placeholder text" },
                    id: { type: "string", description: "Element id attribute" },
                    name: { type: "string", description: "Element name attribute" },
                    class: { type: "string", description: "Element class attribute (partial match supported)" },
                  },
                },
              ],
              description: "Element selector - can be an index (number) or an object with semantic properties to identify the element (id, name, ariaLabel, title, text, textContains, placeholder, tag, role, type, class)",
            },
            option: {
              type: "string",
              description: "Text option",
            },
          },
          required: ["reason", "param_sources", "selector", "option"],
        },
        execute: async (
          args: Record<string, unknown>,
          agentContext: AgentContext
        ): Promise<ToolResult> => {
          const selectorInput = args.selector as BrowserSelector;
          const option = args.option as string;
          
          return await this.callInnerTool(async () => {
            // Capture state before selecting option with timeout protection
            const beforeCapture = await capturePageStateWithTimeout(
              () => this.get_current_page(agentContext),
              () => this.get_all_tabs(agentContext)
            );
            const beforeState = beforeCapture.data;
            let beforeDomState: Record<number, DomState> | null = null;
            
            if (!beforeCapture.timedOut && beforeState) {
              const tabId = beforeState.currentPage.tabId;
              const domCapture = await captureWithTimeout(
                () => this.execute_script(agentContext, capture_dom_state, []) as Promise<DomState>
              );
              if (domCapture.data && tabId !== undefined) {
                beforeDomState = { [tabId]: domCapture.data };
              }
            }
            
            // Execute select_option
            const selectResult = await this.select_option(agentContext, selectorInput, option);
            
            // Get the canonical selector from the select result
            const canonicalSelector = selectResult.canonicalSelector;
            
            // Use unified page state detection (skip polling for select)
            const stateChangeResult = await detectPageStateChange(
              beforeState,
              beforeDomState,
              () => this.get_current_page(agentContext),
              () => this.get_all_tabs(agentContext),
              (_tabId: number) => this.execute_script(agentContext, capture_dom_state, []) as Promise<DomState>,
              'select_option',
              { skipPolling: true, postActionDelay: 300 }
            );
            
            // Always capture elements after select (unless timed out)
            let elements: Array<any> | undefined;
            if (!stateChangeResult.captureTimedOut) {
              const snapshotCapture = await captureWithTimeout(async () => {
                await sleep(200);
                return this.screenshot_and_html(agentContext);
              });
              
              if (snapshotCapture.success && snapshotCapture.data) {
                elements = this.parsePseudoHtmlToElements(snapshotCapture.data.pseudoHtml);
              }
            }
            
            return buildBrowserToolResult({
              action: 'select_option',
              pageStateChange: stateChangeResult.pageStateChange,
              interactive_elements: elements ?? [],
              captureTimedOut: stateChangeResult.captureTimedOut,
              extra: { selector: selectorInput, canonicalSelector, selectedOption: option }
            });
          });
        },
      },
      {
        name: "get_all_tabs",
        description:
          "Get all tabs of the current browser, returns the tabId, URL, and title of all tab pages",
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "A brief explanation of why this tool is being called, what input triggered this action, and what output is expected. This helps with debugging and understanding the agent's decision-making process.",
            },
            param_sources: {
              type: "object",
              description: "Documents where each parameter value comes from. See 'param_sources Expression Format' section above for available expressions (from_llm, string, number, boolean, tool_call, selector, subset, etc.).",
              additionalProperties: { type: "string" }
            },
          },
          required: ["reason", "param_sources"],
        },
        execute: async (
          args: Record<string, unknown>,
          agentContext: AgentContext
        ): Promise<ToolResult> => {
          return await this.callInnerTool(async () => {
            const result = await this.get_all_tabs(agentContext);
            return {
              ...result,
              pageStateChange: { type: 'none', details: 'Read-only operation' }
            };
          });
        },
      },
      {
        name: "switch_tab",
        description: "Switch to the specified tab (based on tabId). Returns page state change information and elements of the new tab.",
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "A brief explanation of why this tool is being called, what input triggered this action, and what output is expected. This helps with debugging and understanding the agent's decision-making process.",
            },
            param_sources: {
              type: "object",
              description: "Documents where each parameter value comes from. See 'param_sources Expression Format' section above for available expressions (from_llm, string, number, boolean, tool_call, selector, subset, etc.).",
              additionalProperties: { type: "string" }
            },
            tabId: {
              type: "number",
              description: "Tab ID, obtained through get_all_tabs",
            },
          },
          required: ["reason", "param_sources", "tabId"],
        },
        execute: async (
          args: Record<string, unknown>,
          agentContext: AgentContext
        ): Promise<ToolResult> => {
          const targetTabId = args.tabId as number;
          
          return await this.callInnerTool(async () => {
            // Capture state before switching with timeout protection
            const beforeCapture = await capturePageStateWithTimeout(
              () => this.get_current_page(agentContext),
              () => this.get_all_tabs(agentContext)
            );
            const beforeState = beforeCapture.data;
            
            // Execute switch_tab
            await this.switch_tab(agentContext, targetTabId);
            
            // Use unified page state detection (skip polling for switch_tab)
            const stateChangeResult = await detectPageStateChange(
              beforeState,
              null, // No DOM state before switch_tab (switching to different tab)
              () => this.get_current_page(agentContext),
              () => this.get_all_tabs(agentContext),
              (_tabId: number) => this.execute_script(agentContext, capture_dom_state, []) as Promise<DomState>,
              'switch_tab',
              { skipPolling: true, postActionDelay: 300 }
            );
            
            // Capture elements of the new tab (skip if timed out)
            let elements: Array<any> | undefined;
            if (!stateChangeResult.captureTimedOut) {
              const snapshotCapture = await captureWithTimeout(async () => {
                await sleep(200);
                return this.screenshot_and_html(agentContext);
              });
              
              if (snapshotCapture.success && snapshotCapture.data) {
                elements = this.parsePseudoHtmlToElements(snapshotCapture.data.pseudoHtml);
              }
            }
            
            return buildBrowserToolResult({
              action: 'switch_tab',
              pageStateChange: stateChangeResult.pageStateChange,
              interactive_elements: elements ?? [],
              captureTimedOut: stateChangeResult.captureTimedOut,
              extra: { targetTabId }
            });
          });
        },
      },
      {
        name: "wait",
        noPlan: true,
        description:
          "Wait/pause execution for a specified duration. Use this tool when you need to wait for data loading, page rendering, or introduce delays between operations.",
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "A brief explanation of why this tool is being called, what input triggered this action, and what output is expected. This helps with debugging and understanding the agent's decision-making process.",
            },
            param_sources: {
              type: "object",
              description: "Documents where each parameter value comes from. See 'param_sources Expression Format' section above for available expressions (from_llm, string, number, boolean, tool_call, selector, subset, etc.).",
              additionalProperties: { type: "string" }
            },
            duration: {
              type: "number",
              description: "Wait duration in milliseconds",
              default: 500,
              minimum: 200,
              maximum: 10000,
            },
          },
          required: ["reason", "param_sources", "duration"],
        },
        execute: async (
          args: Record<string, unknown>,
          agentContext: AgentContext
        ): Promise<ToolResult> => {
          return await this.callInnerTool(async () => {
            await sleep((args.duration || 200) as number);
            return {
              success: true,
              action: 'wait',
              duration: args.duration || 200,
              pageStateChange: { type: 'none', details: 'Wait operation does not change page state' }
            };
          });
        },
      },
    ];
  }

  protected async double_screenshots(
    agentContext: AgentContext,
    messages: LanguageModelV2Prompt,
    tools: Tool[]
  ): Promise<boolean> {
    return config.mode == "expert";
  }

  protected async handleMessages(
    agentContext: AgentContext,
    messages: LanguageModelV2Prompt,
    tools: Tool[]
  ): Promise<void> {
    const pseudoHtmlDescription =
      "This is the environmental information after the operation, including the latest browser screenshot and page elements. Please perform the next operation based on the environmental information. Do not output the following elements and index information in your response.\n\nIndex and elements:\n";
    let lastTool = this.lastToolResult(messages);
    if (
      lastTool &&
      lastTool.toolName !== "extract_page_content" &&
      lastTool.toolName !== "get_all_tabs" &&
      lastTool.toolName !== "variable_storage"
    ) {
      await sleep(300);
      const image_contents: LanguageModelV2FilePart[] = [];
      // Snapshot capture can throw "Frame with ID 0 is showing error page" when
      // the active tab is on chrome-error://chromewebdata/. Failure handling
      // (logging + recovery user-message) lives in ./snapshot_recovery.ts so
      // this hot path stays focused on assembling the next ReAct prompt.
      const snapshot = await tryCaptureSnapshotForHistory(() =>
        this.screenshot_and_html(agentContext)
      );
      if (!snapshot.ok) {
        const failureSnapshot = snapshot as { ok: false; recoveryMessage: LanguageModelV2Prompt[number] };
        messages.push(failureSnapshot.recoveryMessage);
        super.handleMessages(agentContext, messages, tools);
        return;
      }
      const result = snapshot.result;

      if (await this.double_screenshots(agentContext, messages, tools)) {
        const imageResult = result.double_screenshots
          ? result.double_screenshots
          : await this.screenshot_and_compress(
              agentContext,
              result.client_rect
            );
        const image = toImage(imageResult.imageBase64);
        image_contents.push({
          type: "file",
          data: image,
          mediaType: imageResult.imageType,
        });
      }
      if (result.imageBase64) {
        const image = toImage(result.imageBase64);
        image_contents.push({
          type: "file",
          data: image,
          mediaType: result.imageType || "image/png",
        });
      }
      messages.push({
        role: "user",
        content: [
          ...image_contents,
          {
            type: "text",
            text:
              pseudoHtmlDescription + "```html\n" + result.pseudoHtml + "\n```",
          },
        ],
      });
    }
    super.handleMessages(agentContext, messages, tools);
    this.handlePseudoHtmlText(messages, pseudoHtmlDescription);
  }

  private handlePseudoHtmlText(
    messages: LanguageModelV2Prompt,
    pseudoHtmlDescription: string
  ) {
    for (let i = 0; i < messages.length; i++) {
      let message = messages[i];
      if (message.role !== "user" || message.content.length <= 1) {
        continue;
      }
      let content = message.content;
      for (let j = 0; j < content.length; j++) {
        let _content = content[j];
        if (
          _content.type == "text" &&
          _content.text.startsWith(pseudoHtmlDescription)
        ) {
          if (i >= 2 && i < messages.length - 3) {
            _content.text = this.removePseudoHtmlAttr(_content.text, [
              "class",
              "src",
              "href",
            ]);
          }
        }
      }
      if (
        (content[0] as any).text == "[image]" &&
        (content[1] as any).text == "[image]"
      ) {
        content.splice(0, 1);
      }
    }
  }

  private removePseudoHtmlAttr(
    pseudoHtml: string,
    remove_attrs: string[]
  ): string {
    return pseudoHtml
      .split("\n")
      .map((line) => {
        if (!line.startsWith("[") || line.indexOf("]:<") == -1) {
          return line;
        }
        line = line.substring(line.indexOf("]:<") + 2);
        for (let i = 0; i < remove_attrs.length; i++) {
          let sIdx = line.indexOf(remove_attrs[i] + '="');
          if (sIdx == -1) {
            continue;
          }
          let eIdx = line.indexOf('"', sIdx + remove_attrs[i].length + 3);
          if (eIdx == -1) {
            continue;
          }
          line = line.substring(0, sIdx) + line.substring(eIdx + 1).trim();
        }
        return line.replace('" >', '">').replace(" >", ">");
      })
      .join("\n");
  }

  /**
   * Parses pseudo-HTML string into an array of element objects with semantic properties.
   * Format: "[index] <tag attr1='value' attr2='value'>inner text</tag>" or "[index]:<tag ...>"
   */
  protected parsePseudoHtmlToElements(pseudoHtml: string): Array<{
    index: number;
    tag: string;
    text?: string;
    id?: string;
    name?: string;
    ariaLabel?: string;
    role?: string;
    type?: string;
    placeholder?: string;
    href?: string;
  }> {
    const elements: Array<{
      index: number;
      tag: string;
      text?: string;
      id?: string;
      name?: string;
      ariaLabel?: string;
      role?: string;
      type?: string;
      placeholder?: string;
      href?: string;
    }> = [];

    if (!pseudoHtml) return elements;

    const lines = pseudoHtml.split('\n');
    
    for (const line of lines) {
      // Match patterns like "[5] <button ..." or "[5]:<button ..."
      const indexMatch = line.match(/^\[(\d+)\]\s*:?\s*<([a-zA-Z0-9]+)([^>]*)>([^<]*)/);
      if (!indexMatch) continue;

      const index = parseInt(indexMatch[1], 10);
      const tag = indexMatch[2].toLowerCase();
      const attributes = indexMatch[3] || "";
      const innerText = indexMatch[4]?.trim() || "";

      const element: {
        index: number;
        tag: string;
        text?: string;
        id?: string;
        name?: string;
        ariaLabel?: string;
        role?: string;
        type?: string;
        placeholder?: string;
        href?: string;
      } = { index, tag };

      if (innerText) element.text = innerText;

      // Extract common attributes
      const idMatch = attributes.match(/\bid=["']([^"']+)["']/i);
      if (idMatch) element.id = idMatch[1];

      const nameMatch = attributes.match(/\bname=["']([^"']+)["']/i);
      if (nameMatch) element.name = nameMatch[1];

      const ariaMatch = attributes.match(/aria-label=["']([^"']+)["']/i);
      if (ariaMatch) element.ariaLabel = ariaMatch[1];

      const roleMatch = attributes.match(/\brole=["']([^"']+)["']/i);
      if (roleMatch) element.role = roleMatch[1];

      const typeMatch = attributes.match(/\btype=["']([^"']+)["']/i);
      if (typeMatch) element.type = typeMatch[1];

      const placeholderMatch = attributes.match(/placeholder=["']([^"']+)["']/i);
      if (placeholderMatch) element.placeholder = placeholderMatch[1];

      const hrefMatch = attributes.match(/href=["']([^"']+)["']/i);
      if (hrefMatch) element.href = hrefMatch[1];

      elements.push(element);
    }

    return elements;
  }
}

function typing(params: {
  selector: BrowserSelector;
  text: string;
  enter: boolean;
}): { success: boolean; error?: string; canonicalSelector?: any } {
  let { selector, text, enter } = params;
  
  // Use centralized element resolution from window - returns { element, canonicalSelector }
  let resolved: { element: Element; canonicalSelector: any };
  try {
    resolved = (window as any).resolve_element_by_selector(selector);
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  }
  
  if (!resolved || !resolved.element) {
    return { success: false, error: `Element not found for selector: ${JSON.stringify(selector)}` };
  }
  
  const element = resolved.element;
  const canonicalSelector = resolved.canonicalSelector;
  
  let input: any;
  if (element.tagName == "IFRAME") {
    let iframeDoc = (element as any).contentDocument || (element as any).contentWindow.document;
    input =
      iframeDoc.querySelector("textarea") ||
      iframeDoc.querySelector('*[contenteditable="true"]') ||
      iframeDoc.querySelector("input");
  } else if (
    element.tagName == "INPUT" ||
    element.tagName == "TEXTAREA" ||
    element.childElementCount == 0
  ) {
    input = element;
  } else {
    input = element.querySelector("input") || element.querySelector("textarea");
    if (!input) {
      input = element.querySelector('*[contenteditable="true"]') || element;
      if (input.tagName == "DIV" && !input.isContentEditable) {
        input =
          input.querySelector("span") || input.querySelector("div") || input;
      }
    }
  }
  input.focus && input.focus();
  if (!text && enter) {
    ["keydown", "keypress", "keyup"].forEach((eventType) => {
      const event = new KeyboardEvent(eventType, {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(event);
    });
    return { success: true };
  }
  
  // Set the value using the appropriate method based on element type
  if (input.isContentEditable) {
    // For contenteditable elements, use insertText to respect cursor position
    // and avoid overwriting non-editable child elements (e.g. quote blocks)
    input.focus?.();
    const range = document.createRange();
    const sel = window.getSelection();
    range.selectNodeContents(input);
    range.collapse(false);
    sel!.removeAllRanges();
    sel!.addRange(range);
    document.execCommand('insertText', false, text);
  } else if (input.value === undefined) {
    // For other non-input elements without .value
    input.textContent = text;
  } else {
    // For input/textarea elements, we need to use the NATIVE value setter
    // React overrides the value property with its own getter/setter
    // Using input.value = text directly may not work for React controlled inputs
    // We must use the native setter from HTMLInputElement.prototype or HTMLTextAreaElement.prototype
    
    let nativeInputValueSetter: ((v: string) => void) | undefined;
    let nativeTextAreaValueSetter: ((v: string) => void) | undefined;
    
    try {
      nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
    } catch (e) {}
    
    try {
      nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )?.set;
    } catch (e) {}
    
    // Use the appropriate native setter based on element type
    if (input.tagName === "INPUT" && nativeInputValueSetter) {
      nativeInputValueSetter.call(input, text);
    } else if (input.tagName === "TEXTAREA" && nativeTextAreaValueSetter) {
      nativeTextAreaValueSetter.call(input, text);
    } else {
      // Fallback for other elements or if native setter not available
      input.value = text;
      // Also try the prototype setter as backup
      if (input.__proto__) {
        const protoSetter = Object.getOwnPropertyDescriptor(
          input.__proto__ as any,
          "value"
        )?.set;
        protoSetter && protoSetter.call(input, text);
      }
    }
  }
  
  // Dispatch input event - this is crucial for React controlled inputs
  // React listens to the native input event to update its internal state
  input.dispatchEvent(new Event("input", { bubbles: true }));
  
  // For React inputs, we also need to simulate the native input event properly
  // by using InputEvent which carries more information
  try {
    input.dispatchEvent(new InputEvent("input", { 
      bubbles: true, 
      cancelable: true,
      inputType: "insertText",
      data: text 
    }));
  } catch (e) {
    // InputEvent may not be supported in all environments, ignore
  }
  
  input.dispatchEvent(new Event("change", { bubbles: true }));
  
  // NOTE: We intentionally do NOT call input.blur() here immediately
  // Calling blur() right after setting value can cause React controlled inputs
  // to reset their value, because:
  // 1. React's blur handler triggers re-render
  // 2. If React's internal state hasn't been updated yet (async), it resets to old value
  // 
  // Instead, we only dispatch blur/focusout events to notify listeners,
  // but keep actual focus so React has time to process the value change.
  // The actual blur will happen naturally when user clicks elsewhere or presses Tab.
  //
  // If explicit blur is needed, the caller should click elsewhere or use Tab key.
  input.dispatchEvent(new FocusEvent("blur", { bubbles: true, relatedTarget: null }));
  input.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
  
  if (enter) {
    // Track if any event handler called preventDefault
    let defaultPrevented = false;
    
    // WHY SYNTHETIC EVENTS DON'T TRIGGER NAVIGATION:
    // ================================================
    // When a user manually presses Enter, the browser generates a "trusted" event (event.isTrusted = true).
    // Trusted events trigger both JavaScript handlers AND the browser's native default actions
    // (like form submission, link navigation, etc.).
    //
    // However, when we create events via JavaScript (new KeyboardEvent(...)), they are "untrusted"
    // (event.isTrusted = false). Untrusted events:
    //   ✅ DO trigger JavaScript event handlers (React onChange, etc.)
    //   ❌ DO NOT trigger browser native default actions (form submission, navigation)
    //
    // This is intentional for SECURITY - otherwise malicious scripts could simulate user actions
    // to submit forms, click links, or perform other actions without user consent.
    //
    // Therefore, after dispatching synthetic Enter key events, we must MANUALLY trigger form
    // submission if the input is inside a <form> element.
    
    ["keydown", "keypress", "keyup"].forEach((eventType) => {
      const event = new KeyboardEvent(eventType, {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(event);
      if (event.defaultPrevented) {
        defaultPrevented = true;
      }
    });
    
    // If no event handler prevented default, we need to manually trigger form submission
    // because synthetic KeyboardEvents don't trigger the browser's native form submission behavior.
    // This is a known limitation: https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent
    // "Synthetic events don't trigger default actions"
    if (!defaultPrevented) {
      // Find the closest form element
      const form = input.closest('form');
      if (form) {
        // Check if form has a submit button - if so, click it for more realistic behavior
        const submitButton = form.querySelector('button[type="submit"], input[type="submit"]');
        if (submitButton) {
          console.log('[typing] Clicking submit button to trigger form submission');
          (submitButton as HTMLElement).click();
        } else {
          // No submit button found, use requestSubmit() which fires the submit event
          // This allows form validation and submit handlers to run
          console.log('[typing] Triggering form submission via requestSubmit');
          if (typeof form.requestSubmit === 'function') {
            form.requestSubmit();
          } else {
            // Fallback for older browsers: dispatch submit event then call submit()
            const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
            if (form.dispatchEvent(submitEvent)) {
              form.submit();
            }
          }
        }
      }
    }
  }
  
  return { success: true, canonicalSelector };
}

function do_click(params: {
  selector: BrowserSelector;
  button: "left" | "right" | "middle";
  num_clicks: number;
}): { success: boolean; error?: string; canonicalSelector?: any } {
  let { selector, button, num_clicks } = params;
  
  // Use centralized element resolution from window - returns { element, canonicalSelector }
  let resolved: { element: Element; canonicalSelector: any };
  try {
    resolved = (window as any).resolve_element_by_selector(selector);
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  }
  
  if (!resolved || !resolved.element) {
    return { success: false, error: `Element not found for selector: ${JSON.stringify(selector)}` };
  }
  
  const element = resolved.element;
  const canonicalSelector = resolved.canonicalSelector;
  
  // Scroll element into view first to ensure it's visible and clickable
  element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
  
  // Force layout reflow to ensure scroll is complete before getting coordinates
  (element as HTMLElement).offsetHeight;
  
  function simulateMouseEvent(
    eventTypes: Array<string>,
    button: 0 | 1 | 2,
    targetElement: Element
  ): boolean {
    // Debug logging for simulateMouseEvent
    console.log('[simulateMouseEvent] Starting click simulation', {
      eventTypes,
      button: button === 0 ? 'left' : button === 1 ? 'middle' : 'right',
      num_clicks,
      tagName: targetElement.tagName,
      id: targetElement.id || null,
      className: targetElement.className || null,
      ariaLabel: targetElement.getAttribute('aria-label'),
      role: targetElement.getAttribute('role'),
      innerText: (targetElement as HTMLElement).innerText?.substring(0, 100),
      outerHTML: targetElement.outerHTML?.substring(0, 300),
    });
    
    // Force another reflow to ensure layout is stable
    (targetElement as HTMLElement).offsetHeight;
    
    // Get element center coordinates for realistic event simulation
    const rect = targetElement.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const screenX = window.screenX + clientX;
    const screenY = window.screenY + clientY;
    
    console.log('[simulateMouseEvent] Element position', {
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      clientX, clientY, screenX, screenY,
      isInViewport: rect.top >= 0 && rect.left >= 0 && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth,
    });
    
    // Check element type for special handling
    const role = targetElement.getAttribute('role');
    const isMenuItem = role === 'menuitem' || role === 'option' || role === 'listitem';
    const isButton = role === 'button' || targetElement.tagName.toLowerCase() === 'button';
    
    console.log('[simulateMouseEvent] Element classification', { role, isMenuItem, isButton });
    
    // Common event properties
    const eventProps = {
      view: window,
      bubbles: true,
      cancelable: true,
      button,
      buttons: button === 0 ? 1 : (button === 1 ? 4 : 2),
      clientX,
      clientY,
      screenX,
      screenY,
      detail: 1,
    };
    
    const pointerProps = {
      ...eventProps,
      pointerId: 1,
      pointerType: 'mouse' as const,
      isPrimary: true,
    };
    
    // Helper to dispatch full pointer/mouse event sequence
    const dispatchClickSequence = (el: Element) => {
      const elRect = el.getBoundingClientRect();
      const elClientX = elRect.left + elRect.width / 2;
      const elClientY = elRect.top + elRect.height / 2;
      const elScreenX = window.screenX + elClientX;
      const elScreenY = window.screenY + elClientY;
      
      const elEventProps = {
        view: window,
        bubbles: true,
        cancelable: true,
        composed: true, // Allow event to cross shadow DOM boundaries
        button: 0,
        buttons: 1,
        clientX: elClientX,
        clientY: elClientY,
        screenX: elScreenX,
        screenY: elScreenY,
        detail: 1,
      };
      
      const elPointerProps = {
        ...elEventProps,
        pointerId: 1,
        pointerType: 'mouse' as const,
        isPrimary: true,
      };
      
      el.dispatchEvent(new PointerEvent('pointerdown', elPointerProps));
      el.dispatchEvent(new MouseEvent('mousedown', elEventProps));
      el.dispatchEvent(new PointerEvent('pointerup', elPointerProps));
      el.dispatchEvent(new MouseEvent('mouseup', elEventProps));
      el.dispatchEvent(new MouseEvent('click', elEventProps));
    };
    
    // Always dispatch hover events first - triggers lazy-loaded handlers and DOM updates
    // Many modern UIs (React, Gmail Closure, etc.) attach events on hover
    console.log('[simulateMouseEvent] Dispatching hover events (mouseenter, mouseover)');
    (targetElement as any).focus?.();
    targetElement.dispatchEvent(new MouseEvent('mouseenter', {
      view: window, bubbles: false, cancelable: false, clientX, clientY, screenX, screenY,
    }));
    targetElement.dispatchEvent(new MouseEvent('mouseover', {
      view: window, bubbles: true, cancelable: true, clientX, clientY, screenX, screenY,
    }));
    
    // For buttons and menu items with left click, use consolidated click sequence
    if ((isButton || isMenuItem) && button === 0) {
      console.log('[simulateMouseEvent] Using button/menuItem click path', { isButton, isMenuItem, num_clicks });
      for (let n = 0; n < num_clicks; n++) {
        console.log(`[simulateMouseEvent] Click iteration ${n + 1}/${num_clicks}`);
        // First try clicking the target element itself
        console.log('[simulateMouseEvent] Dispatching click sequence on target element');
        dispatchClickSequence(targetElement);
        
        // For buttons: also call native click() as backup (shadow DOM support)
        if (isButton && typeof (targetElement as any).click === 'function') {
          console.log('[simulateMouseEvent] Calling native .click() on button');
          (targetElement as any).click();
        }
        
        // For Fluent UI / React buttons: try clicking child elements as well
        // These frameworks sometimes attach handlers to inner spans/divs
        if (isButton) {
          const children = targetElement.querySelectorAll('span, div, i, svg');
          for (const child of Array.from(children).slice(0, 3)) {
            dispatchClickSequence(child);
            if (typeof (child as any).click === 'function') {
              (child as any).click();
            }
          }
        }
      }
      
      // For buttons: also try keyboard activation (Space/Enter)
      // This is a fallback because some React apps ignore synthetic mouse events (isTrusted=false)
      if (isButton) {
        console.log('[simulateMouseEvent] Trying keyboard activation (Space/Enter) for button');
        (targetElement as any).focus?.();
        const keyboardActivate = (key: string, code: string, keyCode: number) => {
          const props = { view: window, bubbles: true, cancelable: true, key, code, keyCode, which: keyCode };
          targetElement.dispatchEvent(new KeyboardEvent('keydown', props));
          targetElement.dispatchEvent(new KeyboardEvent('keypress', props));
          targetElement.dispatchEvent(new KeyboardEvent('keyup', props));
        };
        // Try both Space and Enter - different frameworks respond to different keys
        keyboardActivate(' ', 'Space', 32);
        keyboardActivate('Enter', 'Enter', 13);
      }
      
      // For menu items: also dispatch Enter key (Gmail Closure library pattern)
      if (isMenuItem) {
        console.log('[simulateMouseEvent] Dispatching Enter key for menu item');
        const keyEventProps = {
          view: window,
          bubbles: true,
          cancelable: true,
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          charCode: 13,
        };
        targetElement.dispatchEvent(new KeyboardEvent('keydown', keyEventProps));
        targetElement.dispatchEvent(new KeyboardEvent('keypress', keyEventProps));
        targetElement.dispatchEvent(new KeyboardEvent('keyup', keyEventProps));
      }
      
      console.log('[simulateMouseEvent] Button/menuItem click path completed successfully');
      return true;
    }
    
    // Generic path for other elements (right click, middle click, non-button elements)
    console.log('[simulateMouseEvent] Using generic click path', { eventTypes, num_clicks });
    for (let n = 0; n < num_clicks; n++) {
      console.log(`[simulateMouseEvent] Generic click iteration ${n + 1}/${num_clicks}`);
      // Dispatch pointer events
      if (eventTypes.includes('mousedown')) {
        console.log('[simulateMouseEvent] Dispatching pointerdown');
        targetElement.dispatchEvent(new PointerEvent('pointerdown', pointerProps));
      }
      if (eventTypes.includes('mouseup')) {
        console.log('[simulateMouseEvent] Dispatching pointerup');
        targetElement.dispatchEvent(new PointerEvent('pointerup', pointerProps));
      }
      
      // Dispatch mouse events
      for (const eventType of eventTypes) {
        console.log(`[simulateMouseEvent] Dispatching ${eventType}`);
        const event = new MouseEvent(eventType, {
          ...eventProps,
          detail: eventType === 'click' ? 1 : 0,
        });

        if (eventType === 'click' && typeof (targetElement as any).click === 'function') {
          console.log('[simulateMouseEvent] Calling native .click()');
          (targetElement as any).click();
        } else {
          targetElement.dispatchEvent(event);
        }
      }
      
      (targetElement as any).focus?.();
    }
    console.log('[simulateMouseEvent] Generic click path completed successfully');
    return true;
  }
  
  let clickSuccess: boolean;
  if (button == "right") {
    clickSuccess = simulateMouseEvent(["mousedown", "mouseup", "contextmenu"], 2, element);
  } else if (button == "middle") {
    clickSuccess = simulateMouseEvent(["mousedown", "mouseup", "click"], 1, element);
  } else {
    clickSuccess = simulateMouseEvent(["mousedown", "mouseup", "click"], 0, element);
  }
  
  return { success: clickSuccess, canonicalSelector };
}


function hover_to(params: { selector: BrowserSelector }): { success: boolean; error?: string; canonicalSelector?: any } {
  const selector = params.selector;
  
  // Debug: Check window state
  const windowState = {
    clickable_elements_exists: typeof (window as any).clickable_elements !== 'undefined',
    clickable_elements_type: typeof (window as any).clickable_elements,
    clickable_elements_keys: (window as any).clickable_elements ? Object.keys((window as any).clickable_elements).length : 0,
    resolve_element_by_selector_exists: typeof (window as any).resolve_element_by_selector === 'function',
  };
  console.log('[hover_to] Window state:', JSON.stringify(windowState));
  
  // Use centralized element resolution from window - returns { element, canonicalSelector }
  try {
    const resolved = (window as any).resolve_element_by_selector(selector);
    
    if (!resolved || !resolved.element) {
      return { success: false, error: `Element not found for selector: ${JSON.stringify(selector)}` };
    }
    
    const element = resolved.element;
    const canonicalSelector = resolved.canonicalSelector;
    
    const event = new MouseEvent("mouseenter", {
      bubbles: true,
      cancelable: true,
      view: window,
    });
    element.dispatchEvent(event);
    
    return { success: true, canonicalSelector };
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  }
}

function scroll_to_element(params: { selector: BrowserSelector }): { success: boolean; error?: string; canonicalSelector?: any } {
  const selector = params.selector;
  
  // Use centralized element resolution from window - returns { element, canonicalSelector }
  try {
    const resolved = (window as any).resolve_element_by_selector(selector);
    
    if (!resolved || !resolved.element) {
      return { success: false, error: `Element not found for selector: ${JSON.stringify(selector)}` };
    }
    
    const element = resolved.element;
    const canonicalSelector = resolved.canonicalSelector;
    element.scrollIntoView({ behavior: "smooth" });
    
    return { success: true, canonicalSelector };
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  }
}

function get_select_options(params: { selector: BrowserSelector }) {
  const selector = params.selector;
  
  // Use centralized element resolution from window - returns { element, canonicalSelector }
  let resolved: { element: any; canonicalSelector: any };
  try {
    resolved = (window as any).resolve_element_by_selector(selector);
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  }
  
  if (!resolved || !resolved.element || resolved.element.tagName.toUpperCase() !== "SELECT") {
    return { success: false, error: "Not a select element" };
  }
  
  const element = resolved.element;
  const canonicalSelector = resolved.canonicalSelector;
  return {
    success: true,
    options: Array.from(element.options).map((opt: any) => ({
      index: opt.index,
      text: opt.text.trim(),
      value: opt.value,
    })),
    name: element.name,
    canonicalSelector,
  };
}

function select_option(params: { selector: BrowserSelector; option: string }) {
  const selector = params.selector;
  
  // Use centralized element resolution from window - returns { element, canonicalSelector }
  let resolved: { element: any; canonicalSelector: any };
  try {
    resolved = (window as any).resolve_element_by_selector(selector);
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  }
  
  if (!resolved || !resolved.element || resolved.element.tagName.toUpperCase() !== "SELECT") {
    return { success: false, error: "Not a select element" };
  }
  
  const element = resolved.element;
  const canonicalSelector = resolved.canonicalSelector;
  
  let text = params.option.trim();
  let option = Array.from(element.options).find(
    (opt: any) => opt.text.trim() === text
  ) as any;
  if (!option) {
    option = Array.from(element.options).find(
      (opt: any) => opt.value.trim() === text
    ) as any;
  }
  if (!option) {
    return {
      success: false,
      error: "Select Option not found",
      availableOptions: Array.from(element.options).map((o: any) =>
        o.text.trim()
      ),
    };
  }
  // Use option.selected = true to properly update selectedIndex
  // This handles cases where multiple options have the same value
  const previousIndex = element.selectedIndex;
  option.selected = true;
  element.dispatchEvent(new Event("change", { bubbles: true }));
  
  return {
    success: true,
    selectedValue: option.value,
    selectedText: option.text.trim(),
    previousIndex: previousIndex,
    newIndex: element.selectedIndex,
    canonicalSelector,
  };
}

function scroll_by(params: { amount: number }) {
  const amount = params.amount;
  const documentElement = document.documentElement || document.body;
  if (documentElement.scrollHeight > window.innerHeight * 1.2) {
    const y = Math.max(
      20,
      Math.min((window.innerHeight || documentElement.clientHeight) / 10, 200)
    );
    window.scrollBy(0, y * amount);
    return;
  }

  function findNodes(element = document, nodes: any = []): Element[] {
    for (const node of Array.from(element.querySelectorAll("*"))) {
      if (node.tagName === "IFRAME" && (node as any).contentDocument) {
        findNodes((node as any).contentDocument, nodes);
      } else {
        nodes.push(node);
      }
    }
    return nodes;
  }

  function findScrollableElements(): Element[] {
    const allElements = findNodes();
    let elements = allElements.filter((el) => {
      const style = window.getComputedStyle(el);
      const overflowY = style.getPropertyValue("overflow-y");
      return (
        (overflowY === "auto" || overflowY === "scroll") &&
        el.scrollHeight > el.clientHeight
      );
    });
    if (elements.length == 0) {
      elements = allElements.filter((el) => {
        const style = window.getComputedStyle(el);
        const overflowY = style.getPropertyValue("overflow-y");
        return (
          overflowY === "auto" ||
          overflowY === "scroll" ||
          el.scrollHeight > el.clientHeight
        );
      });
    }
    return elements;
  }

  function getVisibleArea(element: Element) {
    const rect = element.getBoundingClientRect();
    const viewportHeight = window.innerHeight || documentElement.clientHeight;
    const viewportWidth = window.innerWidth || documentElement.clientWidth;
    const visibleLeft = Math.max(0, Math.min(rect.left, viewportWidth));
    const visibleRight = Math.max(0, Math.min(rect.right, viewportWidth));
    const visibleTop = Math.max(0, Math.min(rect.top, viewportHeight));
    const visibleBottom = Math.max(0, Math.min(rect.bottom, viewportHeight));
    const visibleWidth = visibleRight - visibleLeft;
    const visibleHeight = visibleBottom - visibleTop;
    return visibleWidth * visibleHeight;
  }

  function getComputedZIndex(element: Element | null) {
    while (
      element &&
      element !== document.body &&
      element !== document.body.parentElement
    ) {
      const style = window.getComputedStyle(element);
      let zIndex = style.zIndex === "auto" ? 0 : parseInt(style.zIndex) || 0;
      if (zIndex > 0) {
        return zIndex;
      }
      element = element.parentElement;
    }
    return 0;
  }

  const scrollableElements = findScrollableElements();
  if (scrollableElements.length === 0) {
    const y = Math.max(
      20,
      Math.min((window.innerHeight || documentElement.clientHeight) / 10, 200)
    );
    window.scrollBy(0, y * amount);
    return false;
  }
  const sortedElements = scrollableElements.sort((a, b) => {
    let z = getComputedZIndex(b) - getComputedZIndex(a);
    if (z > 0) {
      return 1;
    } else if (z < 0) {
      return -1;
    }
    let v = getVisibleArea(b) - getVisibleArea(a);
    if (v > 0) {
      return 1;
    } else if (v < 0) {
      return -1;
    }
    return 0;
  });
  const largestElement = sortedElements[0];
  const viewportHeight = largestElement.clientHeight;
  const y = Math.max(20, Math.min(viewportHeight / 10, 200));
  largestElement.scrollBy(0, y * amount);
  const maxHeightElement = sortedElements.sort(
    (a, b) =>
      b.getBoundingClientRect().height - a.getBoundingClientRect().height
  )[0];
  if (maxHeightElement != largestElement) {
    const viewportHeight = maxHeightElement.clientHeight;
    const y = Math.max(20, Math.min(viewportHeight / 10, 200));
    maxHeightElement.scrollBy(0, y * amount);
  }
  return true;
}

/**
 * Drag an element (like a range slider) by a specified offset.
 * Simulates mousedown, mousemove, and mouseup events.
 */
function drag_element(params: {
  selector: BrowserSelector;
  offsetX: number;
  offsetY: number;
}): { success: boolean; error?: string; newValue?: string; canonicalSelector?: any } {
  const { selector, offsetX, offsetY } = params;
  
  // Debug: Check window state
  const windowState = {
    clickable_elements_exists: typeof (window as any).clickable_elements !== 'undefined',
    resolve_element_by_selector_exists: typeof (window as any).resolve_element_by_selector === 'function',
  };
  console.log('[drag_element] Window state:', JSON.stringify(windowState));
  console.log('[drag_element] Params:', JSON.stringify({ selector, offsetX, offsetY }));
  
  // Use centralized element resolution from window - returns { element, canonicalSelector }
  try {
    const resolved = (window as any).resolve_element_by_selector(selector);
    
    if (!resolved || !resolved.element) {
      return { success: false, error: `Element not found for selector: ${JSON.stringify(selector)}` };
    }
    
    const element = resolved.element;
    const canonicalSelector = resolved.canonicalSelector;
    
    const rect = element.getBoundingClientRect();
    const startX = rect.left + rect.width / 2;
    const startY = rect.top + rect.height / 2;
    const endX = startX + offsetX;
    const endY = startY + offsetY;
    
    console.log('[drag_element] Drag coordinates:', { startX, startY, endX, endY, offsetX, offsetY });
    
    // Common event properties
    const createMouseEventProps = (clientX: number, clientY: number) => ({
      view: window,
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY,
      button: 0,
      buttons: 1,
    });
    
    // Focus the element first
    (element as any).focus?.();
    
    // 1. Mousedown at start position
    element.dispatchEvent(new PointerEvent('pointerdown', {
      ...createMouseEventProps(startX, startY),
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    }));
    element.dispatchEvent(new MouseEvent('mousedown', createMouseEventProps(startX, startY)));
    
    // 2. Mousemove to end position (with intermediate steps for smooth drag)
    const steps = 5;
    for (let i = 1; i <= steps; i++) {
      const progress = i / steps;
      const currentX = startX + (endX - startX) * progress;
      const currentY = startY + (endY - startY) * progress;
      
      element.dispatchEvent(new PointerEvent('pointermove', {
        ...createMouseEventProps(currentX, currentY),
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
      }));
      element.dispatchEvent(new MouseEvent('mousemove', createMouseEventProps(currentX, currentY)));
    }
    
    // 3. Mouseup at end position
    element.dispatchEvent(new PointerEvent('pointerup', {
      ...createMouseEventProps(endX, endY),
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    }));
    element.dispatchEvent(new MouseEvent('mouseup', createMouseEventProps(endX, endY)));
    
    // 4. Dispatch input and change events (important for range inputs)
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    
    // Get the new value if it's an input element
    let newValue: string | undefined;
    if (element instanceof HTMLInputElement) {
      newValue = element.value;
    }
    
    console.log('[drag_element] Drag completed successfully', { newValue, canonicalSelector });
    return { success: true, newValue, canonicalSelector };
  } catch (e: any) {
    console.error('[drag_element] Error:', e);
    return { success: false, error: e.message || String(e) };
  }
}

export { BaseBrowserLabelsAgent };
