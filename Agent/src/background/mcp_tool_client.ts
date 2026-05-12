/**
 * MCP Tool Client
 *
 * MCP client that connects to the SDF Tools server and executes tool steps
 * sequentially using browser tools via a ToolExecutor.
 *
 * Architecture:
 * - McpToolClient connects to Tools Server (port 8202) to list available tools
 * - When a tool is called, it gets the execution steps from the server
 * - Each step is then executed using the ToolExecutor (which wraps Chrome extension APIs)
 * - This allows tools to be composed from lower-level browser operations
 */

import { IMcpClient, McpListToolParam, McpListToolResult, McpCallToolParam, ToolResult } from "@eko-ai/eko/types";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { logger } from "../utils/logger";
import { requestHelp } from "./human_interaction";

// Helper to send logs directly to the extension UI (same format as printLog in main.ts)
function sendLogToUI(message: string, level: "info" | "success" | "error" = "info"): void {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.sendMessage({
        type: "log",
        log: message,
        level,
      });
    }
  } catch (e) {
    // Silently fail if UI is not available
  }
}

// ============================================================================
// Types
// ============================================================================

/**
 * Selector type for identifying elements
 */
type BrowserSelector = number | {
  index?: number;
  id?: string;
  name?: string;
  ariaLabel?: string;
  text?: string;
  textContains?: string;
  placeholder?: string;
  tag?: string;
  type?: string;
  role?: string;
  class?: string;
};

/**
 * Condition for optional step execution
 */
interface StepCondition {
  /** Type of condition check */
  type: 'element_visible' | 'element_not_visible' | 'url_contains' | 'custom';
  /** Selector(s) to check for element visibility conditions. Can be single or array (any match). */
  selector?: BrowserSelector | BrowserSelector[];
  /** Pattern to match for URL conditions */
  pattern?: string;
  /** Custom condition expression */
  expression?: string;
}

interface SkillStep {
  tool: string;
  parameters: Record<string, any>;
  reason?: string;
  /** Whether this step is optional (can be skipped if condition is false) */
  optional?: boolean;
  /** Condition for executing this step. Only checked if optional is true. */
  condition?: StepCondition;
}

interface SkillExecution {
  skillName: string;
  steps: SkillStep[];
}

export interface ToolExecutor {
  /**
   * Execute a single browser tool (navigate_to, click_element, input_text, etc.)
   * This should be implemented using Chrome extension APIs.
   */
  executeTool(toolName: string, params: Record<string, any>): Promise<any>;
  
  /**
   * Check if a condition is met for optional step execution.
   * Returns true if the step should be executed, false to skip.
   */
  checkCondition?(condition: StepCondition): Promise<boolean>;
}

// ============================================================================
// Browser Tool Executor
// Executes browser operations directly using Chrome extension APIs
// ============================================================================

export class BrowserToolExecutor implements ToolExecutor {
  private windowId: number | null = null;

  /**
   * Check if a condition is met for optional step execution.
   */
  async checkCondition(condition: StepCondition): Promise<boolean> {
    console.log(`[BrowserToolExecutor] Checking condition:`, condition);
    
    try {
      switch (condition.type) {
        case 'element_visible':
          return await this.checkElementVisible(condition.selector);
        
        case 'element_not_visible':
          return !(await this.checkElementVisible(condition.selector));
        
        case 'url_contains':
          if (condition.pattern) {
            const tabId = await this.getTabId();
            const tab = await chrome.tabs.get(tabId);
            return tab.url?.includes(condition.pattern) ?? false;
          }
          return false;
        
        case 'custom':
          // For custom conditions, we'd need to evaluate the expression
          // For now, default to true (execute the step)
          console.warn('[BrowserToolExecutor] Custom conditions not yet implemented');
          return true;
        
        default:
          return true;
      }
    } catch (error) {
      console.warn('[BrowserToolExecutor] Condition check failed:', error);
      // On error, default to executing the step
      return true;
    }
  }

