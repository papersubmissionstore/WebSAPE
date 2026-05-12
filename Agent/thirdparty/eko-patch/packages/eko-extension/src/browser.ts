import { AgentContext, BaseBrowserLabelsAgent } from "@eko-ai/eko";

/**
 * Chrome Debugger CDP Session wrapper.
 * Provides a CDP session interface using chrome.debugger API.
 * Sessions are cached per tab to avoid repeated attach/detach which causes
 * the "started debugging" banner to flash repeatedly.
 */
class ChromeDebuggerCDPSession {
  private tabId: number;
  private attached: boolean = false;
  private static sessions: Map<number, ChromeDebuggerCDPSession> = new Map();
  private static detachListenerInstalled: boolean = false;
  private refCount: number = 0;

  private constructor(tabId: number) {
    this.tabId = tabId;
  }

  /**
   * Get or create a cached session for the given tab.
   * The session stays attached until the tab is closed or navigates away.
   */
  static async getSession(tabId: number): Promise<ChromeDebuggerCDPSession> {
    // Install detach listener once to clean up sessions when debugger is detached
    if (!ChromeDebuggerCDPSession.detachListenerInstalled) {
      chrome.debugger.onDetach.addListener((source, reason) => {
        if (source.tabId) {
          const session = ChromeDebuggerCDPSession.sessions.get(source.tabId);
          if (session) {
            session.attached = false;
            ChromeDebuggerCDPSession.sessions.delete(source.tabId);
          }
        }
      });
      ChromeDebuggerCDPSession.detachListenerInstalled = true;
    }

    let session = ChromeDebuggerCDPSession.sessions.get(tabId);
    if (session && session.attached) {
      session.refCount++;
      return session;
    }

    session = new ChromeDebuggerCDPSession(tabId);
    await session.attach();
    ChromeDebuggerCDPSession.sessions.set(tabId, session);
    session.refCount = 1;
    return session;
  }

  private async attach(): Promise<void> {
    if (this.attached) return;
    
    return new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId: this.tabId }, "1.3", () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          this.attached = true;
          resolve();
        }
      });
    });
  }

  async send(method: string, params?: any): Promise<any> {
    if (!this.attached) {
      await this.attach();
    }

    return new Promise((resolve, reject) => {
      chrome.debugger.sendCommand(
        { tabId: this.tabId },
        method,
        params || {},
        (result) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(result);
          }
        }
      );
    });
  }

  /**
   * Decrement ref count. The session stays attached for reuse.
   * Only actually detaches when forceDetach is called or the tab closes.
   */
  async detach(): Promise<void> {
    this.refCount = Math.max(0, this.refCount - 1);
    // Don't actually detach - keep the session alive for reuse
    // This prevents the "started debugging" banner from flashing
  }

  /**
   * Force detach the session (called when workflow ends or tab closes)
   */
  async forceDetach(): Promise<void> {
    if (!this.attached) return;
    
    return new Promise((resolve) => {
      chrome.debugger.detach({ tabId: this.tabId }, () => {
        this.attached = false;
        ChromeDebuggerCDPSession.sessions.delete(this.tabId);
        resolve();
      });
    });
  }

  /**
   * Detach all cached sessions (call when workflow ends)
   */
  static async detachAll(): Promise<void> {
    const sessions = Array.from(ChromeDebuggerCDPSession.sessions.values());
    for (const session of sessions) {
      await session.forceDetach();
    }
  }

  get isAttached(): boolean {
    return this.attached;
  }
}

export default class BrowserAgent extends BaseBrowserLabelsAgent {
  // Switch to control whether to use CDP for clicks (isTrusted=true)
  // Set to false to fall back to synthetic JavaScript clicks
  private useCDPClick: boolean = true;

  /**
   * External CDP session provider injected by the host application.
   * When set, `getCDPSession` delegates to this instead of using the
   * built-in `ChromeDebuggerCDPSession`.  This allows the host (e.g. the
   * WebSAPE extension) to manage a single shared debugger attachment per
   * tab, avoiding "another debugger is already attached" conflicts.
   */
  private static _cdpProvider:
    | ((tabId: number) => Promise<{ send: (method: string, params?: any) => Promise<any>; detach: () => Promise<void> } | null>)
    | null = null;

