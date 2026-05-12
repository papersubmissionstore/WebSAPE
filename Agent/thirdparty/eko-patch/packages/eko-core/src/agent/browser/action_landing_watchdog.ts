/**
 * Action-landing watchdog (in-page).
 *
 * Self-contained module installed via `execute_script` BEFORE each browser
 * action (click / hover / scroll-to-element / etc). Kept in its own file so
 * upstream eko-patch syncs of build_dom_tree.ts / browser_labels.ts remain
 * conflict-free — only tiny hook calls live in those files.
 *
 * Companion config flag: `actionLandingWatchdog` in @eko-ai/eko config.
 *
 * What it does
 * ------------
 * The default eko `validate_element_interactable` calls
 * `document.elementFromPoint(centerX, centerY)` exactly once and rejects the
 * action if the hit is not the target / one of its descendants. This is too
 * pessimistic when:
 *
 *   - the target is partially clipped by its own scroll container's footer
 *     (e.g. the last DM message under a sticky `.message-input-area`), or
 *   - the target's center happens to land on a sibling element due to
 *     scroll position, despite the rest of the target being interactable.
 *
 * The watchdog runs a fault-triggered, deterministic rescue:
 *
 *   1. centerHitTest #1   (always; "occlusion_check")
 *   2. on fail: scrollIntoView({block:'center'})  (only if a scrollable
 *      ancestor exists; "auto_scroll_into_view")
 *   3. centerHitTest #2   (only after step 2; "occlusion_recheck")
 *
 * If step 3 passes the action proceeds; otherwise we surface an enriched
 * error to the caller (caller decides whether to throw).
 *
 * Event protocol (what gets logged into progress.json `tool_result`)
 * ----------------------------------------------------------------
 * Each watchdog invocation appends events to `window.__ekoActionLandingEvents`
 * (a flat array, drained by `window.__ekoActionLandingFlush()`). Every event
 * carries:
 *
 *   - seq: monotonic 0,1,2... within the current tool call (reset on flush)
 *   - phase: "pre_tool_call" | "post_tool_call" — relative to the *primary
 *            dispatched action* (hover / click / type). All current events
 *            are pre_tool_call. Reserved for future post-action verifiers.
 *   - kind: short event name (occlusion_check, auto_scroll_into_view, ...)
 *   - source: which watchdog produced it ("occlusion_watchdog" today)
 *   - ts: ISO 8601 timestamp
 *   - durationMs: integer milliseconds for the step
 *   - additional kind-specific fields (passed, covering, deltaY, ...)
 *
 * IMPORTANT: the watchdog NEVER becomes part of the LLM-visible tool surface.
 * It is plumbing. The orchestrator surfaces these events in `progress.json`
 * for humans / replay / analysis only.
 */

