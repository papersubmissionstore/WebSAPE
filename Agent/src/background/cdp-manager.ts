/**
 * Unified CDP Session Manager
 *
 * The single source of truth for all Chrome DevTools Protocol (CDP) sessions
 * in the extension.  Every consumer — cookie injection, dialog auto-dismiss,
 * eko a11y-tree building, CDP-based clicks — acquires sessions from here.
 *
 * Chrome only allows **one** debugger attachment per tab.  By funnelling
 * everything through one manager we avoid the "another debugger is already
 * attached" error that previously caused eko to silently fall back from a11y
 * tree mode to eko-native DOM mode on webarena tasks.
 *
 * Design:
 *  - One `CdpSession` per tab, lazily created on first `acquire()`.
 *  - Ref-counted: each `acquire()` increments, each `release()` decrements.
 *    The underlying `chrome.debugger` is only detached when refs hit 0 and
 *    `autoDetachOnZeroRefs` is true, OR via `forceDetach()`.
 *  - Dialog auto-dismiss is a toggleable feature of a session — not a
 *    separate debugger attachment.
 *  - Consumers may also call `send()` directly for one-off CDP commands
 *    (e.g. setting cookies).
 */

import { logger } from "../utils/logger";

// ── CdpSession ───────────────────────────────────────────────────────────────

export class CdpSession {
  readonly tabId: number;

  private _attached = false;
  private _refCount = 0;
  private _dialogListenerInstalled = false;
  private _dialogEventListener:
    | ((source: chrome.debugger.Debuggee, method: string, params?: object) => void)
    | null = null;

  /** Whether to actually detach when refCount drops to 0 (default: false, keeps alive for reuse). */
  autoDetachOnZeroRefs = false;

  constructor(tabId: number) {
    this.tabId = tabId;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Attach chrome.debugger if not already attached. */
  async attach(): Promise<void> {
    if (this._attached) return;

    return new Promise<void>((resolve, reject) => {
      chrome.debugger.attach({ tabId: this.tabId }, "1.3", () => {
        if (chrome.runtime.lastError) {
          const msg = chrome.runtime.lastError.message ?? "";
          // Treat "already attached" as success — we are the owner.
          if (msg.includes("already attached")) {
            this._attached = true;
            resolve();
          } else {
            logger.warning("CDP_ATTACH", `Failed to attach debugger to tab ${this.tabId}: ${msg}`);
            reject(new Error(msg));
          }
        } else {
          this._attached = true;
          resolve();
        }
      });
    });
  }

  /** Send a CDP command on this session. Auto-attaches if needed. */
  async send(method: string, params?: Record<string, unknown>): Promise<any> {
    if (!this._attached) {
      await this.attach();
    }
    return new Promise<any>((resolve, reject) => {
      chrome.debugger.sendCommand(
        { tabId: this.tabId },
        method,
        params ?? {},
        (result) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message ?? "CDP send failed"));
          } else {
            resolve(result);
          }
        },
      );
    });
  }

  // ── Ref counting ─────────────────────────────────────────────────────────

  /** Increment reference count (called by CdpManager.acquire). */
  acquire(): void {
    this._refCount++;
  }

  /** Decrement ref count. Optionally detaches when it hits 0. */
  async release(): Promise<void> {
    this._refCount = Math.max(0, this._refCount - 1);
    if (this._refCount === 0 && this.autoDetachOnZeroRefs) {
      await this.forceDetach();
    }
  }

  /**
   * Alias for `release()` — satisfies eko's `{ send, detach }` CDP interface.
   */
  async detach(): Promise<void> {
    return this.release();
  }

  get refCount(): number {
    return this._refCount;
  }

  // ── Force detach ─────────────────────────────────────────────────────────

  /** Actually detach the debugger regardless of ref count. */
  async forceDetach(): Promise<void> {
    this._disableDialogHandler();
    if (!this._attached) return;

    return new Promise<void>((resolve) => {
      chrome.debugger.detach({ tabId: this.tabId }, () => {
        // Ignore errors (tab may already be gone)
        this._attached = false;
        this._refCount = 0;
        resolve();
      });
    });
  }

  get isAttached(): boolean {
    return this._attached;
  }

  // ── Dialog auto-dismiss feature ──────────────────────────────────────────

  /**
   * Enable auto-dismissal of JS dialogs (beforeunload, alert, confirm, prompt)
   * on this tab.  Safe to call multiple times — idempotent for the listener,
   * but always re-sends Page.enable to survive cross-origin navigations that
   * reset CDP domain state.
   */
  async enableDialogAutoDismiss(): Promise<void> {
    // Always (re-)enable the Page domain.  After a cross-origin navigation the
    // CDP Page domain state is reset, so Page.javascriptDialogOpening events
    // stop firing even though our chrome.debugger.onEvent listener is still
    // registered.  Re-sending Page.enable is cheap and idempotent on the CDP
    // side, so it's safe to call unconditionally.
    await this.send("Page.enable");

    if (this._dialogListenerInstalled) return;

    this._dialogEventListener = (
      source: chrome.debugger.Debuggee,
      method: string,
      params?: object,
    ) => {
      if (source.tabId === this.tabId && method === "Page.javascriptDialogOpening") {
        logger.info("CDP_DIALOG", `Auto-dismissing dialog on tab ${this.tabId}`, params);
        chrome.debugger.sendCommand(
          { tabId: this.tabId },
          "Page.handleJavaScriptDialog",
          { accept: true },
        );
      }
    };
    chrome.debugger.onEvent.addListener(this._dialogEventListener);
    this._dialogListenerInstalled = true;
  }

  /** Disable dialog auto-dismiss (removes the listener). */
  disableDialogAutoDismiss(): void {
    this._disableDialogHandler();
  }

  private _disableDialogHandler(): void {
    if (this._dialogEventListener) {
      chrome.debugger.onEvent.removeListener(this._dialogEventListener);
      this._dialogEventListener = null;
    }
    this._dialogListenerInstalled = false;
  }

  // ── Mark externally detached ──────────────────────────────────────────────

  /** Called by CdpManager when Chrome fires onDetach for this tab. */
  _markDetached(): void {
    this._disableDialogHandler();
    this._attached = false;
    this._refCount = 0;
  }
}