  /**
   * Inject a custom CDP session provider.
   *
   * ```ts
   * BrowserAgent.setCdpProvider(async (tabId) => cdpManager.acquire(tabId));
   * ```
   */
  static setCdpProvider(
    provider: (tabId: number) => Promise<{ send: (method: string, params?: any) => Promise<any>; detach: () => Promise<void> } | null>,
  ): void {
    BrowserAgent._cdpProvider = provider;
  }

  /**
   * Get a CDP session for the current tab.
   *
   * If an external provider was registered via `setCdpProvider`, it is used.
   * Otherwise falls back to the built-in `ChromeDebuggerCDPSession`.
   */
  protected async getCDPSession(
    agentContext: AgentContext
  ): Promise<{ send: (method: string, params?: any) => Promise<any>; detach: () => Promise<void> } | null> {
    try {
      const tabId = await this.getTabId(agentContext);
      if (!tabId) {
        console.warn("[getCDPSession] No tab ID available");
        return null;
      }

      // Double-check: refuse to attach CDP to unscriptable tabs
      try {
        const tab = await chrome.tabs.get(tabId);
        if (!BrowserAgent.isScriptableTab(tab)) {
          console.warn(
            `[getCDPSession] Tab ${tabId} has unscriptable URL (${tab.url}), skipping CDP`,
          );
          return null;
        }
      } catch {
        // Tab may already be gone — let the attach call fail naturally below
      }

      // Prefer the external provider when available
      if (BrowserAgent._cdpProvider) {
        return await BrowserAgent._cdpProvider(tabId);
      }

      const session = await ChromeDebuggerCDPSession.getSession(tabId);
      return session;
    } catch (error) {
      console.warn("[getCDPSession] Failed to create CDP session:", error);
      return null;
    }
  }

  /**
   * Override get_current_page to include tabId from chrome.tabs API.
   * The base implementation doesn't return tabId because it's not available from window context.
   */
  protected async get_current_page(agentContext: AgentContext): Promise<{
    url: string;
    title?: string;
    tabId?: number;
  }> {
    // Get the tabId from chrome.tabs API
    const tabId = await this.getTabId(agentContext);
    
    // Get URL and title from the page
    const pageInfo = await this.execute_script(
      agentContext,
      () => {
        return {
          url: (window as any).location.href,
          title: (window as any).document.title,
        };
      },
      []
    );
    
    return {
      ...pageInfo,
      tabId: tabId ?? undefined
    };
  }

  /**
   * Override click_element to use CDP Input.dispatchMouseEvent for trusted clicks.
   * This produces isTrusted=true events that bypass popup blockers for target="_blank" links.
   */
  protected async click_element(
    agentContext: AgentContext,
    selector: any,
    num_clicks: number,
    button: "left" | "right" | "middle"
  ): Promise<{ canonicalSelector?: any }> {
    if (!this.useCDPClick) {
      // Fall back to synthetic JavaScript click
      return await super.click_element(agentContext, selector, num_clicks, button);
    }

    try {
      // Get element coordinates and canonical selector via script execution
      const coords = await this.execute_script(
        agentContext,
        (params: { selector: any }) => {
          const result = (window as any).resolve_element_by_selector(params.selector);
          const element = result?.element || result;
          const canonicalSelector = result?.canonicalSelector;
          if (!element) {
            return { error: `Element not found for selector: ${JSON.stringify(params.selector)}` };
          }
          
          // Scroll element into view
          element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
          
          // Force layout reflow
          (element as HTMLElement).offsetHeight;
          
          // Get element center coordinates
          const rect = element.getBoundingClientRect();
          return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            width: rect.width,
            height: rect.height,
            canonicalSelector
          };
        },
        [{ selector }]
      );

      if (coords.error) {
        throw new Error(coords.error);
      }

      // Get CDP session
      const cdpSession = await this.getCDPSession(agentContext);
      if (!cdpSession) {
        console.warn('[click_element] CDP session not available, falling back to synthetic click');
        return await super.click_element(agentContext, selector, num_clicks, button);
      }

      // Map button to CDP button number
      const cdpButton = button === 'left' ? 'left' : button === 'right' ? 'right' : 'middle';

      // Dispatch mouse events via CDP (these have isTrusted=true)
      for (let i = 0; i < num_clicks; i++) {
        // Mouse pressed
        await cdpSession.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: coords.x,
          y: coords.y,
          button: cdpButton,
          clickCount: i + 1,
        });

