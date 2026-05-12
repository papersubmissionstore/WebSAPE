import { AgentContext, BaseBrowserLabelsAgent, type BrowserSelector } from "@eko-ai/eko";
import {
  chromium,
  Browser,
  Page,
  ElementHandle,
  BrowserContext,
} from "playwright";
import { getDefaultChromeUserDataDir } from "./utils";

export default class BrowserAgent extends BaseBrowserLabelsAgent {
  private cdpWsEndpoint?: string;
  private userDataDir?: string;
  private options?: Record<string, any>;
  protected browser: Browser | null = null;
  private browser_context: BrowserContext | null = null;
  private current_page: Page | null = null;
  private headless: boolean = false;

  public setHeadless(headless: boolean) {
    this.headless = headless;
  }

  public setCdpWsEndpoint(cdpWsEndpoint: string) {
    this.cdpWsEndpoint = cdpWsEndpoint;
  }

  public initUserDataDir(userDataDir?: string): string | undefined {
    if (userDataDir) {
      this.userDataDir = userDataDir;
    } else {
      this.userDataDir = getDefaultChromeUserDataDir(true);
    }
    return this.userDataDir;
  }

  public setOptions(options?: Record<string, any>) {
    this.options = options;
  }

  protected async screenshot(
    agentContext: AgentContext
  ): Promise<{ imageBase64: string; imageType: "image/jpeg" | "image/png" }> {
    let page = await this.currentPage();
    let screenshotBuffer = await page.screenshot({
      fullPage: false,
      type: "jpeg",
      quality: 60,
    });
    let base64 = screenshotBuffer.toString("base64");
    return {
      imageType: "image/jpeg",
      imageBase64: base64,
    };
  }

  protected async navigate_to(
    agentContext: AgentContext,
    url: string
  ): Promise<{
    url: string;
    title?: string;
    tabId?: number;
  }> {
    // Clear image memories when navigating to a new URL
    this.clearImageMemories(agentContext);
    
    let page = await this.open_url(agentContext, url);
    await this.sleep(200);
    let tabId: number | undefined;
    if (this.browser_context) {
      const pages = await this.browser_context.pages();
      tabId = pages.indexOf(page);
      if (tabId === -1) {
        tabId = undefined;
      }
    }
    return {
      url: page.url(),
      title: await page.title(),
      tabId: tabId,
    };
  }