  /**
   * Check if an element matching the selector is visible on the page.
   */
  private async checkElementVisible(selector?: BrowserSelector | BrowserSelector[]): Promise<boolean> {
    if (!selector) return false;
    
    // If it's an array, check if ANY selector matches
    const selectors = Array.isArray(selector) ? selector : [selector];
    
    for (const sel of selectors) {
      const isVisible = await this.executeScript((selectorParam: BrowserSelector) => {
        // Find element by selector
        let element: Element | null = null;
        
        if (typeof selectorParam === 'number') {
          const elements = document.querySelectorAll('[data-eko-index]');
          element = Array.from(elements).find(el => el.getAttribute('data-eko-index') === String(selectorParam)) || null;
        } else if (typeof selectorParam === 'object') {
          if (selectorParam.id) {
            element = document.getElementById(selectorParam.id);
          } else if (selectorParam.name) {
            element = document.querySelector(`[name="${selectorParam.name}"]`);
          } else if (selectorParam.ariaLabel) {
            element = document.querySelector(`[aria-label="${selectorParam.ariaLabel}"]`);
          } else if (selectorParam.class) {
            element = document.querySelector(`.${selectorParam.class.split(' ').join('.')}`);
          } else if (selectorParam.text) {
            // Search for element containing the text
            const walker = document.createTreeWalker(
              document.body,
              NodeFilter.SHOW_ELEMENT,
              {
                acceptNode: (node) => {
                  const el = node as Element;
                  const textContent = el.textContent || '';
                  const directText = Array.from(el.childNodes)
                    .filter(n => n.nodeType === Node.TEXT_NODE)
                    .map(n => n.textContent)
                    .join('');
                  if (directText.includes(selectorParam.text!) || 
                      (el.children.length === 0 && textContent.includes(selectorParam.text!))) {
                    return NodeFilter.FILTER_ACCEPT;
                  }
                  return NodeFilter.FILTER_SKIP;
                }
              }
            );
            element = walker.nextNode() as Element | null;
          } else if (selectorParam.textContains) {
            // Similar to text but with contains matching
            const allElements = document.querySelectorAll('*');
            const matches = Array.from(allElements).filter(el =>
              el.textContent?.includes(selectorParam.textContains!)
            );
            if (matches.length > 1) {
              throw new Error(
                `Ambiguous selector: ${JSON.stringify(selectorParam)} matched ${matches.length} elements`
              );
            }
            element = matches[0] || null;
          } else if (selectorParam.placeholder) {
            element = document.querySelector(`[placeholder="${selectorParam.placeholder}"]`);
          } else if (selectorParam.tag) {
            element = document.querySelector(selectorParam.tag);
          } else if (selectorParam.role) {
            element = document.querySelector(`[role="${selectorParam.role}"]`);
          } else if (selectorParam.index !== undefined) {
            const elements = document.querySelectorAll('[data-eko-index]');
            element = Array.from(elements).find(el => el.getAttribute('data-eko-index') === String(selectorParam.index)) || null;
          }
        }
        
        if (!element) return false;
        
        // Check if element is visible
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          style.opacity !== '0'
        );
      }, [sel]);
      
      if (isVisible) {
        console.log(`[BrowserToolExecutor] Element visible for selector:`, sel);
        return true;
      }
    }
    