        // Mouse released
        await cdpSession.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: coords.x,
          y: coords.y,
          button: cdpButton,
          clickCount: i + 1,
        });
      }

      // Wait a bit for the click to be processed
      await this.sleep(100);

      // Check if a new tab was opened (for target="_blank" links)
      // and switch to it if so
      await this.handlePotentialNewTab(agentContext);
      
      // Return the canonical selector from the element resolution
      return { canonicalSelector: coords.canonicalSelector };

    } catch (error) {
      console.warn('[click_element] CDP click failed, falling back to synthetic click:', error);
      return await super.click_element(agentContext, selector, num_clicks, button);
    }
  }

  /**
   * Check if a new tab was opened after a click and switch to it.
   * This handles target="_blank" links that open in new tabs.
   */
  private async handlePotentialNewTab(agentContext: AgentContext): Promise<void> {
    try {
      const windowId = await this.getWindowId(agentContext);
      const tabs = await chrome.tabs.query({ windowId, active: true });
      
      // The active tab might have changed if a new tab was opened
      if (tabs.length > 0) {
        const currentTabId = await this.getTabId(agentContext);
        const activeTab = tabs[0];
        
        if (activeTab.id && activeTab.id !== currentTabId) {
          console.log('[click_element] New tab detected, updating context');
          // The browser already switched to the new tab, just update tracking
          let navigateTabIds = agentContext.variables.get("navigateTabIds") || [];
          navigateTabIds.push(activeTab.id);
          agentContext.variables.set("navigateTabIds", navigateTabIds);
        }
      }
    } catch (e) {
      // Ignore errors in new tab detection
    }
  }

  /**
   * Override hover_to_element to use CDP Input.dispatchMouseEvent (mouseMoved)
   * for a real pointer move. This is the only way to trigger the browser's
   * CSS `:hover` pseudo-class — synthetic `mouseenter`/`mouseover` events do
   * not update the hover flag (they only fire JS listeners). Required for
   * CSS-only hover UIs such as Teams-style message action bars.
   */
  protected async hover_to_element(
    agentContext: AgentContext,
    selector: any
  ): Promise<{ canonicalSelector?: any }> {
    if (!this.useCDPClick) {
      // Fall back to synthetic JavaScript hover (shares the click toggle)
      return await super.hover_to_element(agentContext, selector);
    }

    try {
      // Resolve element, scroll into view, and get center coords + canonical selector
      const coords = await this.execute_script(
        agentContext,
        (params: { selector: any }) => {
          const result = (window as any).resolve_element_by_selector(params.selector);
          const element = result?.element || result;
          const canonicalSelector = result?.canonicalSelector;
          if (!element) {
            return { error: `Element not found for selector: ${JSON.stringify(params.selector)}` };
          }

          element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
          (element as HTMLElement).offsetHeight; // force reflow

          const rect = element.getBoundingClientRect();
          return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            width: rect.width,
            height: rect.height,
            canonicalSelector,
          };
        },
        [{ selector }]
      );

      if (coords.error) {
        throw new Error(coords.error);
      }

      const cdpSession = await this.getCDPSession(agentContext);
      if (!cdpSession) {
        console.warn('[hover_to_element] CDP session not available, falling back to synthetic hover');
        return await super.hover_to_element(agentContext, selector);
      }

      // First move the pointer off the element to ensure a hover transition
      // fires even if the pointer was already inside the element's rect.
      await cdpSession.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: 0,
        y: 0,
        button: 'none',
        buttons: 0,
      });

      // Now move the real pointer to the element center. This updates the
      // user-agent hover chain and triggers CSS :hover.
      await cdpSession.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: coords.x,
        y: coords.y,
        button: 'none',
        buttons: 0,
      });

      // Give hover-dependent DOM updates a chance to render before we capture
      // the post-action snapshot in the tool wrapper.
      await this.sleep(150);

      return { canonicalSelector: coords.canonicalSelector };
    } catch (error) {
      console.warn('[hover_to_element] CDP hover failed, falling back to synthetic hover:', error);
      return await super.hover_to_element(agentContext, selector);
    }
  }

  protected async screenshot(
    agentContext: AgentContext
  ): Promise<{ imageBase64: string; imageType: "image/jpeg" | "image/png" }> {
    const windowId = await this.getWindowId(agentContext);
    
    // Try captureVisibleTab with retries and exponential backoff
    const maxRetries = 3;
    const delays = [500, 1000, 2000]; // Exponential backoff
    let lastError: any;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
          format: "jpeg",
          quality: 60,
        });
        const data = dataUrl.substring(dataUrl.indexOf("base64,") + 7);
        return {
          imageBase64: data,
          imageType: "image/jpeg",
        };
      } catch (e) {
        lastError = e;
        console.warn(`[screenshot] captureVisibleTab attempt ${attempt + 1} failed:`, e);
        
        if (attempt < maxRetries - 1) {
          await this.sleep(delays[attempt]);
        }
      }
    }
    
    // Fallback: Try using CDP Page.captureScreenshot which is more reliable
    // for hardware acceleration issues ("image readback failed")
    console.log('[screenshot] Falling back to CDP screenshot after captureVisibleTab failures');
    try {
      const cdpSession = await this.getCDPSession(agentContext);
      if (cdpSession) {
        const result = await cdpSession.send('Page.captureScreenshot', {
          format: 'jpeg',
          quality: 60,
        });
        if (result && result.data) {
          console.log('[screenshot] CDP screenshot succeeded');
          return {
            imageBase64: result.data,
            imageType: "image/jpeg",
          };
        }
      }
    } catch (cdpError) {
      console.warn('[screenshot] CDP fallback also failed:', cdpError);
    }
    
    // If all methods fail, throw a descriptive error
    const errorMessage = lastError?.message || String(lastError);
    throw new Error(`Failed to capture tab: ${errorMessage}. This may be due to GPU/hardware acceleration issues, the tab being minimized, or protected content.`);
  }

  protected async navigate_to(
    agentContext: AgentContext,
    url: string
  ): Promise<{
    url: string;
    title?: string;
    tabId?: number;
    responseStatus?: number;
    responseError?: string;
  }> {
    let windowId = await this.getWindowId(agentContext);

    // Capture the main-frame navigation outcome via chrome.webRequest so the
    // caller (browser_labels.navigate_to) can detect HTTP errors / network
    // failures (e.g. ERR_CONNECTION_REFUSED) before attempting any DOM /
    // snapshot capture against a chrome-error://chromewebdata/ frame.
    let capturedStatus: number | undefined;
    let capturedError: string | undefined;
    let capturedTabId: number | undefined;

    const matchEvent = (details: { tabId: number; type: string; url: string }) => {
      if (details.type !== "main_frame") return false;
      if (capturedTabId !== undefined) {
        return details.tabId === capturedTabId;
      }
      // Before we know tabId, fall back to URL match on the requested URL.
      return details.url === url;
    };

    const completedListener = (
      details: chrome.webRequest.WebResponseCacheDetails
    ) => {
      if (matchEvent(details)) {
        capturedStatus = details.statusCode;
      }
    };
    const errorListener = (
      details: chrome.webRequest.WebResponseErrorDetails
    ) => {
      if (matchEvent(details)) {
        capturedError = details.error;
      }
    };

    const hasWebRequest =
      typeof chrome !== "undefined" && !!(chrome as any).webRequest;
    if (hasWebRequest) {
      try {
        chrome.webRequest.onCompleted.addListener(completedListener, {
          urls: ["<all_urls>"],
          types: ["main_frame"],
        });
        chrome.webRequest.onErrorOccurred.addListener(errorListener, {
          urls: ["<all_urls>"],
          types: ["main_frame"],
        });
      } catch (e) {
        // webRequest unavailable (permission missing) - silently skip.
      }
    }

    try {
      let tab = await chrome.tabs.create({
        url: url,
        windowId: windowId,
      });
      capturedTabId = tab.id;
      tab = await this.waitForTabComplete(tab.id);
      await this.sleep(200);
      agentContext.variables.set("windowId", tab.windowId);
      let navigateTabIds = agentContext.variables.get("navigateTabIds") || [];
      navigateTabIds.push(tab.id);
      agentContext.variables.set("navigateTabIds", navigateTabIds);
      return {
        url: url,
        title: tab.title,
        tabId: tab.id,
        responseStatus: capturedStatus,
        responseError: capturedError,
      };
    } finally {
      if (hasWebRequest) {
        try {
          chrome.webRequest.onCompleted.removeListener(completedListener);
          chrome.webRequest.onErrorOccurred.removeListener(errorListener);
        } catch {
          // ignore
        }
      }
    }
  }

  protected async get_all_tabs(
    agentContext: AgentContext
  ): Promise<Array<{ tabId: number; url: string; title: string }>> {
    let windowId = await this.getWindowId(agentContext);
    let tabs = await chrome.tabs.query({
      windowId: windowId,
    });
    let result: Array<{ tabId: number; url: string; title: string }> = [];
    for (let i = 0; i < tabs.length; i++) {
      let tab = tabs[i];
      result.push({
        tabId: tab.id,
        url: tab.url,
        title: tab.title,
      });
    }
    return result;
  }

  protected async switch_tab(
    agentContext: AgentContext,
    tabId: number
  ): Promise<{ tabId: number; url: string; title: string }> {
    let tab = await chrome.tabs.update(tabId, { active: true });
    if (!tab) {
      throw new Error("tabId does not exist: " + tabId);
    }
    agentContext.variables.set("windowId", tab.windowId);
    return {
      tabId: tab.id,
      url: tab.url,
      title: tab.title,
    };
  }

  protected async go_back(agentContext: AgentContext): Promise<any> {
    try {
      let canGoBack = await this.execute_script(
        agentContext,
        () => {
          return (window as any).navigation.canGoBack;
        },
        []
      );
      if (canGoBack + "" == "true") {
        await this.execute_script(
          agentContext,
          () => {
            (window as any).navigation.back();
          },
          []
        );
        await this.sleep(100);
        return;
      }
      let history_length = await this.execute_script(
        agentContext,
        () => {
          return (window as any).history.length;
        },
        []
      );
      if (history_length > 1) {
        await this.execute_script(
          agentContext,
          () => {
            (window as any).history.back();
          },
          []
        );
      } else {
        let navigateTabIds = agentContext.variables.get("navigateTabIds");
        if (navigateTabIds && navigateTabIds.length > 0) {
          return await this.switch_tab(
            agentContext,
            navigateTabIds[navigateTabIds.length - 1]
          );
        }
      }
      await this.sleep(100);
    } catch (e) {
      console.error("BrowserAgent, go_back, error: ", e);
    }
  }

  protected async execute_script(
    agentContext: AgentContext,
    func: (...args: any[]) => void,
    args: any[]
  ): Promise<any> {
    let tabId = await this.getTabId(agentContext);
    let frameResults = await chrome.scripting.executeScript({
      target: { tabId: tabId as number },
      func: func,
      args: args,
      world: 'MAIN', // Run in main page world to access window.clickable_elements set by CDP
    } as any); // Cast to any because world property requires Manifest V3
    
    // Check for script execution errors and propagate them
    // Note: The error property exists at runtime but is not in the TypeScript types
    const result = frameResults[0] as chrome.scripting.InjectionResult & { error?: { message?: string } };
    if (result.error) {
      // The error object from chrome.scripting.executeScript contains the error message
      throw new Error(result.error.message || String(result.error));
    }
    
    return result.result;
  }

  /**
   * URLs that cannot be targeted by chrome.scripting or chrome.debugger.
   * If the active tab has one of these schemes the agent must skip it and
   * fall back to the most-recently-used real web page tab.
   */
  private static readonly UNSCRIPTABLE_SCHEMES = [
    'chrome-extension://',
    'chrome://',
    'about:',
    'view-source:',
    'devtools://',
  ];

  /** Returns true when the tab URL is one we can script / attach CDP to. */
  private static isScriptableTab(tab: chrome.tabs.Tab): boolean {
    const url = tab.url ?? tab.pendingUrl ?? '';
    return !BrowserAgent.UNSCRIPTABLE_SCHEMES.some((s) => url.startsWith(s));
  }

  protected async getTabId(agentContext: AgentContext): Promise<number | null> {
    let windowId = await this.getWindowId(agentContext);
    let tabs = (await chrome.tabs.query({
      windowId,
      active: true,
      windowType: "normal",
    })) as any[];

    // Filter to scriptable (non-extension) tabs
    let scriptable = tabs.filter(BrowserAgent.isScriptableTab);

    if (scriptable.length === 0) {
      // No active scriptable tab — broaden query to *all* tabs in the window
      tabs = (await chrome.tabs.query({
        windowId,
        windowType: "normal",
      })) as any[];
      scriptable = tabs.filter(BrowserAgent.isScriptableTab);
    }

    if (scriptable.length === 0) {
      console.warn('[getTabId] No scriptable tab found in window', windowId);
      // Last resort: return whatever tab is there (original behaviour)
      if (tabs.length > 0) {
        return tabs[tabs.length - 1].id as number;
      }
      return null;
    }

    return scriptable[scriptable.length - 1].id as number;
  }

  private async getWindowId(
    agentContext: AgentContext
  ): Promise<number | null> {
    let windowId = agentContext.variables.get("windowId") as number;
    if (windowId) {
      return windowId;
    }
    let window = await chrome.windows.getLastFocused({
      windowTypes: ["normal"],
    });
    if (!window) {
      window = await chrome.windows.getCurrent({
        windowTypes: ["normal"],
      });
    }
    if (window) {
      return window.id;
    }
    let tabs = (await chrome.tabs.query({
      windowType: "normal",
      currentWindow: true,
    })) as any[];
    if (tabs.length == 0) {
      tabs = (await chrome.tabs.query({
        windowType: "normal",
        lastFocusedWindow: true,
      })) as any[];
    }
    return tabs[tabs.length - 1].windowId as number;
  }

  private async waitForTabComplete(
    tabId: number,
    timeout: number = 8000
  ): Promise<chrome.tabs.Tab> {
    return new Promise(async (resolve, reject) => {
      const time = setTimeout(async () => {
        chrome.tabs.onUpdated.removeListener(listener);
        let tab = await chrome.tabs.get(tabId);
        if (tab.status === "complete") {
          resolve(tab);
        } else {
          resolve(tab);
        }
      }, timeout);
      const listener = async (updatedTabId: any, changeInfo: any, tab: any) => {
        if (updatedTabId == tabId && changeInfo.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(time);
          resolve(tab);
        }
      };
      let tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") {
        resolve(tab);
        clearTimeout(time);
        return;
      }
      chrome.tabs.onUpdated.addListener(listener);
    });
  }

  private sleep(time: number): Promise<void> {
    return new Promise((resolve) => setTimeout(() => resolve(), time));
  }

  /**
   * Cleanup all CDP sessions. Call this when workflow ends.
   *
   * When an external CDP provider is set, this only cleans up the built-in
   * `ChromeDebuggerCDPSession` cache — the external provider is expected to
   * manage its own lifecycle.
   */
  static async cleanupCDPSessions(): Promise<void> {
    await ChromeDebuggerCDPSession.detachAll();
  }
}

export { BrowserAgent };