  /**
   * Clear base64 image content from messages in agent context memories.
   * Keeps the message structure but replaces base64 data with a placeholder.
   * This helps reduce memory usage when navigating to new URLs.
   */
  private clearImageMemories(agentContext: AgentContext): void {
    const messages = agentContext.messages;
    if (!messages || messages.length === 0) {
      return;
    }

    // Iterate through messages and replace base64 image data with placeholder
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i] as any;
      if (message.role === "user" && Array.isArray(message.content)) {
        for (let j = 0; j < message.content.length; j++) {
          const part = message.content[j] as any;
          // Handle image_url type
          if (part.type === "image_url" && part.image_url?.url?.startsWith("data:image/jpeg;base64")) {
            part.image_url.url = "[image omitted]";
          }
          // Handle file type with base64 image data
          if (part.type === "file" && typeof part.data === "string" && part.data.startsWith("data:image/")) {
            part.data = "[image omitted]";
          }
          // Handle file type where data is a Uint8Array or buffer (binary image data)
          if (part.type === "file" && part.data instanceof Uint8Array) {
            part.data = new TextEncoder().encode("[image omitted]");
          }
        }
      }
    }
  }

  protected async get_all_tabs(
    agentContext: AgentContext
  ): Promise<Array<{ tabId: number; url: string; title: string }>> {
    if (!this.browser_context) {
      return [];
    }
    let result: Array<{ tabId: number; url: string; title: string }> = [];
    const pages = await this.browser_context.pages();
    for (let i = 0; i < pages.length; i++) {
      let page = pages[i];
      result.push({
        tabId: i,
        url: page.url(),
        title: await page.title(),
      });
    }
    return result;
  }

  protected async get_current_page(agentContext: AgentContext): Promise<{
    url: string;
    title?: string;
    tabId?: number;
  }> {
    const page = await this.currentPage();
    let tabId: number | undefined;
    if (this.browser_context) {
      const pages = await this.browser_context.pages();
      tabId = pages.indexOf(page);
      if (tabId === -1) {
        tabId = undefined;
      }
    }
    return {
      url: page.url(),
      title: await page.title(),
      tabId: tabId,
    };
  }

  protected async switch_tab(
    agentContext: AgentContext,
    tabId: number
  ): Promise<{ tabId: number; url: string; title: string }> {
    if (!this.browser_context) {
      throw new Error("tabId does not exist: " + tabId);
    }
    const pages = await this.browser_context.pages();
    const page = pages[tabId];
    if (!page) {
      throw new Error("tabId does not exist: " + tabId);
    }
    this.current_page = page;
    return {
      tabId: tabId,
      url: page.url(),
      title: await page.title(),
    };
  }

  protected async input_text(
    agentContext: AgentContext,
    selector: BrowserSelector,
    text: string,
    enter: boolean
  ): Promise<any> {
    try {
      let elementHandle = await this.get_element_by_selector(selector, true);
      await elementHandle.fill("");
      await elementHandle.fill(text);
      if (enter) {
        await elementHandle.press("Enter");
        await this.sleep(200);
      }
    } catch (e) {
      await super.input_text(agentContext, selector, text, enter);
    }
  }

  protected async click_element(
    agentContext: AgentContext,
    selector: BrowserSelector,
    num_clicks: number,
    button: "left" | "right" | "middle"
  ): Promise<any> {
    try {
      let elementHandle = await this.get_element_by_selector(selector, true);
      await elementHandle.click({
        button,
        clickCount: num_clicks,
        force: true,
      });
    } catch (e) {
      await super.click_element(agentContext, selector, num_clicks, button);
    }
    return { canonicalSelector: undefined };
  }

  protected async hover_to_element(
    agentContext: AgentContext,
    index: number
  ): Promise<{ canonicalSelector?: any }> {
    try {
      let elementHandle = await this.get_element(index, true);
      elementHandle.hover({ force: true });
    } catch (e) {
      await super.hover_to_element(agentContext, index);
    }
    return { canonicalSelector: undefined };
  }

  protected async execute_script(
    agentContext: AgentContext,
    func: (...args: any[]) => void,
    args: any[]
  ): Promise<any> {
    let page = await this.currentPage();
    // Playwright's page.evaluate() only accepts at most 1 argument.
    // If multiple args are provided, wrap them in an array.
    if (args.length <= 1) {
      return await page.evaluate(func, ...args);
    } else {
      return await page.evaluate(func, args);
    }
  }

  /**
   * Get a CDP session for the current page.
   * This enables accessibility tree building via CDP.
   */
  protected async getCDPSession(
    agentContext: AgentContext
  ): Promise<{ send: (method: string, params?: any) => Promise<any>; detach: () => Promise<void> } | null> {
    try {
      const page = await this.currentPage();
      const cdpSession = await page.context().newCDPSession(page);
      // Wrap the CDP session to provide a generic send method
      // (Playwright's CDPSession.send is strictly typed, we need a looser type)
      return {
        send: (method: string, params?: any) => (cdpSession.send as any)(method, params),
        detach: () => cdpSession.detach(),
      };
    } catch (e) {
      console.warn("[getCDPSession] Failed to create CDP session:", e);
      return null;
    }
  }

  private async open_url(
    agentContext: AgentContext,
    url: string
  ): Promise<Page> {
    let browser_context = await this.getBrowserContext();
    const page: Page = await browser_context.pages()[0] || await browser_context.newPage();
    // await page.setViewportSize({ width: 1920, height: 1080 });
    await page.setViewportSize({ width: 1536, height: 864 });
    try {
      await page.goto(url, {
        waitUntil: "networkidle",
        timeout: 10000,
      });
      await page.waitForLoadState("load", { timeout: 8000 });
    } catch (e) {
      if ((e + "").indexOf("Timeout") == -1) {
        throw e;
      }
    }
    this.current_page = page;
    return page;
  }

  protected async currentPage(): Promise<Page> {
    if (this.current_page == null) {
      this.current_page = await this.getBrowserContext().then(
        (context) => context.pages()[0] || context.newPage()
      );
      if (this.current_page == null) {
        throw new Error("There is no page, please call navigate_to first");
      }
    }
    let page = this.current_page as Page;
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 10000 });
    } catch (e) {}
    return page;
  }

  private async get_element(
    index: number,
    findInput?: boolean
  ): Promise<ElementHandle> {
    let page = await this.currentPage();
    return await page.evaluateHandle(
      (params: any) => {
        let element = (window as any).get_highlight_element(params.index);
        if (element && params.findInput) {
          if (
            element.tagName != "INPUT" &&
            element.tagName != "TEXTAREA" &&
            element.childElementCount != 0
          ) {
            element =
              element.querySelector("input") ||
              element.querySelector("textarea") ||
              element;
          }
        }
        return element;
      },
      { index, findInput }
    );
  }

  /**
   * Get element by BrowserSelector - supports both numeric index and semantic selectors.
   * This enables Playwright's native click for semantic selectors (ariaLabel, id, etc.)
   * which generates trusted events that React/Fluent UI apps respond to.
   */
  private async get_element_by_selector(
    selector: BrowserSelector,
    findInput?: boolean
  ): Promise<ElementHandle> {
    let page = await this.currentPage();
    return await page.evaluateHandle(
      (params: any) => {
        // Use the centralized element resolution from window (set by build_dom_tree.ts)
        const element = (window as any).resolve_element_by_selector(params.selector);
        if (!element) {
          throw new Error(`Element not found for selector: ${JSON.stringify(params.selector)}`);
        }
        
        // For input operations, try to find the actual input element inside
        if (element && params.findInput) {
          if (
            element.tagName != "INPUT" &&
            element.tagName != "TEXTAREA" &&
            element.childElementCount != 0
          ) {
            return element.querySelector("input") ||
              element.querySelector("textarea") ||
              element;
          }
        }
        return element;
      },
      { selector, findInput }
    );
  }

  private sleep(time: number): Promise<void> {
    return new Promise((resolve) => setTimeout(() => resolve(), time));
  }

  protected async getBrowserContext() {
    if (!this.browser_context) {
      this.current_page = null;
      this.browser_context = null;
      if (this.cdpWsEndpoint) {
        this.browser = await chromium.connectOverCDP(this.cdpWsEndpoint, this.options);
        // 先尝试复用现有 context
        const contexts = this.browser.contexts();
        
        if (contexts.length > 0) {
          this.browser_context = contexts[0];
          await this.debugDumpState();
          // 尝试 adopt 已存在的页（排除空白页）
          const existing = this.browser_context.pages().find(p => {
            const u = p.url();
            return u && u !== 'about:blank' && u !== 'chrome://newtab/';
          });
          if (existing) this.current_page = existing;
        } else {
          // 没有现成 context 再新建
          this.browser_context = await this.browser.newContext(this.options);
        }
      } else if (this.userDataDir) {
        this.browser_context = await chromium.launchPersistentContext(this.userDataDir, {
          headless: this.headless,
          args: [
            "--no-sandbox",
            "--remote-allow-origins=*",
            "--disable-dev-shm-usage",
            "--disable-popup-blocking",
            "--enable-automation",
            "--ignore-ssl-errors",
            "--ignore-certificate-errors",
            "--ignore-certificate-errors-spki-list",
            "--disable-blink-features=AutomationControlled",
          ],
          ...this.options,
        });
      } else {
        this.browser = await chromium.launch({
          headless: this.headless,
          args: [
            "--no-sandbox",
            "--remote-allow-origins=*",
            "--disable-dev-shm-usage",
            "--disable-popup-blocking",
            "--enable-automation",
            "--ignore-ssl-errors",
            "--ignore-certificate-errors",
            "--ignore-certificate-errors-spki-list",
            "--disable-blink-features=AutomationControlled",
          ],
          ...this.options,
        });
        this.browser_context = await this.browser.newContext(this.options);
      }

      const init_script = await this.initScript();
      this.browser_context.addInitScript(init_script);
    }
    return this.browser_context;
  }
  
  public async debugDumpState(): Promise<void> {
    if (this.browser) {
      // 有 Browser（CDP 或普通 launch）
      const contexts = this.browser.contexts();
      // console.log(`[BrowserAgent] contexts = ${contexts.length}`);
      for (let ci = 0; ci < contexts.length; ci++) {
        const ctx = contexts[ci];
        const pages = ctx.pages();
        // console.log(`  [ctx #${ci}] pages = ${pages.length}`);
        for (let pi = 0; pi < pages.length; pi++) {
          const p = pages[pi];
          const title = await p.title().catch(() => '(title error)');
          // console.log(`    [page #${pi}] ${p.url()} | "${title}"`);
        }
      }
    } else if (this.browser_context) {
      // 持久化模式（launchPersistentContext）只有 context 没有 browser
      const pages = this.browser_context.pages();
      // console.log(`[BrowserAgent] single persistent context | pages = ${pages.length}`);
      for (let pi = 0; pi < pages.length; pi++) {
        const p = pages[pi];
        const title = await p.title().catch(() => '(title error)');
        // console.log(`  [page #${pi}] ${p.url()} | "${title}"`);
      }
    } else {
      // console.log('[BrowserAgent] not initialized: no browser/context yet');
    }
  }

  protected async initScript(): Promise<{ path?: string; content?: string }> {
    return {
      content: `
      // Webdriver property
			Object.defineProperty(navigator, 'webdriver', {
				get: () => undefined
			});

			// Languages
			Object.defineProperty(navigator, 'languages', {
				get: () => ['en-US']
			});

			// Plugins
			Object.defineProperty(navigator, 'plugins', {
				get: () => [{name:"1"}, {name:"2"}, {name:"3"}, {name:"4"}, {name:"5"}]
			});

			// Chrome runtime
			window.chrome = { runtime: {} };

			// Permissions
			const originalQuery = window.navigator.permissions.query;
			window.navigator.permissions.query = (parameters) => (
				parameters.name === 'notifications' ?
					Promise.resolve({ state: Notification.permission }) :
					originalQuery(parameters)
			);
			(function () {
				const originalAttachShadow = Element.prototype.attachShadow;
				Element.prototype.attachShadow = function attachShadow(options) {
					return originalAttachShadow.call(this, { ...options, mode: "open" });
				};
			})();
      `,
    };
  }
}

export { BrowserAgent };
