import { JSONSchema7 } from "json-schema";
import { AgentContext } from "../core/context";
import { Tool, ToolResult } from "../types/tools.types";
import { RetryLanguageModel } from "../llm";
import { LLMRequest } from "../types";
import { toImage, sleep } from "../common/utils";

export const TOOL_NAME = "human_interact";

interface PageState {
  currentPage: { url: string; title?: string; tabId?: number };
  allTabs: Array<{ tabId: number; url: string; title: string }>;
}

interface PageStateChange {
  type: 'none' | 'new_tab_opened' | 'tab_closed' | 'tab_switched' | 'capture_timeout';
  details: string;
  beforeUrl?: string;
  afterUrl?: string;
  beforeTabCount?: number;
  afterTabCount?: number;
  newTabId?: number;
  closedTabId?: number;
  currentTabId?: number;
}

export default class HumanInteractTool implements Tool {
  readonly name: string = TOOL_NAME;
  readonly description: string;
  readonly noPlan: boolean = true;
  readonly parameters: JSONSchema7;

  constructor() {
    this.description = `AI interacts with humans:
confirm: Ask the user to confirm whether to execute an operation, especially when performing dangerous actions such as deleting system files, users will choose Yes or No.
input: Prompt the user to enter text; for example, when a task is ambiguous, the AI can choose to ask the user for details, and the user can respond by inputting. IMPORTANT: Do NOT use 'input' for login credentials (email, username, password) - use 'request_help' with helpType 'request_login' instead.
select: Allow the user to make a choice; in situations that require selection, the AI can ask the user to make a decision.
request_help: Request assistance from the user. MANDATORY for ANY authentication/login scenario. You MUST call this tool (not just output text) when you encounter:
  - Login pages (email/username input, password input, sign-in buttons)
  - Passkey or biometric authentication prompts (Windows Hello, fingerprint, face recognition)
  - Multi-factor authentication (MFA/2FA) prompts or security verification dialogs
  - "Choose an account" or account picker screens
  - CAPTCHA verification, SMS verification codes, QR code scanning
  - Payment operations requiring user authorization
  Use helpType='request_login' for authentication scenarios. The user will complete the action and press Enter when done. DO NOT just output text telling the user to complete authentication - you MUST call this tool.
  
  IMPORTANT: When using helpType='request_login', you MUST also provide 'loginTriggerSelector' - the CSS selector or element identifier that indicates login is required (e.g., the login button, login modal, or login form that triggered this request). This selector will be used to determine if login is needed in future executions. Examples:
    - {"id": "login-button"} for a button with id="login-button"
    - {"text": "登录"} for an element containing "登录" text
    - {"selector": ".login-modal"} for a login modal with class "login-modal"
    - {"ariaLabel": "Sign in"} for an element with aria-label="Sign in"`;
    this.parameters = {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "A brief explanation of why this tool is being called, what input triggered this action, and what output is expected. This helps with debugging and understanding the agent's decision-making process. Please provide the target URL before login page appears.",
        },
        param_sources: {
          type: "object",
          description: "Documents where each parameter value comes from. See 'param_sources Expression Format' section above for available expressions (from_llm, string, number, boolean, tool_call, selector, subset, etc.).",
          additionalProperties: { type: "string" }
        },
        interactType: {
          type: "string",
          description: "The type of interaction with users.",
          enum: ["confirm", "input", "select", "request_help"],
        },
        prompt: {
          type: "string",
          description: "Display prompts to users",
        },
        selectOptions: {
          type: "array",
          description:
            "Options provided to users, this parameter is required when interactType is select.",
          items: {
            type: "string",
          },
        },
        selectMultiple: {
          type: "boolean",
          description: "isMultiple, used when interactType is select",
        },
        helpType: {
          type: "string",
          description: "Help type, required when interactType is request_help.",
          enum: ["request_login", "request_assistance"],
        },
        loginTriggerSelector: {
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
                ariaLabel: { type: "string", description: "Element aria-label attribute" },
                tag: { type: "string", description: "Element tag name (button, a, input, etc.)" },
                text: { type: "string", description: "Exact text content" },
                textContains: { type: "string", description: "Partial text match" },
                role: { type: "string", description: "Element role attribute" },
                type: { type: "string", description: "Input type attribute" },
                placeholder: { type: "string", description: "Input placeholder attribute" },
                index: { type: "number", description: "Direct element index (LAST RESORT)" }
              }
            }
          ],
          description: "REQUIRED when helpType is 'request_login'. The selector that identifies the login trigger element (button, modal, form) that indicates login is needed. This is used to conditionally skip login if the user is already logged in. Use the same selector format as click_element/input_text tools. Examples: {\"id\": \"login-btn\"}, {\"text\": \"登录\"}, {\"ariaLabel\": \"Sign in\"}"
        },
      },
      required: ["reason", "param_sources", "interactType", "prompt"],
    };
  }

  async execute(
    args: Record<string, unknown>,
    agentContext: AgentContext
  ): Promise<ToolResult> {
    let interactType = args.interactType as string;
    let callback = agentContext.context.config.callback;
    let resultText = "";
    
    // Capture page state before interaction
    const beforeState = await this.capturePageState(agentContext);
    
    if (callback) {
      switch (interactType) {
        case "confirm":
          if (callback.onHumanConfirm) {
            let result = await callback.onHumanConfirm(
              agentContext,
              args.prompt as string
            );
            resultText = `confirm result: ${result ? "Yes" : "No"}`;
          }
          break;
        case "input":
          if (callback.onHumanInput) {
            let result = await callback.onHumanInput(
              agentContext,
              args.prompt as string
            );
            resultText = `input result: ${result}`;
          }
          break;
        case "select":
          if (callback.onHumanSelect) {
            let result = await callback.onHumanSelect(
              agentContext,
              args.prompt as string,
              (args.selectOptions || []) as string[],
              (args.selectMultiple || false) as boolean
            );
            resultText = `select result: ${JSON.stringify(result)}`;
          }
          break;
        case "request_help":
          if (callback.onHumanHelp) {
            if (
              args.helpType == "request_login" &&
              (await this.checkIsLogined(agentContext))
            ) {
              resultText = "Already logged in";
              break;
            }
            // Pass loginTriggerSelector in extInfo for skill generation
            const extInfo = args.loginTriggerSelector 
              ? { loginTriggerSelector: args.loginTriggerSelector }
              : undefined;
            let result = await callback.onHumanHelp(
              agentContext,
              (args.helpType || "request_assistance") as any,
              args.prompt as string,
              extInfo
            );
            resultText = `request_help result: ${
              result ? "Solved" : "Unresolved"
            }`;
          }
          break;
      }
    }
    
    if (resultText) {
      // Wait briefly for any navigation/page changes to occur
      await sleep(300);
      
      // Capture page state after interaction
      const afterState = await this.capturePageState(agentContext);
      
      // Analyze page state changes
      const pageStateChange = this.analyzePageStateChange(beforeState, afterState);
      
      // Build result object
      const resultObj: Record<string, any> = {
        result: resultText,
        pageStateChange
      };
      
      // If URL changed or new tab opened, capture new page elements
      if ((pageStateChange.beforeUrl !== pageStateChange.afterUrl) || pageStateChange.type === 'new_tab_opened') {
        try {
          // Wait a bit more for the new page to stabilize
          await sleep(200);
          const elements = await this.capturePageElements(agentContext);
          
          if (elements && elements.length > 0) {
            resultObj.interactive_elements = elements;
            resultObj._elementCount = elements.length;
          }
        } catch (e) {
          // Ignore errors when capturing elements
        }
      }
      
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(resultObj),
          },
        ],
      };
    } else {
      return {
        content: [
          {
            type: "text",
            text: `Error: Unsupported ${interactType} interaction operation`,
          },
        ],
        isError: true,
      };
    }
  }

  private async capturePageState(agentContext: AgentContext): Promise<PageState | null> {
    try {
      const agent = agentContext.agent as any;
      const get_current_page = agent["get_current_page"];
      const get_all_tabs = agent["get_all_tabs"];
      
      if (!get_current_page || !get_all_tabs) {
        return null;
      }
      
      const [currentPage, allTabs] = await Promise.all([
        get_current_page.call(agent, agentContext),
        get_all_tabs.call(agent, agentContext)
      ]);
      
      return { currentPage, allTabs };
    } catch (e) {
      return null;
    }
  }

  private analyzePageStateChange(beforeState: PageState | null, afterState: PageState | null): PageStateChange {
    if (!beforeState) {
      return { 
        type: 'none', 
        details: 'Could not compare state - before state was not captured. Check if beforeUrl is undefined.',
        afterUrl: afterState?.currentPage.url,
        afterTabCount: afterState?.allTabs.length,
        currentTabId: afterState?.currentPage.tabId
      };
    }
    
    if (!afterState) {
      return { type: 'none', details: 'Could not capture state after action.' };
    }
    
    const beforeTabCount = beforeState.allTabs.length;
    const afterTabCount = afterState.allTabs.length;
    const beforeUrl = beforeState.currentPage.url;
    const afterUrl = afterState.currentPage.url;
    const beforeTabId = beforeState.currentPage.tabId;
    const afterTabId = afterState.currentPage.tabId;
    
    if (afterTabCount > beforeTabCount) {
      // New tab(s) opened
      const newTabs = afterState.allTabs.filter(
        at => !beforeState.allTabs.some(bt => bt.tabId === at.tabId && bt.url === at.url)
      );
      const newTabId = newTabs.length > 0 ? newTabs[newTabs.length - 1].tabId : afterTabCount - 1;
      return {
        type: 'new_tab_opened',
        details: `New tab opened. Tab count: ${beforeTabCount} -> ${afterTabCount}`,
        beforeUrl,
        afterUrl,
        beforeTabCount,
        afterTabCount,
        newTabId,
        currentTabId: afterTabId
      };
    } else if (afterTabCount < beforeTabCount) {
      // Tab(s) closed
      const closedTabs = beforeState.allTabs.filter(
        bt => !afterState.allTabs.some(at => at.tabId === bt.tabId)
      );
      const closedTabId = closedTabs.length > 0 ? closedTabs[0].tabId : undefined;
      return {
        type: 'tab_closed',
        details: `Tab closed. Tab count: ${beforeTabCount} -> ${afterTabCount}`,
        beforeUrl,
        afterUrl,
        beforeTabCount,
        afterTabCount,
        closedTabId,
        currentTabId: afterTabId
      };
    } else if (beforeTabId !== afterTabId) {
      // Tab switched (same count but different active tab)
      return {
        type: 'tab_switched',
        details: `Active tab switched from ${beforeTabId} to ${afterTabId}`,
        beforeUrl,
        afterUrl,
        beforeTabCount,
        afterTabCount,
        currentTabId: afterTabId
      };
    } else if (beforeUrl !== afterUrl) {
      // URL changed within same tab
      return {
        type: 'none',
        details: `URL changed within same tab. Check beforeUrl/afterUrl for details.`,
        beforeUrl,
        afterUrl,
        beforeTabCount,
        afterTabCount,
        currentTabId: afterTabId
      };
    }
    
    return { type: 'none', details: 'No page state change detected' };
  }

  private async capturePageElements(agentContext: AgentContext): Promise<Array<any> | null> {
    try {
      const agent = agentContext.agent as any;
      const screenshot_and_html = agent["screenshot_and_html"];
      const parsePseudoHtmlToElements = agent["parsePseudoHtmlToElements"];
      
      if (!screenshot_and_html || !parsePseudoHtmlToElements) {
        return null;
      }
      
      const snapshot = await screenshot_and_html.call(agent, agentContext);
      const elements = parsePseudoHtmlToElements.call(agent, snapshot.pseudoHtml);
      
      return elements;
    } catch (e) {
      return null;
    }
  }

  private async checkIsLogined(agentContext: AgentContext) {
    let screenshot = (agentContext.agent as any)["screenshot"];
    if (!screenshot) {
      return false;
    }
    try {
      let imageResult = (await screenshot.call(agentContext.agent, agentContext)) as {
        imageBase64: string;
        imageType: "image/jpeg" | "image/png";
      };
      let rlm = new RetryLanguageModel(
        agentContext.context.config.llms,
        agentContext.agent.Llms
      );
      rlm.setContext(agentContext);
      let image = toImage(imageResult.imageBase64);
      let request: LLMRequest = {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "file",
                data: image,
                mediaType: imageResult.imageType,
              },
              {
                type: "text",
                text: "Check if the current website is logged in. If not logged in, output `NOT_LOGIN`. If logged in, output `LOGGED_IN`. Output directly without explanation.",
              },
            ],
          },
        ],
        abortSignal: agentContext.context.controller.signal,
      };
      let result = await rlm.call(request);
      return result.text && result.text.indexOf("LOGGED_IN") > -1;
    } catch (error) {
      console.error("Error auto checking login status:", error);
      return false;
    }
  }
}

export { HumanInteractTool };