    console.log(`[BrowserToolExecutor] No element visible for selectors:`, selectors);
    return false;
  }

  async executeTool(toolName: string, params: Record<string, any>): Promise<any> {
    console.log(`[BrowserToolExecutor] Executing ${toolName}`, params);
    
    switch (toolName) {
      case 'navigate_to':
        return await this.navigateTo(params.url);
      
      case 'click_element':
        return await this.clickElement(params.selector, params.num_clicks || 1, params.button || 'left');
      
      case 'input_text':
        return await this.inputText(params.selector, params.text, params.enter || false);
      
      case 'wait':
        return await this.wait(params.time || params.duration || 1000);
      
      case 'scroll_mouse_wheel':
        return await this.scrollMouseWheel(params.amount, params.direction);
      
      case 'hover_to_element':
        return await this.hoverToElement(params.selector);
      
      case 'go_back':
        return await this.goBack();
      
      case 'current_page':
        return await this.getCurrentPage();
      
      case 'get_all_tabs':
        return await this.getAllTabs();
      
      case 'switch_tab':
        return await this.switchTab(params.tabId);
      
      case 'extract_page_content':
        return await this.extractPageContent();
      
      case 'human_interact':
        return await this.humanInteract(params.interactType, params.prompt, params.reason);
      
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  private async humanInteract(interactType: string, prompt?: string, reason?: string): Promise<any> {
    // For skill execution, human_interact is used for things like login requests
    // We'll send a message to the UI and wait for the user to complete the action
    console.log(`[BrowserToolExecutor] human_interact: ${interactType}, prompt: ${prompt}, reason: ${reason}`);
    
    // For request_login or request_help, we wait for the user to complete the action
    if (interactType === 'request_login' || interactType === 'request_help') {
      // Determine appropriate message based on interaction type
      const isLogin = interactType === 'request_login';
      const userPrompt = prompt || reason || (isLogin 
        ? 'Please log in manually, then click Done when finished.'
        : 'Please complete the required action, then click Done when finished.');
      
      // Send notification to extension UI so user can see it in the sidebar panel
      sendLogToUI(`🙋 [${isLogin ? 'LOGIN REQUIRED' : 'ACTION REQUIRED'}] ${userPrompt}`, 'info');
      sendLogToUI(`⏳ Waiting for user action in extension panel...`, 'info');
      
      try {
        // Use extension UI instead of blocking website with window.confirm
        const helpType = isLogin ? 'request_login' : 'request_assistance';
        const userConfirmed = await requestHelp(helpType, userPrompt);
        
        console.log(`[BrowserToolExecutor] human_interact user responded: ${userConfirmed}`);
        
        if (userConfirmed) {
          sendLogToUI(`✅ User confirmed action completed`, 'success');
          return { success: true, message: 'User confirmed action completed' };
        } else {
          sendLogToUI(`⏭️ User skipped the action`, 'info');
          return { success: false, message: 'User skipped the action' };
        }
      } catch (e) {
        console.warn('[BrowserToolExecutor] Error in human interaction:', e);
        sendLogToUI(`⚠️ Error during interaction, continuing anyway...`, 'error');
        // Fall back to just continuing
        return { success: true, message: 'Interaction failed, continuing' };
      }
    }
    
    // For other types (confirm, input, select), just log and continue
    return { success: true, interactType, message: 'Interaction acknowledged' };
  }

  private async getWindowId(): Promise<number> {
    if (this.windowId) {
      return this.windowId;
    }
    const window = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (window?.id) {
      this.windowId = window.id;
      return window.id;
    }
    throw new Error('No browser window found');
  }

  private async getTabId(): Promise<number> {
    const windowId = await this.getWindowId();
    let tabs = await chrome.tabs.query({ windowId, active: true, windowType: "normal" });
    if (tabs.length === 0) {
      tabs = await chrome.tabs.query({ windowId, windowType: "normal" });
    }
    if (tabs.length > 0 && tabs[tabs.length - 1].id) {
      return tabs[tabs.length - 1].id!;
    }
    throw new Error('No active tab found');
  }

  private async executeScript<T>(func: (...args: any[]) => T, args: any[] = []): Promise<T> {
    const tabId = await this.getTabId();
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func,
      args,
    });
    return results[0].result as T;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async waitForTabComplete(tabId: number, timeout: number = 8000): Promise<chrome.tabs.Tab> {
    return new Promise(async (resolve) => {
      const timer = setTimeout(async () => {
        chrome.tabs.onUpdated.removeListener(listener);
        const tab = await chrome.tabs.get(tabId);
        resolve(tab);
      }, timeout);
      
      const listener = async (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timer);
          resolve(tab);
        }
      };
      
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') {
        clearTimeout(timer);
        resolve(tab);
        return;
      }
      chrome.tabs.onUpdated.addListener(listener);
    });
  }

  // ==================== Tool Implementations ====================

  private async navigateTo(url: string): Promise<{ url: string; title?: string; tabId?: number }> {
    const windowId = await this.getWindowId();
    const tab = await chrome.tabs.create({ url, windowId });
    const completedTab = await this.waitForTabComplete(tab.id!);
    await this.sleep(200);
    this.windowId = completedTab.windowId ?? this.windowId;
    return {
      url,
      title: completedTab.title,
      tabId: completedTab.id,
    };
  }

  private async clickElement(
    selector: { index?: number; id?: string; name?: string; ariaLabel?: string; tag?: string; text?: string },
    numClicks: number,
    button: 'left' | 'right' | 'middle'
  ): Promise<{ success: boolean }> {
    await this.executeScript((params) => {
      const { selector, num_clicks, button } = params;
      
      // Find element by selector
      let element: Element | null = null;
      
      if (typeof selector === 'number' || selector.index !== undefined) {
        const index = typeof selector === 'number' ? selector : selector.index;
        const elements = document.querySelectorAll('[data-eko-index]');
        element = Array.from(elements).find(el => el.getAttribute('data-eko-index') === String(index)) || null;
      } else if (selector.id) {
        element = document.getElementById(selector.id);
      } else if (selector.name) {
        element = document.querySelector(`[name="${selector.name}"]`);
      } else if (selector.ariaLabel) {
        element = document.querySelector(`[aria-label="${selector.ariaLabel}"]`);
      } else if (selector.tag && selector.text) {
        const elements = document.querySelectorAll(selector.tag);
        const matches = Array.from(elements).filter(el => el.textContent?.includes(selector.text));
        if (matches.length > 1) {
          throw new Error(
            `Ambiguous selector: ${JSON.stringify(selector)} matched ${matches.length} elements`
          );
        }
        element = matches[0] || null;
      }
      
      if (!element) {
        throw new Error(`Element not found for selector: ${JSON.stringify(selector)}`);
      }
      
      // Click the element
      const buttonMap = { left: 0, middle: 1, right: 2 };
      for (let i = 0; i < num_clicks; i++) {
        const event = new MouseEvent('click', {
          view: window,
          bubbles: true,
          cancelable: true,
          button: buttonMap[button],
        });
        element.dispatchEvent(event);
        (element as any).focus?.();
      }
      
      return { success: true };
    }, [{ selector, num_clicks: numClicks, button }]);
    
    return { success: true };
  }

  private async inputText(
    selector: { index?: number; id?: string; name?: string },
    text: string,
    enter: boolean
  ): Promise<{ success: boolean }> {
    await this.executeScript((params) => {
      const { selector, text, enter } = params;
      
      // Find element
      let element: HTMLInputElement | HTMLTextAreaElement | null = null;
      
      if (typeof selector === 'number' || selector.index !== undefined) {
        const index = typeof selector === 'number' ? selector : selector.index;
        const elements = document.querySelectorAll('[data-eko-index]');
        element = Array.from(elements).find(el => el.getAttribute('data-eko-index') === String(index)) as any || null;
      } else if (selector.id) {
        element = document.getElementById(selector.id) as any;
      } else if (selector.name) {
        element = document.querySelector(`[name="${selector.name}"]`) as any;
      }
      
      if (!element) {
        throw new Error(`Element not found for selector: ${JSON.stringify(selector)}`);
      }
      
      // Focus and input text
      element.focus();
      element.value = text;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      
      if (enter) {
        element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        element.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', bubbles: true }));
        element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
      }
      
      return { success: true };
    }, [{ selector, text, enter }]);
    
    if (enter) {
      await this.sleep(200);
    }
    return { success: true };
  }

  private async wait(time: number): Promise<{ success: boolean }> {
    await this.sleep(time);
    return { success: true };
  }

  private async scrollMouseWheel(amount: number, direction: 'up' | 'down'): Promise<{ success: boolean }> {
    await this.executeScript((params) => {
      const scrollAmount = params.direction === 'up' ? -params.amount : params.amount;
      window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
    }, [{ amount, direction }]);
    await this.sleep(200);
    return { success: true };
  }

  private async hoverToElement(
    selector: { index?: number; id?: string; name?: string }
  ): Promise<{ success: boolean }> {
    await this.executeScript((params) => {
      const { selector } = params;
      
      let element: Element | null = null;
      
      if (typeof selector === 'number' || selector.index !== undefined) {
        const index = typeof selector === 'number' ? selector : selector.index;
        const elements = document.querySelectorAll('[data-eko-index]');
        element = Array.from(elements).find(el => el.getAttribute('data-eko-index') === String(index)) || null;
      } else if (selector.id) {
        element = document.getElementById(selector.id);
      } else if (selector.name) {
        element = document.querySelector(`[name="${selector.name}"]`);
      }
      
      if (element) {
        element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      }
    }, [{ selector }]);
    
    return { success: true };
  }

  private async goBack(): Promise<{ success: boolean }> {
    const tabId = await this.getTabId();
    const originalUrl = (await chrome.tabs.get(tabId)).url;
    
    // Perform the back navigation
    await this.executeScript(() => {
      if ((window as any).navigation?.canGoBack) {
        (window as any).navigation.back();
      } else if (window.history.length > 1) {
        window.history.back();
      }
    }, []);
    
    // Wait for navigation with timeout - if a dialog blocks navigation, we detect it and continue
    // We don't auto-dismiss dialogs here to let the user handle them if needed
    const navigationTimeout = 3000; // 3 seconds
    const startTime = Date.now();
    let navigationCompleted = false;
    
    while (Date.now() - startTime < navigationTimeout) {
      await this.sleep(100);
      try {
        const currentTab = await chrome.tabs.get(tabId);
        if (currentTab.url !== originalUrl) {
          navigationCompleted = true;
          break;
        }
      } catch {
        // Tab might be navigating or closed, consider it completed
        navigationCompleted = true;
        break;
      }
    }
    
    if (!navigationCompleted) {
      logger.warning("MCP_TOOL_CLIENT", "go_back navigation may have been blocked by dialog, timing out", {
        originalUrl,
        timeout: navigationTimeout
      });
    }
    
    return { success: true };
  }

  private async getCurrentPage(): Promise<{ url: string; title?: string; tabId?: number }> {
    const tabId = await this.getTabId();
    const tab = await chrome.tabs.get(tabId);
    return {
      url: tab.url || '',
      title: tab.title,
      tabId: tab.id,
    };
  }

  private async getAllTabs(): Promise<Array<{ tabId: number; url: string; title: string }>> {
    const windowId = await this.getWindowId();
    const tabs = await chrome.tabs.query({ windowId });
    return tabs.map(tab => ({
      tabId: tab.id!,
      url: tab.url || '',
      title: tab.title || '',
    }));
  }

  private async switchTab(tabId: number): Promise<{ tabId: number; url: string; title: string }> {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (!tab) {
      throw new Error(`Tab not found: ${tabId}`);
    }
    this.windowId = tab.windowId ?? this.windowId;
    return {
      tabId: tab.id!,
      url: tab.url || '',
      title: tab.title || '',
    };
  }

  private async extractPageContent(): Promise<{ title: string; page_url: string; page_content: string }> {
    const tabId = await this.getTabId();
    const tab = await chrome.tabs.get(tabId);
    
    const content = await this.executeScript(() => {
      return document.body.innerText || '';
    }, []);
    
    return {
      title: tab.title || '',
      page_url: tab.url || '',
      page_content: content.substring(0, 10000),  // Limit content length
    };
  }
}