// @ts-nocheck
export function run_install_action_landing_watchdog_hook() {
  // Per-call event buffer. Flushed by browser_labels.ts host after each action.
  if (!Array.isArray((window as any).__ekoActionLandingEvents)) {
    (window as any).__ekoActionLandingEvents = [];
  }

  /**
   * Drain and return all pending events. Called from the TS host after each
   * action via execute_script. Resets seq for the next call.
   */
  (window as any).__ekoActionLandingFlush = function (): any[] {
    const events = (window as any).__ekoActionLandingEvents || [];
    (window as any).__ekoActionLandingEvents = [];
    return events;
  };

  function describeElement(el: Element | null): string {
    if (!el) return "null";
    const tag = el.tagName ? el.tagName.toLowerCase() : "?";
    const id = (el as any).id ? `#${(el as any).id}` : "";
    let cls = "";
    try {
      const c = el.getAttribute("class");
      if (c) cls = "." + c.split(/\s+/).filter(Boolean).slice(0, 3).join(".");
    } catch (_e) {}
    return `<${tag}${id}${cls}>`;
  }

  function nowIso(): string {
    try { return new Date().toISOString(); } catch (_e) { return ""; }
  }

  function pushEvent(ev: any): void {
    const buf = (window as any).__ekoActionLandingEvents;
    if (!Array.isArray(buf)) return;
    ev.seq = buf.length;
    buf.push(ev);
  }

  /**
   * Find the nearest ancestor whose vertical/horizontal scroll position can
   * actually move (i.e. content overflows). Returns null if none — that
   * means scrollIntoView won't help, and we should error fast.
   *
   * We exclude `documentElement` / `body` only when the page itself isn't
   * scrollable; otherwise the page-level scroll is a valid rescue target.
   */
  function findScrollableAncestor(el: Element): Element | null {
    let cur: Element | null = el.parentElement;
    while (cur) {
      let style: CSSStyleDeclaration;
      try { style = window.getComputedStyle(cur); } catch (_e) { cur = cur.parentElement; continue; }
      const oy = style.overflowY;
      const ox = style.overflowX;
      const scrollableY = (oy === "auto" || oy === "scroll" || oy === "overlay") && cur.scrollHeight > cur.clientHeight;
      const scrollableX = (ox === "auto" || ox === "scroll" || ox === "overlay") && cur.scrollWidth > cur.clientWidth;
      if (scrollableY || scrollableX) return cur;
      cur = cur.parentElement;
    }
    // Fall back to documentElement if the page itself is scrollable.
    const de = document.documentElement;
    if (de && (de.scrollHeight > de.clientHeight || de.scrollWidth > de.clientWidth)) return de;
    return null;
  }

  /**
   * Single-point center hit-test: returns { passed, covering? }. `passed` is
   * true iff `elementFromPoint(center)` walks up to `target`.
   */
  function centerHitTest(target: Element): { passed: boolean; covering: Element | null; centerX: number; centerY: number } {
    let rect: DOMRect;
    try { rect = target.getBoundingClientRect(); } catch (_e) { return { passed: false, covering: null, centerX: 0, centerY: 0 }; }
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    if (centerX < 0 || centerX > window.innerWidth || centerY < 0 || centerY > window.innerHeight) {
      // Off-screen center: cannot test via elementFromPoint. Treat as fail
      // so the rescue path tries scrollIntoView.
      return { passed: false, covering: null, centerX, centerY };
    }
    let top: Element | null = null;
    try { top = document.elementFromPoint(centerX, centerY) as Element | null; } catch (_e) { top = null; }
    if (!top) return { passed: false, covering: null, centerX, centerY };
    // Walk up to see if `top` reaches `target`.
    let cur: Element | null = top;
    let count = 0;
    while (cur && cur !== document.documentElement) {
      if (cur === target) return { passed: true, covering: null, centerX, centerY };
      cur = cur.parentElement;
      if (++count > 50) break;
    }
    // Also check if target contains top (target is a wrapper).
    try { if (target.contains(top)) return { passed: true, covering: null, centerX, centerY }; } catch (_e) {}
    return { passed: false, covering: top, centerX, centerY };
  }

  /**
   * Public entry point. Called from validate_element_interactable's tiny
   * hook in build_dom_tree.ts.
   *
   * Returns:
   *   { rescued: true }                       → caller may proceed
   *   { rescued: false, error: string }       → caller should surface error
   *
   * Side effect: appends events to window.__ekoActionLandingEvents.
   *
   * `kind` parameter mirrors the action that triggered the resolve; today
   * we don't differentiate but it's logged on each event for analysis.
   */
  (window as any).__ekoActionLandingWatchdog = function (
    target: Element,
    opts?: { actionKind?: string }
  ): { rescued: boolean; error?: string } {
    const actionKind = (opts && opts.actionKind) || "unknown";
    const phase = "pre_tool_call";

    // ── Step 1: occlusion_check (always emitted) ──────────────────────────
    let t0 = performance.now();
    const r1 = centerHitTest(target);
    pushEvent({
      phase,
      kind: "occlusion_check",
      source: "occlusion_watchdog",
      actionKind,
      passed: r1.passed,
      covering: r1.covering ? describeElement(r1.covering) : null,
      centerX: Math.round(r1.centerX),
      centerY: Math.round(r1.centerY),
      ts: nowIso(),
      durationMs: Math.max(0, Math.round(performance.now() - t0)),
    });
    if (r1.passed) return { rescued: true };

    // ── Step 2: try scrollIntoView (only if possible) ─────────────────────
    const scrollAncestor = findScrollableAncestor(target);
    if (!scrollAncestor) {
      // No scrollable ancestor → genuine overlay (modal/fixed). Bail fast.
      const err =
        `Element resolution failed: Element found but is covered by ${r1.covering ? describeElement(r1.covering) : "another element"} ` +
        `at its center point and no scrollable ancestor exists to rescue it. ` +
        `The element may be behind a modal, overlay, or loading spinner. Try closing the overlay or waiting for it to disappear.`;
      return { rescued: false, error: err };
    }

    t0 = performance.now();
    let scrollOk = true;
    let deltaY = 0;
    let deltaX = 0;
    let scrollErr: string | null = null;
    try {
      const beforeRect = target.getBoundingClientRect();
      target.scrollIntoView({ block: "center", inline: "nearest" });
      // Force synchronous layout flush so the next centerHitTest sees the new rect.
      // (Reading offsetHeight is the standard reflow trigger; same pattern as
      // do_click in browser_labels.ts.)
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      (target as HTMLElement).offsetHeight;
      const afterRect = target.getBoundingClientRect();
      deltaY = Math.round(afterRect.top - beforeRect.top);
      deltaX = Math.round(afterRect.left - beforeRect.left);
    } catch (e: any) {
      scrollOk = false;
      scrollErr = e && e.message ? e.message : String(e);
    }
    pushEvent({
      phase,
      kind: "auto_scroll_into_view",
      source: "occlusion_watchdog",
      actionKind,
      ok: scrollOk,
      scrollAncestor: describeElement(scrollAncestor),
      deltaY,
      deltaX,
      error: scrollErr,
      ts: nowIso(),
      durationMs: Math.max(0, Math.round(performance.now() - t0)),
    });

    if (!scrollOk) {
      const err =
        `Element resolution failed: occlusion check failed and scrollIntoView raised "${scrollErr}". ` +
        `Original covering element: ${r1.covering ? describeElement(r1.covering) : "unknown"}.`;
      return { rescued: false, error: err };
    }

    // ── Step 3: occlusion_recheck (only after a scroll attempt) ───────────
    t0 = performance.now();
    const r2 = centerHitTest(target);
    pushEvent({
      phase,
      kind: "occlusion_recheck",
      source: "occlusion_watchdog",
      actionKind,
      passed: r2.passed,
      covering: r2.covering ? describeElement(r2.covering) : null,
      centerX: Math.round(r2.centerX),
      centerY: Math.round(r2.centerY),
      ts: nowIso(),
      durationMs: Math.max(0, Math.round(performance.now() - t0)),
    });

    if (r2.passed) return { rescued: true };

    const err =
      `Element resolution failed: Element still covered after scrollIntoView. ` +
      `Original covering: ${r1.covering ? describeElement(r1.covering) : "unknown"}. ` +
      `Post-scroll covering: ${r2.covering ? describeElement(r2.covering) : "unknown"}. ` +
      `Scrolled by deltaY=${deltaY}px in ${describeElement(scrollAncestor)}. ` +
      `If the covering element is a sticky/fixed footer the inner list may be at its true bottom — ` +
      `try selecting a different element or scrolling the inner list further.`;
    return { rescued: false, error: err };
  };
}

/**
 * Companion uninstaller — useful in tests / when toggling at runtime.
 */
// @ts-nocheck
export function run_uninstall_action_landing_watchdog_hook() {
  try {
    delete (window as any).__ekoActionLandingWatchdog;
    delete (window as any).__ekoActionLandingFlush;
    delete (window as any).__ekoActionLandingEvents;
  } catch (_e) {
    (window as any).__ekoActionLandingWatchdog = undefined;
    (window as any).__ekoActionLandingFlush = undefined;
    (window as any).__ekoActionLandingEvents = undefined;
  }
}

/**
 * Helper script: drain and return pending action-landing events.
 * Designed to be called via execute_script from browser_labels.ts after each
 * action completes (success or failure). Returns [] when watchdog isn't
 * installed.
 */
// @ts-nocheck
export function run_flush_action_landing_events(): any[] {
  const fn = (window as any).__ekoActionLandingFlush;
  if (typeof fn !== "function") return [];
  try {
    return fn() || [];
  } catch (_e) {
    return [];
  }
}