// ── CdpManager (singleton) ──────────────────────────────────────────────────

class CdpManager {
  private sessions = new Map<number, CdpSession>();
  private _detachListenerInstalled = false;

  private _installGlobalDetachListener(): void {
    if (this._detachListenerInstalled) return;
    chrome.debugger.onDetach.addListener((source, _reason) => {
      if (source.tabId !== undefined) {
        const session = this.sessions.get(source.tabId);
        if (session) {
          logger.info("CDP_DETACH", `Debugger detached from tab ${source.tabId}`, { reason: _reason });
          session._markDetached();
          this.sessions.delete(source.tabId);
        }
      }
    });
    this._detachListenerInstalled = true;
  }

  /**
   * Acquire a CDP session for a tab.
   *
   * - If a session already exists and is attached, its ref count is bumped.
   * - Otherwise a new session is created and attached.
   *
   * Callers **must** call `session.release()` when done (or `forceDetach()`
   * if they want to close the debugger immediately).
   */
  async acquire(tabId: number): Promise<CdpSession> {
    this._installGlobalDetachListener();

    let session = this.sessions.get(tabId);
    if (session?.isAttached) {
      session.acquire();
      return session;
    }

    session = new CdpSession(tabId);
    await session.attach();
    session.acquire();
    this.sessions.set(tabId, session);
    return session;
  }

  /**
   * Get the existing session for a tab without incrementing the ref count.
   * Returns `null` if no session exists or it is detached.
   */
  peek(tabId: number): CdpSession | null {
    const s = this.sessions.get(tabId);
    return s?.isAttached ? s : null;
  }

  /** Force-detach all sessions (call when workflow or extension shuts down). */
  async detachAll(): Promise<void> {
    const all = Array.from(this.sessions.values());
    for (const s of all) {
      await s.forceDetach();
    }
    this.sessions.clear();
  }
}

/**
 * The singleton instance — import this everywhere.
 *
 * ```ts
 * import { cdpManager } from "./cdp-manager";
 * const session = await cdpManager.acquire(tabId);
 * ```
 */
export const cdpManager = new CdpManager();