// ============================================================================
// MCP Tool Client
// ============================================================================

export class McpToolClient implements IMcpClient {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private _isConnected: boolean = false;
  private baseUrl: string;
  private apiKey?: string;
  private executor: ToolExecutor | null = null;
  /** Cached full tool list from the MCP server (fetched once, filtered per-call) */
  private cachedTools: Array<{ name: string; description?: string; inputSchema: any; host?: string; startPage?: string }> | null = null;

  constructor(baseUrl: string, apiKey?: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  /**
   * Set the executor that will run browser operations directly using Chrome APIs
   */
  setExecutor(executor: ToolExecutor): void {
    this.executor = executor;
  }

  private createNewClient(): void {
    const transportOptions: any = {};
    if (this.apiKey) {
      transportOptions.requestInit = {
        headers: {
          'X-API-Key': this.apiKey,
        },
      };
    }
    this.transport = new StreamableHTTPClientTransport(new URL(this.baseUrl), transportOptions);
    this.client = new Client({
      name: "eko-tool-client",
      version: "1.0.0"
    }, {
      capabilities: {}
    });
    this._isConnected = false;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this._isConnected && this.client && this.transport) {
      return;
    }
    
    try {
      if (!this.client || !this.transport) {
        this.createNewClient();
      }
      
      await this.client!.connect(this.transport!);
      this._isConnected = true;
      console.log('[McpToolClient] Connected to MCP Tool Server');
    } catch (error) {
      this._isConnected = false;
      this.client = null;
      this.transport = null;
      throw error;
    }
  }

