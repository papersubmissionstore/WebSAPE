/**
 * Multi-probe `isTopElement` override.
 *
 * Kept in its own file (sibling to build_dom_tree.ts) so upstream eko-patch
 * syncs of build_dom_tree.ts remain conflict-free. build_dom_tree.ts only
 * contains a tiny hook that delegates to `window.__ekoIsTopElementOverride`
 * when present.
 *
 * Why multi-probe?
 *   The default eko `isTopElement` calls `document.elementFromPoint` at the
 *   element's *center* and treats any non-matching hit as "not top" (i.e.
 *   occluded). This drops elements whose center sits under a sticky overlay
 *   (e.g. a chat row partially covered by a fixed message-composer card)
 *   even though plenty of the element is still visible. Indexing-wise this
 *   is a false negative: the element is never assigned a highlightIndex and
 *   therefore disappears from the pseudo DOM.
 *
 *   The multi-probe variant samples up to 9 points in the element's
 *   bounding rect (center + 4 inset corners + 4 edge midpoints). If *any*
 *   probe resolves to the element (or one of its descendants via the
 *   ancestor walk), the element is considered top. False positives (truly
 *   hidden elements being indexed) are rare in practice because hidden
 *   elements typically fail other gates (`isElementVisible`, expanded
 *   viewport, etc.) before `isTopElement` is even called.
 *
 * Usage: call `run_install_is_top_element_multi_probe_hook` via
 * `execute_script` BEFORE `run_build_dom_tree`. The companion config flag is
 * `multiProbeIsTopElement` in @eko-ai/eko config.
 */

// @ts-nocheck
export function run_install_is_top_element_multi_probe_hook() {
  // Probe-based override.
  (window as any).__ekoIsTopElementOverride = function (element: Element): boolean {
    if (!element) return false;

    // Iframe path: same as upstream — elements in nested docs are considered top.
    const doc = element.ownerDocument;
    if (doc !== window.document) {
      return true;
    }

    let rect: DOMRect;
    try {
      rect = element.getBoundingClientRect();
    } catch (_e) {
      return true;
    }
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return false;
    }

    // Inset slightly so we don't sample exactly on the border (some browsers
    // return the parent at the exact edge pixel).
    const inset = Math.min(4, Math.max(1, Math.floor(Math.min(rect.width, rect.height) / 4)));
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const probes = [
      { x: cx, y: cy },                                  // center
      { x: rect.left + inset, y: rect.top + inset },     // top-left
      { x: rect.right - inset, y: rect.top + inset },    // top-right
      { x: rect.left + inset, y: rect.bottom - inset },  // bottom-left
      { x: rect.right - inset, y: rect.bottom - inset }, // bottom-right
      { x: cx, y: rect.top + inset },                    // top-center
      { x: cx, y: rect.bottom - inset },                 // bottom-center
      { x: rect.left + inset, y: cy },                   // left-center
      { x: rect.right - inset, y: cy },                  // right-center
    ];

    function hitsElement(topEl: Element | null, root: Node): boolean {
      if (!topEl) return false;
      let count = 0;
      let current: Element | null = topEl;
      while (current && current !== root) {
        if (current === element) return true;
        current = current.parentElement;
        if (++count > 15) break;
      }
      return false;
    }

    // Shadow DOM: probe via the shadow root's own elementFromPoint.
    const rootNode = element.getRootNode();
    if (rootNode instanceof ShadowRoot) {
      try {
        for (const p of probes) {
          const topEl = rootNode.elementFromPoint(p.x, p.y) as Element | null;
          if (hitsElement(topEl, rootNode)) return true;
        }
        return false;
      } catch (_e) {
        return true;
      }
    }

    // Regular DOM.
    try {
      for (const p of probes) {
        const topEl = document.elementFromPoint(p.x, p.y) as Element | null;
        if (hitsElement(topEl, document.documentElement)) return true;
      }
      return false;
    } catch (_e) {
      return true;
    }
  };
}

/**
 * Companion uninstaller — useful in tests / when toggling at runtime.
 */
export function run_uninstall_is_top_element_multi_probe_hook() {
  try {
    delete (window as any).__ekoIsTopElementOverride;
  } catch (_e) {
    (window as any).__ekoIsTopElementOverride = undefined;
  }
}