  async listTools(param: McpListToolParam, signal?: AbortSignal): Promise<McpListToolResult> {
    if (!this._isConnected) {
      await this.connect(signal);
    }
    
    if (!this.client) {
      throw new Error('MCP tool client not initialized');
    }
    
    // Fetch all tools from server once and cache them
    if (!this.cachedTools) {
      const result = await this.client.listTools();
      this.cachedTools = result.tools?.map(tool => {
        // Extract host and startPage from tool annotations or description
        const annotations = (tool as any).annotations;
        const host = annotations?.host;
        const startPage = annotations?.startPage;
        return {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as any,
          host,
          startPage,
        };
      }) || [];
      console.log(`[McpToolClient] Cached ${this.cachedTools.length} tools from MCP server`);
    }
    
    // Filter tools by browser_url if provided
    let tools = this.cachedTools;
    const browserUrl = param?.browser_url;
    if (browserUrl) {
      const scored = this.filterAndScoreToolsByUrl(tools, browserUrl);
      if (scored.length > 0) {
        console.log(`[McpToolClient] Filtered ${tools.length} → ${scored.length} tools for URL: ${browserUrl}`);
        // Sort by relevance: startPage matches first, then host-only matches
        scored.sort((a, b) => b.score - a.score);
        return scored.map(({ tool, score }) => ({
          name: tool.name,
          description: score >= 2
            ? `[Recommended for this page] ${tool.description || ''}`
            : tool.description,
          inputSchema: tool.inputSchema,
        }));
      } else {
        // No tools match this URL — return empty so we don't pollute the LLM
        // with irrelevant tools that can't work on this page
        console.log(`[McpToolClient] No tools match URL: ${browserUrl}, returning empty`);
        return [];
      }
    }
    
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  /**
   * Filter tools by matching the browser URL against tool startPage or host metadata,
   * and assign a relevance score to each matching tool.
   *
   * Scores:
   *   2 = startPage match (precise path-level match — highly relevant)
   *   1 = host-only match (domain-level match — potentially relevant)
   *   0 = no match (excluded from results)
   */
  private filterAndScoreToolsByUrl(
    tools: Array<{ name: string; description?: string; inputSchema: any; host?: string; startPage?: string }>,
    browserUrl: string
  ): Array<{ tool: { name: string; description?: string; inputSchema: any; host?: string; startPage?: string }; score: number }> {
    let browserHost: string;
    let browserUrlLower: string;
    try {
      const parsed = new URL(browserUrl);
      browserHost = parsed.hostname.toLowerCase();
      // Normalize: origin + pathname (strip trailing slash for consistent comparison)
      browserUrlLower = (parsed.origin + parsed.pathname).toLowerCase().replace(/\/+$/, '');
    } catch {
      // Can't parse URL, return all tools with neutral score
      return tools.map(tool => ({ tool, score: 1 }));
    }
    
    const results: Array<{ tool: typeof tools[0]; score: number }> = [];
    
    for (const tool of tools) {
      // 1. If the tool has a startPage, try path-level matching (score=2)
      if (tool.startPage) {
        try {
          const startParsed = new URL(tool.startPage);
          const startHost = startParsed.hostname.toLowerCase();
          const startPath = (startParsed.origin + startParsed.pathname).toLowerCase().replace(/\/+$/, '');
          
          // Host must match (exact or subdomain)
          const hostMatches = browserHost === startHost || browserHost.endsWith('.' + startHost);
          if (hostMatches) {
            // URL path must start with or equal the startPage path
            if (browserUrlLower === startPath || browserUrlLower.startsWith(startPath + '/')) {
              results.push({ tool, score: 2 });
              continue;
            }
          }
          // startPage didn't match — still try host-only fallback below
        } catch {
          // Invalid startPage URL, fall through to host matching
        }
      }
      
      // 2. Fallback: host-only matching (score=1)
      if (tool.host) {
        const toolHost = tool.host.toLowerCase();
        if (browserHost === toolHost || browserHost.endsWith('.' + toolHost)) {
          results.push({ tool, score: 1 });
          continue;
        }
      }
      
      // No match — excluded
    }
    
    return results;
  }

  async callTool(param: McpCallToolParam, signal?: AbortSignal): Promise<ToolResult> {
    if (!this._isConnected) {
      await this.connect(signal);
    }
    
    if (!this.client) {
      throw new Error('MCP tool client not initialized');
    }

    console.log('[McpToolClient] Calling tool:', param.name, param.arguments);
    
    // Call the skill server to get the steps
    const result = await this.client.callTool({
      name: param.name,
      arguments: param.arguments || {}
    });

    // Parse the skill execution from the response
    let skillExecution: SkillExecution | null = null;
    
    if (result && typeof result === 'object' && 'content' in result) {
      const content = (result as any).content;
      if (Array.isArray(content) && content.length > 0) {
        const textContent = content.find((c: any) => c.type === 'text');
        if (textContent?.text) {
          try {
            skillExecution = JSON.parse(textContent.text);
          } catch (e) {
            console.error('[McpToolClient] Failed to parse tool execution:', e);
          }
        }
      }
      
      // Also check _skillExecution field
      if (!skillExecution && (result as any)._skillExecution) {
        skillExecution = (result as any)._skillExecution;
      }
    }

    if (!skillExecution) {
      return {
        content: [{ type: 'text', text: 'Failed to get skill execution steps' }],
        isError: true
      };
    }

    // Execute the skill steps if we have an executor
    if (this.executor) {
      try {
        const stepResults = await this.executeSkillSteps(skillExecution, signal);
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify({
              skillName: skillExecution.skillName,
              stepsExecuted: skillExecution.steps.length,
              results: stepResults
            }, null, 2)
          }],
          isError: false
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Skill execution failed: ${error.message}` }],
          isError: true
        };
      }
    } else {
      // No executor or delegate - just return the steps for the caller to execute
      return {
        content: [{ type: 'text', text: JSON.stringify(skillExecution, null, 2) }],
        isError: false,
        // Include structured data
        _skillExecution: skillExecution
      } as ToolResult & { _skillExecution: SkillExecution };
    }
  }

  /**
   * Execute skill steps sequentially using the executor
   */
  private async executeSkillSteps(
    execution: SkillExecution, 
    signal?: AbortSignal
  ): Promise<any[]> {
    if (!this.executor) {
      throw new Error('No executor set for MCP tool client');
    }

    const skillStartTime = Date.now();
    sendLogToUI(`[SKILL_START] Starting skill: ${execution.skillName} with ${execution.steps.length} steps`);
    logger.info("SKILL_START", `Starting skill: ${execution.skillName} with ${execution.steps.length} steps`, {
      skillName: execution.skillName,
      totalSteps: execution.steps.length
    });
    
    const results: any[] = [];
    
    for (let i = 0; i < execution.steps.length; i++) {
      const step = execution.steps[i];
      const stepStartTime = Date.now();
      const stepNumber = i + 1;
      
      sendLogToUI(`[SKILL_STEP] [${execution.skillName}] Step ${stepNumber}/${execution.steps.length}: ${step.tool}\n${JSON.stringify(step.parameters)}`);
      logger.info("SKILL_STEP_START", `[${execution.skillName}] Step ${stepNumber}/${execution.steps.length}: ${step.tool}`, {
        skillName: execution.skillName,
        step: stepNumber,
        totalSteps: execution.steps.length,
        tool: step.tool,
        parameters: step.parameters,
        reason: step.reason || null,
        optional: step.optional || false
      });
      
      // Check if this is an optional step with a condition
      if (step.optional && step.condition) {
        logger.debug("SKILL_STEP_CONDITION", `[${execution.skillName}] Checking condition for step ${stepNumber}`, {
          skillName: execution.skillName,
          step: stepNumber,
          tool: step.tool,
          condition: step.condition
        });
        
        // Check the condition using the executor
        let shouldExecute = true;
        if (this.executor.checkCondition) {
          shouldExecute = await this.executor.checkCondition(step.condition);
        }
        
        if (!shouldExecute) {
          const skipDuration = Date.now() - stepStartTime;
          logger.info("SKILL_STEP_SKIPPED", `[${execution.skillName}] Step ${stepNumber} skipped - condition not met`, {
            skillName: execution.skillName,
            step: stepNumber,
            tool: step.tool,
            condition: step.condition,
            durationMs: skipDuration
          });
          results.push({
            step: stepNumber,
            tool: step.tool,
            success: true,
            skipped: true,
            reason: 'Condition not met'
          });
          continue;
        }
        logger.debug("SKILL_STEP_CONDITION_MET", `[${execution.skillName}] Step ${stepNumber} condition met, executing...`, {
          skillName: execution.skillName,
          step: stepNumber,
          tool: step.tool
        });
      }
      
      try {
        // Use the executor to run the browser operation directly
        const result = await this.executor.executeTool(step.tool, step.parameters);
        const stepDuration = Date.now() - stepStartTime;
        
        results.push({
          step: stepNumber,
          tool: step.tool,
          success: true,
          result
        });
        
        const resultPreview = typeof result === 'object' ? JSON.stringify(result).substring(0, 200) : String(result).substring(0, 200);
        sendLogToUI(`[SKILL_STEP_DONE] [${execution.skillName}] Step ${stepNumber}/${execution.steps.length} completed: ${step.tool} in ${stepDuration}ms`);
        logger.info("SKILL_STEP_COMPLETE", `[${execution.skillName}] Step ${stepNumber}/${execution.steps.length} completed: ${step.tool} in ${stepDuration}ms`, {
          skillName: execution.skillName,
          step: stepNumber,
          totalSteps: execution.steps.length,
          tool: step.tool,
          success: true,
          durationMs: stepDuration,
          resultPreview
        });
        
        // Check if the result indicates an error
        if (result && typeof result === 'object' && result.isError) {
          logger.error("SKILL_STEP_ERROR", `[${execution.skillName}] Step ${stepNumber} returned error`, {
            skillName: execution.skillName,
            step: stepNumber,
            tool: step.tool,
            error: result,
            durationMs: stepDuration
          });
          throw new Error(`Step ${step.tool} failed: ${JSON.stringify(result)}`);
        }
      } catch (error: any) {
        const stepDuration = Date.now() - stepStartTime;
        sendLogToUI(`[SKILL_STEP_FAILED] [${execution.skillName}] Step ${stepNumber}/${execution.steps.length} failed: ${step.tool} - ${error.message}`, "error");
        logger.error("SKILL_STEP_FAILED", `[${execution.skillName}] Step ${stepNumber}/${execution.steps.length} failed: ${step.tool} - ${error.message}`, {
          skillName: execution.skillName,
          step: stepNumber,
          totalSteps: execution.steps.length,
          tool: step.tool,
          error: error.message,
          durationMs: stepDuration
        });
        results.push({
          step: stepNumber,
          tool: step.tool,
          success: false,
          error: error.message
        });
        // Stop on first error
        throw error;
      }
    }
    
    const totalDuration = Date.now() - skillStartTime;
    sendLogToUI(`[SKILL_COMPLETE] Skill ${execution.skillName} completed: ${results.length} steps in ${totalDuration}ms`, "success");
    logger.info("SKILL_COMPLETE", `Skill ${execution.skillName} completed: ${results.length} steps in ${totalDuration}ms`, {
      skillName: execution.skillName,
      totalSteps: execution.steps.length,
      stepsExecuted: results.length,
      stepsSucceeded: results.filter(r => r.success && !r.skipped).length,
      stepsSkipped: results.filter(r => r.skipped).length,
      totalDurationMs: totalDuration
    });
    
    return results;
  }

  isConnected(): boolean {
    return this._isConnected;
  }

  /** Invalidate the cached tool list (e.g., after server reload) */
  clearToolCache(): void {
    this.cachedTools = null;
  }

  async close(): Promise<void> {
    if (this._isConnected && this.client) {
      await this.client.close();
      this._isConnected = false;
    }
    this.client = null;
    this.transport = null;
    this.cachedTools = null;
  }
}

/**
 * Create an MCP tool client connected to the server
 * @param version Tools version to use (e.g., "v1_2026_3_9")
 */
export function createMcpToolClient(host: string = '128.24.92.146', port: number = 8202, apiKey?: string, version?: string): McpToolClient {
  let url = `http://${host}:${port}/tools`;
  if (version) url += `?version=${encodeURIComponent(version)}`;
  return new McpToolClient(url, apiKey);
}

/**
 * Create an MCP tool client from a full server URL
 * @param serverUrl Full server URL (e.g., "http://localhost:8202" or "https://server.com")
 * @param apiKey Optional API key for authentication (sent as X-API-Key header)
 * @param version Tools version to use (e.g., "v1_2026_3_9")
 */
export function createMcpToolClientFromUrl(serverUrl: string, apiKey?: string, version?: string): McpToolClient {
  let toolsUrl = serverUrl.endsWith('/tools') ? serverUrl : `${serverUrl}/tools`;
  if (version) toolsUrl += `?version=${encodeURIComponent(version)}`;
  return new McpToolClient(toolsUrl, apiKey);
}
