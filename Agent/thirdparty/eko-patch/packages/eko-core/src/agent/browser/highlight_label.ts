/**
 * Non-occluding highlight label logic.
 *
 * This module is kept separate from build_dom_tree.ts so that upstream
 * eko-patch syncs remain conflict-free.  build_dom_tree.ts stays untouched;
 * the noocclude behaviour is injected via window.__eko_styleHighlightLabel
 * before the DOM tree script runs.
 *
 * Two pieces live here:
 *  1. `run_install_noocclude_label_hook` – browser-injected function that sets
 *     window.__eko_styleHighlightLabel  (DOM overlay path)
 *  2. Canvas-drawing helpers used by mark_screenshot_highlight_elements (draw path)
 */

// ---------------------------------------------------------------------------
//  1.  DOM label hook  (injected into the page via execute_script)
// ---------------------------------------------------------------------------

/**
 * Call via execute_script BEFORE run_build_dom_tree.
 * It installs `window.__eko_styleHighlightLabel(label, element, baseColor,
 * top, left, rect, parentIframe)` which build_dom_tree.ts will call when
 * present instead of its own default label styling / positioning.
 */

/**
 * Wrapper invoked via `execute_script` from browser_labels.ts after the
 * DOM/a11y tree has been built but before the screenshot is captured.
 * Returns the list of highlightIndex values whose elements no longer
 * match the snapshot rect (closed/animated-away/drifted) so the caller
 * can mark them `noDraw=true` in `area_map`.
 *
 * Safe no-op if the hook hasn't been installed (i.e. legacy label style).
 */
export function run_revalidate_area_map(params: {
  areaMap: { [k: string]: { x: number; y: number; width: number; height: number } };
  threshold?: number;
  debug?: boolean;
}): { stale: number[]; reasons?: { [k: string]: string } } {
  const fn = (window as any).__eko_revalidateAreaMap;
  if (typeof fn !== 'function') return { stale: [] };
  try {
    return fn(params) || { stale: [] };
  } catch (e) {
    console.warn('[run_revalidate_area_map] hook threw:', e);
    return { stale: [] };
  }
}

export function run_install_noocclude_label_hook() {
  // Track placed label positions for collision avoidance across elements
  const placedLabels: { t: number; l: number; w: number; h: number }[] = [];
  (window as any).__eko_placedLabels = placedLabels;
  // Track ALL annotated element rects so the spiral search can avoid landing
  // a displaced pill on top of an unrelated element (e.g., a sibling tag in
  // the same dense row).
  const placedElements: { t: number; l: number; w: number; h: number }[] = [];
  (window as any).__eko_placedElements = placedElements;

  // Shared SVG overlay used to draw cartographic-style leader lines from a
  // displaced pill back to its element. Created lazily so we don't pollute
  // pages that never need it.
  let leaderSvg: SVGSVGElement | null = null;
  const ensureLeaderSvg = (): SVGSVGElement => {
    if (leaderSvg && document.body.contains(leaderSvg)) return leaderSvg;
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
    svg.setAttribute('id', '__eko_leader_svg');
    svg.style.position = 'fixed';
    svg.style.top = '0';
    svg.style.left = '0';
    svg.style.width = '100vw';
    svg.style.height = '100vh';
    svg.style.pointerEvents = 'none';
    svg.style.zIndex = '2147483646'; // just below the labels themselves
    document.body.appendChild(svg);
    leaderSvg = svg;
    return svg;
  };
  (window as any).__eko_clearLeaders = () => {
    if (leaderSvg) leaderSvg.replaceChildren();
  };

  // ----------------------------------------------------------------------
  // Deferred-label queue for the cartographic-legend pass.
  // When an element is in a dense cluster, we DON'T place its pill inline
  // (where it would either overlap a neighbour or stack with other pills
  // searching for the same scarce empty whitespace). Instead, we record
  // the pill + its anchor in this queue, and a single finalize step runs
  // after all elements are processed:
  //   1. Group deferred pills into spatial clusters.
  //   2. For each cluster, pick the gutter with the most empty space
  //      (left/right/above/below).
  //   3. Stack the cluster's pills in source-reading order in that gutter.
  //   4. Draw leader lines from each pill to its element centre.
  // ----------------------------------------------------------------------
  type DeferredPill = {
    label: HTMLElement;
    color: string;
    elL: number; elT: number; elW: number; elH: number;
    labelW: number; labelH: number;
  };
  const deferredPills: DeferredPill[] = [];
  (window as any).__eko_deferredPills = deferredPills;

  (window as any).__eko_finalizeDeferredLabels = function () {
    if (deferredPills.length === 0) return;
    const VW = window.innerWidth;
    const VH = window.innerHeight;

    // ---- 1. Cluster deferred pills by spatial proximity --------------
    //   Two pills are in the same cluster if their element centres are
    //   within `clusterDist` px of each other. Standard union-find.
    const clusterDist = 120;
    const parent = deferredPills.map((_, i) => i);
    const find = (x: number): number => parent[x] === x ? x : (parent[x] = find(parent[x]));
    const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    for (let i = 0; i < deferredPills.length; i++) {
      const a = deferredPills[i];
      const ax = a.elL + a.elW / 2;
      const ay = a.elT + a.elH / 2;
      for (let j = i + 1; j < deferredPills.length; j++) {
        const b = deferredPills[j];
        const bx = b.elL + b.elW / 2;
        const by = b.elT + b.elH / 2;
        const dx = ax - bx;
        const dy = ay - by;
        if (dx * dx + dy * dy < clusterDist * clusterDist) union(i, j);
      }
    }
    const clusters = new Map<number, DeferredPill[]>();
    for (let i = 0; i < deferredPills.length; i++) {
      const r = find(i);
      if (!clusters.has(r)) clusters.set(r, []);
      clusters.get(r)!.push(deferredPills[i]);
    }

    // Helper: count how many placedElements fall inside a rect.
    const occupiedScore = (l: number, t: number, w: number, h: number): number => {
      let count = 0;
      for (const e of placedElements) {
        const ix = Math.max(0, Math.min(l + w, e.l + e.w) - Math.max(l, e.l));
        const iy = Math.max(0, Math.min(t + h, e.t + e.h) - Math.max(t, e.t));
        if (ix > 0 && iy > 0) count += ix * iy;
      }
      return count;
    };

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const svg = ensureLeaderSvg();

    // ---- 2. For each cluster, find a gutter and lay out pills --------
    for (const [, members] of clusters) {
      // Cluster bounding box (of elements, not pills).
      let minL = Infinity, minT = Infinity, maxR = -Infinity, maxB = -Infinity;
      for (const m of members) {
        if (m.elL < minL) minL = m.elL;
        if (m.elT < minT) minT = m.elT;
        if (m.elL + m.elW > maxR) maxR = m.elL + m.elW;
        if (m.elT + m.elH > maxB) maxB = m.elT + m.elH;
      }
      const cBoxW = maxR - minL;
      const cBoxH = maxB - minT;
      const cCx = (minL + maxR) / 2;
      const cCy = (minT + maxB) / 2;

      // Pill stack metrics.
      const stackGap = 4;
      // Use the widest/tallest pill in the cluster as the column width.
      let pillW = 0, pillH = 0;
      for (const m of members) {
        if (m.labelW > pillW) pillW = m.labelW;
        if (m.labelH > pillH) pillH = m.labelH;
      }
      const totalStackH = members.length * pillH + (members.length - 1) * stackGap;
      const totalStackW = members.length * pillW + (members.length - 1) * stackGap;

      // ---- 3. Evaluate 4 gutter candidates: right, left, below, above
      const gutterMargin = 12;
      const colsW = pillW + 6;
      const rowsH = pillH + 6;
      const candidates: Array<{
        side: 'right' | 'left' | 'below' | 'above';
        l: number; t: number; w: number; h: number;
        score: number;
      }> = [];

      // Vertical gutters (right/left): need to fit totalStackH vertically.
      const vTop = Math.max(gutterMargin, Math.min(cCy - totalStackH / 2, VH - totalStackH - gutterMargin));
      const rightL = Math.min(VW - colsW - gutterMargin, maxR + gutterMargin);
      const leftL = Math.max(gutterMargin, minL - gutterMargin - colsW);
      if (rightL > maxR) {
        candidates.push({ side: 'right', l: rightL, t: vTop, w: colsW, h: totalStackH, score: 0 });
      }
      if (leftL + colsW < minL) {
        candidates.push({ side: 'left', l: leftL, t: vTop, w: colsW, h: totalStackH, score: 0 });
      }
      // Horizontal gutters (below/above): fit totalStackW horizontally.
      const hLeft = Math.max(gutterMargin, Math.min(cCx - totalStackW / 2, VW - totalStackW - gutterMargin));
      const belowT = Math.min(VH - rowsH - gutterMargin, maxB + gutterMargin);
      const aboveT = Math.max(gutterMargin, minT - gutterMargin - rowsH);
      if (belowT > maxB) {
        candidates.push({ side: 'below', l: hLeft, t: belowT, w: totalStackW, h: rowsH, score: 0 });
      }
      if (aboveT + rowsH < minT) {
        candidates.push({ side: 'above', l: hLeft, t: aboveT, w: totalStackW, h: rowsH, score: 0 });
      }

      if (candidates.length === 0) continue; // nothing fits, skip

      // Score each gutter: lower is better. Prefer empty space + closeness.
      for (const c of candidates) {
        const occ = occupiedScore(c.l, c.t, c.w, c.h);
        // Distance from gutter centre to cluster centre (shorter = better).
        const gcx = c.l + c.w / 2;
        const gcy = c.t + c.h / 2;
        const dx = gcx - cCx;
        const dy = gcy - cCy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        c.score = occ * 0.05 + dist * 0.5;
        // Prefer right gutter slightly (matches reading flow); break ties.
        if (c.side === 'right') c.score -= 4;
      }
      candidates.sort((a, b) => a.score - b.score);
      const gutter = candidates[0];

      // ---- 4. Sort pills in reading order and lay out in the gutter ---
      const isVertical = gutter.side === 'right' || gutter.side === 'left';
      // Reading order: top-to-bottom for vertical gutters (so leaders don't
      // crisscross), left-to-right for horizontal.
      members.sort((a, b) => {
        if (isVertical) {
          const ay = a.elT + a.elH / 2;
          const by = b.elT + b.elH / 2;
          return ay - by;
        } else {
          const ax = a.elL + a.elW / 2;
          const bx = b.elL + b.elW / 2;
          return ax - bx;
        }
      });

      // Place each pill and draw its leader.
      members.forEach((m, idx) => {
        let pillL: number, pillT: number;
        if (isVertical) {
          pillL = gutter.l + Math.round((gutter.w - m.labelW) / 2);
          pillT = gutter.t + idx * (pillH + stackGap);
        } else {
          pillL = gutter.l + idx * (pillW + stackGap);
          pillT = gutter.t + Math.round((gutter.h - m.labelH) / 2);
        }
        // Reveal and position the pill.
        m.label.style.display = '';
        m.label.style.top = `${pillT}px`;
        m.label.style.left = `${pillL}px`;
        placedLabels.push({ t: pillT, l: pillL, w: m.labelW, h: m.labelH });

        // Draw leader from element centre to pill side facing the element.
        try {
          const ex = m.elL + m.elW / 2;
          const ey = m.elT + m.elH / 2;
          const pCx = pillL + m.labelW / 2;
          const pCy = pillT + m.labelH / 2;
          const dx = ex - pCx;
          const dy = ey - pCy;
          let pAnchorX = pCx;
          let pAnchorY = pCy;
          if (Math.abs(dx) * m.labelH > Math.abs(dy) * m.labelW) {
            pAnchorX = dx > 0 ? pillL + m.labelW : pillL;
            pAnchorY = pCy + dy * (m.labelW / 2) / Math.max(1, Math.abs(dx));
          } else {
            pAnchorX = pCx + dx * (m.labelH / 2) / Math.max(1, Math.abs(dy));
            pAnchorY = dy > 0 ? pillT + m.labelH : pillT;
          }
          // Leader colour: amber (or deep magenta if pill switched to cyan).
          const leaderColor = m.color === '#FF00FF' ? '#FF8C00' : '#C71585';
          const line = document.createElementNS(SVG_NS, 'line');
          line.setAttribute('x1', String(ex));
          line.setAttribute('y1', String(ey));
          line.setAttribute('x2', String(pAnchorX));
          line.setAttribute('y2', String(pAnchorY));
          line.setAttribute('stroke', leaderColor);
          line.setAttribute('stroke-width', '1');
          line.setAttribute('stroke-dasharray', '3,2');
          line.setAttribute('opacity', '0.75');
          const dot = document.createElementNS(SVG_NS, 'circle');
          dot.setAttribute('cx', String(ex));
          dot.setAttribute('cy', String(ey));
          dot.setAttribute('r', '2.5');
          dot.setAttribute('fill', leaderColor);
          dot.setAttribute('fill-opacity', '0.55');
          dot.setAttribute('stroke', leaderColor);
          dot.setAttribute('stroke-width', '1');
          dot.setAttribute('stroke-opacity', '0.9');
          svg.appendChild(line);
          svg.appendChild(dot);
        } catch (_e) { /* best-effort */ }
      });

      // Suppress dotted bounding-box outlines for clustered elements: their
      // boxes were the source of visual clutter. Leader-line + centre dot
      // is enough to identify them. Mark via data attribute so the overlay
      // styler can read it.
      // (Implemented in __eko_styleHighlightOverlay if installed.)
      // For now we just rely on the leader to identify the element; the
      // overlay border still draws but it's the same colour as the rest.
    }
  };
  (window as any).__eko_clearDeferredPills = () => {
    deferredPills.length = 0;
  };

  // ----------------------------------------------------------------------
  // Redundant-label detection hook.
  //
  // Called by build_dom_tree.ts/create_area_map for every element about to
  // be added to area_map. Returning `true` causes the caller to set
  // `noDraw: true` on the area_map entry, which both render paths
  // (canvas + DOM overlay) interpret as "keep this entry in the agent's
  // structured element list, but skip ALL visual annotation".
  //
  // Lives here (rather than inline in build_dom_tree.ts) so that the
  // build_dom_tree.ts diff vs. upstream eko stays a single 3-line hook
  // call, minimising merge conflicts during future upstream syncs.
  //
  // Suppression rule: a `<label>` whose visible box wraps another
  // already-highlighted control. Three ways to detect that:
  //   (a) `for="ctrl-id"` attribute pointing at a highlighted element
  //       (resolved via `ownerDocument.getElementById`, which does NOT
  //       pierce shadow roots — labels split across shadow boundaries
  //       are matched by rule (b) instead).
  //   (b) The label contains a highlighted descendant input/select/
  //       textarea/button or `[role=textbox|combobox|button]`.
  //   (c) The label has no `for=` and no descendant control, but its
  //       immediate parent contains exactly one highlighted control as
  //       a sibling (the common `<div class="form-group"><label>X</label>
  //       <input/></div>` pattern). The label is implicitly captioning
  //       that sibling control, so its highlight is redundant.
  // The set of "highlighted elements" is supplied by the caller as a
  // pre-pass (see build_dom_tree.ts) and passed in as the second arg.
  (window as any).__eko_isRedundantLabel = function (
    element: Element,
    highlightedElements: Set<Element>,
  ): boolean {
    if (!element || !element.tagName) return false;
    const tag = element.tagName.toLowerCase();
    if (tag !== 'label') return false;
    // (a) for="ctrl-id" → ctrl is highlighted.
    const forId = (element as HTMLLabelElement).getAttribute && element.getAttribute('for');
    if (forId) {
      const target = element.ownerDocument && element.ownerDocument.getElementById(forId);
      if (target && highlightedElements.has(target)) return true;
    }
    // (b) Descendant control is highlighted.
    const CONTROL_SELECTOR = 'input,select,textarea,button,[role=textbox],[role=combobox],[role=button]';
    const descendants = element.querySelectorAll
      ? element.querySelectorAll(CONTROL_SELECTOR)
      : null;
    if (descendants) {
      for (let i = 0; i < descendants.length; i++) {
        if (highlightedElements.has(descendants[i])) return true;
      }
    }
    // (c) Sibling-control rule: parent has exactly one highlighted
    //     control among its descendants and this label has none.
    const parent = element.parentElement;
    if (parent && parent.querySelectorAll) {
      const siblingControls = parent.querySelectorAll(CONTROL_SELECTOR);
      let highlightedSiblingCount = 0;
      let lastHighlighted: Element | null = null;
      for (let i = 0; i < siblingControls.length; i++) {
        const c = siblingControls[i];
        // Must not be a descendant of the label itself (we already
        // checked that branch in rule (b)).
        if (element.contains(c)) continue;
        if (highlightedElements.has(c)) {
          highlightedSiblingCount++;
          lastHighlighted = c;
          if (highlightedSiblingCount > 1) break;
        }
      }
      if (highlightedSiblingCount === 1 && lastHighlighted) return true;
    }
    return false;
  };

  // ---------------------------------------------------------------------
  // Stale-rect revalidation hook (noocclude only).
  //
  // Called from browser_labels.ts AFTER the DOM tree / a11y tree has been
  // built but BEFORE the screenshot is captured. The DOM-build pass can
  // race with action-induced animations (e.g. modal close after
  // select_option/save) — bounding rects are sampled at T0 while the
  // screenshot is taken at T0 + ~200ms, so by capture time some elements
  // have faded out, scaled away, or detached from the DOM. Without
  // revalidation, mark_screenshot_highlight_elements still draws their
  // boxes/pills in empty space.
  //
  // For each highlighted element we re-check at "screenshot time":
  //   • element still attached to the document
  //   • effective opacity (ancestor-chain product) >= 0.1
  //   • computed visibility !== 'hidden' (display:none → zero rect)
  //   • current rect has positive width/height
  //   • current rect close to the snapshot rect (drift <= threshold)
  // Any failure marks that index as stale; the caller sets
  // area_map[index].noDraw = true so both render paths skip annotation.
  //
  // Returns: { stale: number[], reasons?: { [idx]: string } }
  (window as any).__eko_revalidateAreaMap = function (
    params: { areaMap: { [k: string]: { x: number; y: number; width: number; height: number } }; threshold?: number; debug?: boolean },
  ): { stale: number[]; reasons?: { [k: string]: string } } {
    const areaMap = params && params.areaMap ? params.areaMap : {};
    const threshold = typeof params?.threshold === 'number' ? params.threshold : 8;
    const wantReasons = !!params?.debug;
    const stale: number[] = [];
    const reasons: { [k: string]: string } = {};
    const clickable = (window as any).clickable_elements || {};

    function effectiveOpacity(el: Element | null): number {
      let acc = 1;
      let cur: Element | null = el;
      let hops = 0;
      while (cur && hops < 32) {
        const cs = window.getComputedStyle(cur as Element);
        const o = parseFloat(cs.opacity);
        if (!isNaN(o)) acc *= o;
        if (acc < 0.05) return acc;
        cur = cur.parentElement;
        hops++;
      }
      return acc;
    }

    const keys = Object.keys(areaMap);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const idx = Number(key);
      const snap = areaMap[key];
      if (!snap) continue;
      const el: Element | undefined = clickable[idx];
      if (!el) {
        stale.push(idx);
        if (wantReasons) reasons[key] = 'no-element';
        continue;
      }
      const ownerDoc = (el as any).ownerDocument || document;
      if (!ownerDoc.contains || !ownerDoc.contains(el)) {
        stale.push(idx);
        if (wantReasons) reasons[key] = 'detached';
        continue;
      }
      const cs = window.getComputedStyle(el as Element);
      if (cs.visibility === 'hidden' || cs.display === 'none') {
        stale.push(idx);
        if (wantReasons) reasons[key] = 'css-hidden';
        continue;
      }
      if (effectiveOpacity(el) < 0.1) {
        stale.push(idx);
        if (wantReasons) reasons[key] = 'opacity';
        continue;
      }
      const r = (el as Element).getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) {
        stale.push(idx);
        if (wantReasons) reasons[key] = 'zero-rect';
        continue;
      }
      const dx = Math.abs(r.left - snap.x);
      const dy = Math.abs(r.top - snap.y);
      const dw = Math.abs(r.width - snap.width);
      const dh = Math.abs(r.height - snap.height);
      if (dx > threshold || dy > threshold || dw > threshold || dh > threshold) {
        stale.push(idx);
        if (wantReasons) reasons[key] = `drift dx=${dx.toFixed(1)} dy=${dy.toFixed(1)} dw=${dw.toFixed(1)} dh=${dh.toFixed(1)}`;
        continue;
      }
    }
    return wantReasons ? { stale, reasons } : { stale };
  };

  (window as any).__eko_styleHighlightLabel = function (
    label: HTMLElement,
    element: Element,
    baseColor: string,
    top: number,
    left: number,
    rect: DOMRect,
    parentIframe: HTMLIFrameElement | null
  ) {
    // Skip zero-area or fully off-screen elements
    if (rect.width <= 0 || rect.height <= 0) { label.style.display = 'none'; return; }
    if (rect.bottom < 0 || rect.top > window.innerHeight ||
        rect.right < 0 || rect.left > window.innerWidth) { label.style.display = 'none'; return; }

    // Register this element's rect so other elements' spiral searches will
    // treat it as occupied space. Skip if an upstream caller already
    // pre-populated this rect (e.g. injectDomHighlightOverlays seeds the
    // tracker from areaMap so first-pass elements see the full cluster).
    const rectAlreadyTracked = placedElements.some(e =>
      e.t === top && e.l === left && e.w === rect.width && e.h === rect.height
    );
    if (!rectAlreadyTracked) {
      placedElements.push({ t: top, l: left, w: rect.width, h: rect.height });
    }

    // --- Contrast-adaptive color: check if the element's background is magenta-ish ---
    let annotationColor = '#FF00FF';
    try {
      const bgColor = window.getComputedStyle(element).backgroundColor;
      const match = bgColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (match) {
        const r = parseInt(match[1]), g = parseInt(match[2]), b = parseInt(match[3]);
        // If background is magenta-ish (high R, low G, high B), switch to cyan
        if (r > 180 && g < 100 && b > 180) {
          annotationColor = '#00FFFF';
        }
      }
    } catch (_e) { /* keep magenta */ }

    // --- Style: compact high-contrast pill (white bg, bold magenta text, magenta border).
    //     Footprint kept minimal so labels occlude as little real content as
    //     possible while remaining LLM-legible.
    label.style.background = '#FFFFFF';
    label.style.color = annotationColor;
    label.style.fontWeight = '900';
    label.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    label.style.border = `1px solid ${annotationColor}`;
    label.style.borderRadius = '2px';
    label.style.padding = '0px 2px';
    label.style.lineHeight = '1';
    label.style.boxShadow = '0 0 0 1px rgba(0,0,0,0.4)';
    label.style.textShadow = 'none';
    label.style.letterSpacing = '0';

    // --- Compact font size (10–12px) ---
    const fontSize = Math.min(12, Math.max(10, rect.height / 2));
    label.style.fontSize = `${fontSize}px`;

    // --- Position: prefer placements that occlude no real content. ---
    // Estimate label box from actual text (accounts for 2- or 3-digit ids).
    // Monospace digit ≈ 0.6 * fontSize wide; +4px horiz (padding+border), +4px vert.
    const labelText = label.textContent || '';
    const labelWidth = Math.max(16, Math.ceil(labelText.length * fontSize * 0.6) + 6);
    const labelHeight = Math.ceil(fontSize + 4);
    const pad = 1;
    const outsideGap = 2;

    // Outside placements occlude nothing (only sibling space). Evaluate many
    // directional slots; the scoring loop below picks the best fit based on
    // visual complexity + overlap + clearance (not hardcoded direction bias).
    const topOutsideCandidates = [
      { t: top - labelHeight - outsideGap, l: left + rect.width - labelWidth },                 // above-right
      { t: top - labelHeight - outsideGap, l: left + (rect.width - labelWidth) / 2 },           // above-center
      { t: top - labelHeight - outsideGap, l: left },                                           // above-left
    ];
    const bottomOutsideCandidates = [
      { t: top + rect.height + outsideGap, l: left + rect.width - labelWidth },                 // below-right
      { t: top + rect.height + outsideGap, l: left + (rect.width - labelWidth) / 2 },           // below-center
      { t: top + rect.height + outsideGap, l: left },                                           // below-left
    ];
    const sideOutsideCandidates = [
      { t: top, l: left + rect.width + outsideGap },                                            // right-top
      { t: top + (rect.height - labelHeight) / 2, l: left + rect.width + outsideGap },          // right-middle
      { t: top + rect.height - labelHeight, l: left + rect.width + outsideGap },                 // right-bottom
      { t: top, l: left - labelWidth - outsideGap },                                            // left-top
      { t: top + (rect.height - labelHeight) / 2, l: left - labelWidth - outsideGap },          // left-middle
      { t: top + rect.height - labelHeight, l: left - labelWidth - outsideGap },                 // left-bottom
    ];
    const outsideCandidates = [...topOutsideCandidates, ...bottomOutsideCandidates, ...sideOutsideCandidates];
    // Inside placements are last-resort; always corners (never center) to
    // minimize chance of covering real content.
    const insideCandidates = [
      { t: top + pad, l: left + rect.width - labelWidth - pad, inside: true },                  // top-right
      { t: top + pad, l: left + pad, inside: true },                                            // top-left
      { t: top + rect.height - labelHeight - pad, l: left + rect.width - labelWidth - pad, inside: true }, // bottom-right
      { t: top + rect.height - labelHeight - pad, l: left + pad, inside: true },                // bottom-left
    ];
    const candidates: { t: number; l: number; inside?: boolean }[] = [
      ...outsideCandidates,
      ...insideCandidates,
    ];

    let bestCandidate = candidates[0];
    let bestScore = Infinity;
    let bestChildOverlaps = 0;
    let bestIsInside = false;
    let bestOccupiedHits = 0;
    let bestElementOverlap = false; // candidate overlaps a non-source element rect
    const children = element.querySelectorAll
      ? Array.from(element.querySelectorAll('*')).slice(0, 50)
      : [];
    const sourceElement = element as HTMLElement;

    // Probe whether a candidate label box sits on top of real page elements.
    // This catches overlap with neighboring interactive elements even if they
    // have not yet been processed into placedElements.
    const probeOccupiedHits = (cl: number, ct: number, cr: number, cb: number): number => {
      const sx = [cl + 1, (cl + cr) / 2, cr - 1];
      const sy = [ct + 1, (ct + cb) / 2, cb - 1];
      let hits = 0;
      for (const x of sx) {
        for (const y of sy) {
          if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) continue;
          try {
            const stack = document.elementsFromPoint(x, y);
            const topReal = stack.find((el) => {
              const node = el as HTMLElement;
              if (!node) return false;
              if (node === label || node === sourceElement || sourceElement.contains(node)) return false;
              if (node.id === 'eko-highlight-container' || node.id === '__eko_leader_svg') return false;
              if (node.closest('#eko-highlight-container') || node.closest('#__eko_leader_svg')) return false;
              return true;
            });
            if (topReal) hits++;
          } catch (_e) {
            // ignore probing failures
          }
        }
      }
      return hits;
    };

    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      const isInside = !!cand.inside;
      const cl = cand.l;
      const ct = cand.t;
      const cr = cand.l + labelWidth;
      const cb = cand.t + labelHeight;

      let score = 0;
      // Tiny stable bias toward earlier candidates; kept very small so it
      // only breaks ties and does not dominate emptiness scoring.
      score += i * 0.02;

      // Heavy penalty for going off-viewport — but lower than worst-case child overlap
      // so a small clipping is preferred over covering lots of content.
      if (cl < 0 || ct < 0 || cr > window.innerWidth || cb > window.innerHeight) {
        score += 200;
      }

      // Inside placement: lighter penalty when the element is large enough
      // to comfortably host the pill in a corner without occluding content.
      // For big form fields (TITLE, DESCRIPTION, dropdowns) a clean inside
      // corner is much clearer than displacing far away with a leader line.
      const hasInsideRoom = rect.width >= labelWidth * 2.2 && rect.height >= labelHeight * 1.6;
      if (isInside) {
        score += hasInsideRoom ? 8 : 100;
      }

      // Per-child overlap penalty (only meaningful for inside placements).
      let childOverlaps = 0;
      for (const child of children) {
        try {
          const cr2 = (child as HTMLElement).getBoundingClientRect();
          if (cr2.width === 0 && cr2.height === 0) continue;
          const childLeft = cr2.left + (parentIframe ? parentIframe.getBoundingClientRect().left : 0);
          const childTop = cr2.top + (parentIframe ? parentIframe.getBoundingClientRect().top : 0);
          if (cl < childLeft + cr2.width && cr > childLeft && ct < childTop + cr2.height && cb > childTop) {
            childOverlaps++;
          }
        } catch (_e) { /* skip */ }
      }
      score += childOverlaps * 50; // each occluded child is costly

      // Penalize overlap with already-known element rects (excluding source
      // element). This pushes labels into truly empty regions.
      const sourceL = left;
      const sourceT = top;
      const sourceR = left + rect.width;
      const sourceB = top + rect.height;
      let candElementOverlap = false;
      for (const e of placedElements) {
        const eL = e.l;
        const eT = e.t;
        const eR = e.l + e.w;
        const eB = e.t + e.h;
        const isSource = eL === sourceL && eT === sourceT && eR === sourceR && eB === sourceB;
        if (isSource) continue;
        const ix = Math.max(0, Math.min(cr, eR) - Math.max(cl, eL));
        const iy = Math.max(0, Math.min(cb, eB) - Math.max(ct, eT));
        if (ix > 0 && iy > 0) {
          const overlapRatio = (ix * iy) / Math.max(1, labelWidth * labelHeight);
          score += 300 + overlapRatio * 2000;
          candElementOverlap = true;
        }
      }

      // Strong penalty when sampling says this candidate is visually on top of
      // other real UI (e.g. neighboring avatars BM / DK / FL in the toolbar).
      const occupiedHits = probeOccupiedHits(cl, ct, cr, cb);
      score += occupiedHits * 250;

      // Penalize being too close to existing labels/elements even without
      // geometric overlap, to avoid visually ambiguous clusters.
      const desiredGap = 6;
      const gapPenaltyFromRect = (aL: number, aT: number, aR: number, aB: number) => {
        const dx = Math.max(0, Math.max(aL - cr, cl - aR));
        const dy = Math.max(0, Math.max(aT - cb, ct - aB));
        const gap = Math.sqrt(dx * dx + dy * dy);
        return gap < desiredGap ? (desiredGap - gap) * 6 : 0;
      };
      for (const p of placedLabels) {
        score += gapPenaltyFromRect(p.l, p.t, p.l + p.w, p.t + p.h);
      }
      for (const e of placedElements) {
        const eL = e.l;
        const eT = e.t;
        const eR = e.l + e.w;
        const eB = e.t + e.h;
        const isSource = eL === sourceL && eT === sourceT && eR === sourceR && eB === sourceB;
        if (isSource) continue;
        score += gapPenaltyFromRect(eL, eT, eR, eB);
      }

      // Penalize collision with already-placed labels (label-to-label avoidance).
      for (const placed of placedLabels) {
        if (cl < placed.l + placed.w && cr > placed.l && ct < placed.t + placed.h && cb > placed.t) {
          score += 30;
        }
      }

      if (score < bestScore) {
        bestScore = score;
        bestCandidate = cand;
        bestChildOverlaps = childOverlaps;
        bestIsInside = isInside;
        bestOccupiedHits = occupiedHits;
        bestElementOverlap = candElementOverlap;
      }
    }

    let labelTop = bestCandidate.t;
    let labelLeft = bestCandidate.l;
    let usedLeader = false;

    // ----------------------------------------------------------------------
    // Cartographic callout: if the local placement is "bad" — collides with
    // another label or has to sit over real content — search outward for an
    // empty whitespace slot and connect with a dotted leader line.
    // ----------------------------------------------------------------------
    const buffer = 4; // treat anything within 4px of another label as a collision
    const localCollidesLabel = placedLabels.some(p =>
      labelLeft < p.l + p.w + buffer && labelLeft + labelWidth + buffer > p.l &&
      labelTop  < p.t + p.h + buffer && labelTop  + labelHeight + buffer > p.t
    );
    const isSmallElement = rect.width < 80 || rect.height < 40;
    // Has another label been placed close to this element? If so, the
    // resulting cluster is confusing even if no exact collision occurs.
    const proximity = 28;
    const labelsNearby = placedLabels.filter(p =>
      p.l < left + rect.width + proximity && p.l + p.w + proximity > left &&
      p.t < top + rect.height + proximity && p.t + p.h + proximity > top
    );
    // Density score: count of OTHER annotated element rects whose centers
    // sit within densityRadius of this element's center. When this is high,
    // the local area is too crowded to find a sensible nearby slot — we
    // route the pill far away into macro-whitespace via the callout.
    const densityRadius = 90;
    const srcCx = left + rect.width / 2;
    const srcCy = top + rect.height / 2;
    let densityCount = 0;
    let densityCxSum = 0, densityCySum = 0;
    for (const e of placedElements) {
      const ecx = e.l + e.w / 2;
      const ecy = e.t + e.h / 2;
      if (ecx === srcCx && ecy === srcCy) continue; // skip self
      const dx = ecx - srcCx;
      const dy = ecy - srcCy;
      if (dx * dx + dy * dy < densityRadius * densityRadius) {
        densityCount++;
        densityCxSum += ecx;
        densityCySum += ecy;
      }
    }
    const isDense = densityCount >= 3;
    // Compute centroid of nearby labels — we'll bias the spiral to fan AWAY
    // from this point so each cluster member radiates in its own direction
    // and leader lines don't crisscross.
    let clusterCx = left + rect.width / 2;
    let clusterCy = top + rect.height / 2;
    if (labelsNearby.length > 0) {
      let sx = 0, sy = 0;
      for (const p of labelsNearby) {
        sx += p.l + p.w / 2;
        sy += p.t + p.h / 2;
      }
      clusterCx = sx / labelsNearby.length;
      clusterCy = sy / labelsNearby.length;
    }
    // For dense regions, override the cluster centroid with the centroid of
    // surrounding ELEMENTS (not just labels) so the outward fan points away
    // from the actual visual cluster.
    if (isDense) {
      clusterCx = densityCxSum / densityCount;
      clusterCy = densityCySum / densityCount;
    }
    // A "clean" inside placement is one that doesn't overlap any child
    // element of the source or any neighbouring annotated element — i.e. the
    // pill sits in genuine whitespace inside the source rect (e.g. the empty
    // corner of a TITLE input or DESCRIPTION text-area). These are PREFERRED
    // over outside callouts because the index unambiguously belongs to the
    // surrounding rectangle.
    const bestIsCleanInside = bestIsInside && bestChildOverlaps === 0 &&
      bestOccupiedHits === 0 && !bestElementOverlap;
    const needsCallout =
      localCollidesLabel ||
      (bestIsInside && !bestIsCleanInside) ||  // inside only escapes when dirty
      (isSmallElement && labelsNearby.length >= 1) ||
      isDense;          // dense region: force a far-away callout

    // ----------------------------------------------------------------------
    // Cluster-legend deferral: when an element is in a dense cluster, don't
    // even attempt a per-element spiral. Defer placement to the post-pass
    // legend layout (__eko_finalizeDeferredLabels) which will pick a single
    // gutter region for the whole cluster and stack pills in reading order.
    // This cleanly handles dense rows of tag pills, toolbar icons, etc.
    // ----------------------------------------------------------------------
    if (isDense) {
      // Hide the pill for now; finalize step will reveal & position it.
      label.style.display = 'none';
      deferredPills.push({
        label,
        color: annotationColor,
        elL: left, elT: top, elW: rect.width, elH: rect.height,
        labelW: labelWidth, labelH: labelHeight,
      });
      return; // skip the inline placement entirely
    }

    if (needsCallout) {
      // Anchor = element center.
      const ax = left + rect.width / 2;
      const ay = top + rect.height / 2;
      // Direction "away from the cluster centroid" — start the spiral here
      // so neighbouring elements naturally diverge.
      const dxAway = ax - clusterCx;
      const dyAway = ay - clusterCy;
      const startAngle = (dxAway === 0 && dyAway === 0)
        ? -Math.PI / 2 // default: above the element
        : Math.atan2(dyAway, dxAway);
      // Spiral search: expanding rings around the anchor.
      const ringStep = Math.max(labelHeight + 4, 18);
      const angleStep = Math.PI / 12; // 24 directions per ring
      let foundT = labelTop;
      let foundL = labelLeft;
      let foundOk = false;
      const maxRing = 24;
      // Start at least one ringStep away from the element's outer edge so the
      // pill clearly sits in surrounding whitespace. In dense regions, jump
      // FAR out — past the local cluster — so the pill lands in real macro
      // whitespace rather than glued to a neighbouring small element.
      // Density-aware extra radius scales with how crowded the area is.
      const denseExtra = isDense
        ? Math.max(80, Math.min(220, 40 + densityCount * 22))
        : 0;
      const baseRadius = Math.max(rect.width, rect.height) / 2 + ringStep + denseExtra;
      for (let ring = 1; ring <= maxRing && !foundOk; ring++) {
        const r = baseRadius + (ring - 1) * ringStep;
        // Visit angles in order of increasing deviation from startAngle so
        // we prefer the "outward" direction.
        for (let step = 0; step < 24 && !foundOk; step++) {
          // Alternating fan: 0, +1, -1, +2, -2, ...
          const halfStep = Math.floor((step + 1) / 2);
          const sign = step % 2 === 0 ? 1 : -1;
          const a = startAngle + sign * halfStep * angleStep;
          const cx = ax + Math.cos(a) * r;
          const cy = ay + Math.sin(a) * r;
          const tt = Math.round(cy - labelHeight / 2);
          const ll = Math.round(cx - labelWidth / 2);
          // Must be on-screen.
          if (ll < 2 || tt < 2 || ll + labelWidth > window.innerWidth - 2 || tt + labelHeight > window.innerHeight - 2) continue;
          // Must not overlap any element bounding box (source or sibling).
          let hitsElement = false;
          for (const e of placedElements) {
            if (ll < e.l + e.w && ll + labelWidth > e.l && tt < e.t + e.h && tt + labelHeight > e.t) {
              hitsElement = true;
              break;
            }
          }
          if (hitsElement) continue;
          // Must not collide with any other already-placed label (with buffer).
          let collides = false;
          for (const p of placedLabels) {
            if (ll < p.l + p.w + buffer && ll + labelWidth + buffer > p.l &&
                tt < p.t + p.h + buffer && tt + labelHeight + buffer > p.t) {
              collides = true;
              break;
            }
          }
          if (collides) continue;
          foundT = tt;
          foundL = ll;
          foundOk = true;
        }
      }
      if (foundOk) {
        labelTop = foundT;
        labelLeft = foundL;
        usedLeader = true;
      } else if (isSmallElement || isDense) {
        // Spiral exhausted without finding empty whitespace. Rather than
        // staying at bestCandidate (which may overlap a neighbouring tag),
        // anchor inside the source element's centre with a leader so the
        // index unambiguously belongs to THIS element. The pill sits inside
        // the source rect (which we already know is the right one).
        labelTop = Math.round(top + rect.height / 2 - labelHeight / 2);
        labelLeft = Math.round(left + rect.width / 2 - labelWidth / 2);
        usedLeader = false; // pill is on the element, no leader needed
      }
    }

    // Clamp to viewport without snapping the label back over the element.
    labelTop = Math.max(0, Math.min(labelTop, window.innerHeight - labelHeight));
    labelLeft = Math.max(0, Math.min(labelLeft, window.innerWidth - labelWidth));

    label.style.top = `${labelTop}px`;
    label.style.left = `${labelLeft}px`;

    placedLabels.push({ t: labelTop, l: labelLeft, w: labelWidth, h: labelHeight });

    // Draw the leader line from the element center to the pill edge. Anchoring
    // at the geometric center (not the boundary) makes it unambiguous which
    // element a displaced index refers to — the line literally points into
    // the element rather than grazing its border.
    if (usedLeader) {
      try {
        const SVG_NS = 'http://www.w3.org/2000/svg';
        const svg = ensureLeaderSvg();
        // Anchor = element center.
        const ex = left + rect.width / 2;
        const ey = top + rect.height / 2;
        // Pill anchor on the side facing the element.
        const pillCx = labelLeft + labelWidth / 2;
        const pillCy = labelTop + labelHeight / 2;
        const dx = ex - pillCx;
        const dy = ey - pillCy;
        let pAnchorX = pillCx;
        let pAnchorY = pillCy;
        if (Math.abs(dx) * labelHeight > Math.abs(dy) * labelWidth) {
          // Hits left or right side
          pAnchorX = dx > 0 ? labelLeft + labelWidth : labelLeft;
          pAnchorY = pillCy + dy * (labelWidth / 2) / Math.max(1, Math.abs(dx));
        } else {
          pAnchorX = pillCx + dx * (labelHeight / 2) / Math.max(1, Math.abs(dy));
          pAnchorY = dy > 0 ? labelTop + labelHeight : labelTop;
        }
        // Leader-line color is intentionally DIFFERENT from the magenta
        // element-border color so the dotted callout lines don't blend
        // into the field-border dotted lines. Amber when the pill itself is
        // magenta, deep magenta when the pill switched to cyan (background
        // was already magenta-ish).
        const leaderColor = annotationColor === '#FF00FF' ? '#FF8C00' : '#C71585';
        const line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('x1', String(ex));
        line.setAttribute('y1', String(ey));
        line.setAttribute('x2', String(pAnchorX));
        line.setAttribute('y2', String(pAnchorY));
        line.setAttribute('stroke', leaderColor);
        line.setAttribute('stroke-width', '1');
        line.setAttribute('stroke-dasharray', '3,2');
        line.setAttribute('opacity', '0.75');
        // Translucent filled circle at the element CENTER — marks the anchor
        // without fully hiding any underlying glyph or icon.
        const dot = document.createElementNS(SVG_NS, 'circle');
        dot.setAttribute('cx', String(ex));
        dot.setAttribute('cy', String(ey));
        dot.setAttribute('r', '2.5');
        dot.setAttribute('fill', leaderColor);
        dot.setAttribute('fill-opacity', '0.55');
        dot.setAttribute('stroke', leaderColor);
        dot.setAttribute('stroke-width', '1');
        dot.setAttribute('stroke-opacity', '0.9');
        svg.appendChild(line);
        svg.appendChild(dot);
      } catch (_e) { /* leader is best-effort */ }
    }

    // When forced inside over real content, fade the pill so the underlying
    // text remains readable; outside placements stay fully opaque. Pills with
    // a leader line are always fully opaque (they're in whitespace anyway).
    let opacity = 1.0;
    if (!usedLeader && bestIsInside && bestChildOverlaps > 0) {
      opacity = Math.max(0.55, 1.0 - bestChildOverlaps * 0.15);
    }
    label.style.opacity = String(opacity);
  };

  // Hook for overlay (bounding box) styling: semi-transparent bold dotted border
  // Uses a fixed magenta colour so all bounding boxes share one consistent
  // annotation colour that is easy to distinguish from page content.
  (window as any).__eko_styleHighlightOverlay = function (
    overlay: HTMLElement,
    baseColor: string,
  ) {
    const annotationColor = '#FF00FF';
    overlay.style.border = `2px dotted ${annotationColor}80`;
    overlay.style.backgroundColor = 'transparent';
  };
}

// ---------------------------------------------------------------------------
//  2.  Canvas-drawing helpers  (used by mark_screenshot_highlight_elements)
// ---------------------------------------------------------------------------

/**
 * Compute the pixel-variance (visual complexity) of a rectangular region on
 * the canvas.  Lower value → more uniform / "empty" region.
 */
export function computeRegionComplexity(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | any,
  x: number,
  y: number,
  w: number,
  h: number,
  canvasWidth: number,
  canvasHeight: number,
): number {
  const sx = Math.max(0, Math.round(x));
  const sy = Math.max(0, Math.round(y));
  const sw = Math.min(Math.round(w), canvasWidth - sx);
  const sh = Math.min(Math.round(h), canvasHeight - sy);
  if (sw <= 0 || sh <= 0) return Infinity;
  try {
    const imageData = ctx.getImageData(sx, sy, sw, sh);
    const data = imageData.data;
    const pixelCount = sw * sh;
    if (pixelCount === 0) return Infinity;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    }
    const mean = sum / pixelCount;
    let variance = 0;
    for (let i = 0; i < data.length; i += 4) {
      const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      variance += (gray - mean) * (gray - mean);
    }
    return variance / pixelCount;
  } catch {
    return Infinity;
  }
}

/**
 * Find the least visually complex position for a label among several
 * candidate positions within / near a bounding box.
 */
export function findBestLabelPosition(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | any,
  area: { x: number; y: number; width: number; height: number },
  lw: number,
  lh: number,
  canvasWidth: number,
  canvasHeight: number,
): { x: number; y: number } {
  const pad = 1;
  const outsideGap = 2;
  // Outside placements occlude no real content; try many directions.
  const topOutsideC: { x: number; y: number; outside: boolean }[] = [
    { x: area.x + area.width - lw, y: area.y - lh - outsideGap, outside: true },
    { x: area.x + (area.width - lw) / 2, y: area.y - lh - outsideGap, outside: true },
    { x: area.x, y: area.y - lh - outsideGap, outside: true },
  ];
  const bottomOutsideC: { x: number; y: number; outside: boolean }[] = [
    { x: area.x + area.width - lw, y: area.y + area.height + outsideGap, outside: true },
    { x: area.x + (area.width - lw) / 2, y: area.y + area.height + outsideGap, outside: true },
    { x: area.x, y: area.y + area.height + outsideGap, outside: true },
  ];
  const sideOutsideC: { x: number; y: number; outside: boolean }[] = [
    { x: area.x + area.width + outsideGap, y: area.y, outside: true },
    { x: area.x + area.width + outsideGap, y: area.y + (area.height - lh) / 2, outside: true },
    { x: area.x + area.width + outsideGap, y: area.y + area.height - lh, outside: true },
    { x: area.x - lw - outsideGap, y: area.y, outside: true },
    { x: area.x - lw - outsideGap, y: area.y + (area.height - lh) / 2, outside: true },
    { x: area.x - lw - outsideGap, y: area.y + area.height - lh, outside: true },
  ];
  const outsideC: { x: number; y: number; outside: boolean }[] = [...topOutsideC, ...bottomOutsideC, ...sideOutsideC];
  // Inside corners are last-resort (no center placement).
  const insideC: { x: number; y: number; outside: boolean }[] = [
    { x: area.x + area.width - lw - pad, y: area.y + pad, outside: false },
    { x: area.x + pad, y: area.y + pad, outside: false },
    { x: area.x + area.width - lw - pad, y: area.y + area.height - lh - pad, outside: false },
    { x: area.x + pad, y: area.y + area.height - lh - pad, outside: false },
  ];
  const candidates = [...outsideC, ...insideC];

  let bestPos: { x: number; y: number } = { x: candidates[0].x, y: candidates[0].y };
  let bestScore = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const pos = candidates[i];
    const isOutOfBounds = pos.x < 0 || pos.y < 0 || pos.x + lw > canvasWidth || pos.y + lh > canvasHeight;
    const cx = Math.max(0, Math.min(pos.x, Math.max(0, canvasWidth - lw)));
    const cy = Math.max(0, Math.min(pos.y, Math.max(0, canvasHeight - lh)));
    let score = computeRegionComplexity(ctx, cx, cy, lw, lh, canvasWidth, canvasHeight);
    if (isOutOfBounds) score += 200;
    // Inside placement: lighter penalty when source rect has room for a
    // corner pill (clean inside is clearer than a remote leader callout).
    const hasInsideRoom = area.width >= lw * 2.2 && area.height >= lh * 1.6;
    if (!pos.outside) score += hasInsideRoom ? 8 : 100;
    score += i * 0.02; // tiny tiebreaker only
    if (score < bestScore) {
      bestScore = score;
      bestPos = { x: cx, y: cy };
    }
  }
  return bestPos;
}

/**
 * Draw a bounding box border on a canvas using the noocclude style:
 * semi-transparent bold dotted magenta line, no background fill.
 * Uses a single fixed colour so all annotations share one consistent look.
 */
export function drawNooccludeBorder(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | any,
  area: { x: number; y: number; width: number; height: number },
  _color: string,
): void {
  const annotationColor = '#FF00FF';
  ctx.save();
  ctx.strokeStyle = annotationColor + "80"; // 50% opacity
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(area.x, area.y, area.width, area.height);
  ctx.setLineDash([]);
  ctx.restore();
}

/**
 * Draw a single label on a canvas using the noocclude style.
 * Picks the least busy position and renders outlined text (no background).
 */
export function drawNooccludeLabel(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | any,
  id: string,
  area: { x: number; y: number; width: number; height: number },
  color: string,
  canvasWidth: number,
  canvasHeight: number,
  placedLabels?: { x: number; y: number; w: number; h: number }[],
  placedElements?: { x: number; y: number; w: number; h: number }[],
): void {
  // Skip zero-area elements
  if (area.width <= 0 || area.height <= 0) return;
  // Skip fully off-canvas elements
  if (area.x + area.width < 0 || area.x > canvasWidth ||
      area.y + area.height < 0 || area.y > canvasHeight) return;

  // Compact font size (10–12px), monospace for stable digit width.
  const fontSize = Math.min(12, Math.max(10, area.height / 2));
  ctx.font = `900 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  const metrics = ctx.measureText(id);
  const textWidth = metrics && metrics.width ? metrics.width : id.length * fontSize * 0.6;
  const padX = 2;
  const padY = 1;
  const labelWidth = Math.ceil(textWidth + padX * 2);
  const labelHeight = Math.ceil(fontSize + padY * 2);

  const localPos = findBestLabelPositionWithCollision(ctx, area, labelWidth, labelHeight, canvasWidth, canvasHeight, placedLabels, placedElements);

  // Detect collision / proximity / forced-inside conditions and run a spiral
  // search for a truly empty whitespace slot, drawing a leader line back to
  // the element.
  let pos = localPos;
  let usedLeader = false;
  const buffer = 4;
  const collidesLabel = placedLabels
    ? placedLabels.some(p =>
        localPos.x < p.x + p.w + buffer && localPos.x + labelWidth + buffer > p.x &&
        localPos.y < p.y + p.h + buffer && localPos.y + labelHeight + buffer > p.y)
    : false;
  const localIsInside =
    localPos.x >= area.x && localPos.y >= area.y &&
    localPos.x + labelWidth <= area.x + area.width &&
    localPos.y + labelHeight <= area.y + area.height;
  const isSmallElement = area.width < 80 || area.height < 40;
  const proximity = 28;
  const nearbyLabels = placedLabels
    ? placedLabels.filter(p =>
        p.x < area.x + area.width + proximity && p.x + p.w + proximity > area.x &&
        p.y < area.y + area.height + proximity && p.y + p.h + proximity > area.y)
    : [];
  // Density score: count surrounding element rects whose centers fall
  // within densityRadius of the source center.
  const densityRadius = 90;
  const srcCx = area.x + area.width / 2;
  const srcCy = area.y + area.height / 2;
  let densityCount = 0;
  let densityCxSum = 0, densityCySum = 0;
  if (placedElements) {
    for (const e of placedElements) {
      const ecx = e.x + e.w / 2;
      const ecy = e.y + e.h / 2;
      if (ecx === srcCx && ecy === srcCy) continue;
      const dx = ecx - srcCx;
      const dy = ecy - srcCy;
      if (dx * dx + dy * dy < densityRadius * densityRadius) {
        densityCount++;
        densityCxSum += ecx;
        densityCySum += ecy;
      }
    }
  }
  const isDense = densityCount >= 3;
  // Centroid of nearby labels for outward-fan biasing.
  let clusterCx = area.x + area.width / 2;
  let clusterCy = area.y + area.height / 2;
  if (nearbyLabels.length > 0) {
    let sx = 0, sy = 0;
    for (const p of nearbyLabels) {
      sx += p.x + p.w / 2;
      sy += p.y + p.h / 2;
    }
    clusterCx = sx / nearbyLabels.length;
    clusterCy = sy / nearbyLabels.length;
  }
  if (isDense) {
    clusterCx = densityCxSum / densityCount;
    clusterCy = densityCySum / densityCount;
  }
  // "Clean inside" = localPos is inside the source rect, the source is
  // big enough to host a corner pill, and the chosen slot doesn't overlap
  // any neighbouring annotated element. Preferred over a leader callout
  // because the index unambiguously belongs to the surrounding rectangle.
  const hasInsideRoom = area.width >= labelWidth * 2.2 && area.height >= labelHeight * 1.6;
  let overlapsNeighbour = false;
  if (placedElements) {
    for (const e of placedElements) {
      const isSource = e.x === area.x && e.y === area.y && e.w === area.width && e.h === area.height;
      if (isSource) continue;
      if (localPos.x < e.x + e.w && localPos.x + labelWidth > e.x &&
          localPos.y < e.y + e.h && localPos.y + labelHeight > e.y) {
        overlapsNeighbour = true;
        break;
      }
    }
  }
  const localIsCleanInside = localIsInside && hasInsideRoom && !overlapsNeighbour && !collidesLabel;
  const needsCallout = collidesLabel || (localIsInside && !localIsCleanInside) || (isSmallElement && nearbyLabels.length >= 1) || isDense;

  if (needsCallout) {
    const ax = area.x + area.width / 2;
    const ay = area.y + area.height / 2;
    const dxAway = ax - clusterCx;
    const dyAway = ay - clusterCy;
    const startAngle = (dxAway === 0 && dyAway === 0)
      ? -Math.PI / 2
      : Math.atan2(dyAway, dxAway);
    const ringStep = Math.max(labelHeight + 4, 18);
    const angleStep = Math.PI / 12;
    const maxRing = 24;
    const denseExtra = isDense
      ? Math.max(80, Math.min(220, 40 + densityCount * 22))
      : 0;
    const baseRadius = Math.max(area.width, area.height) / 2 + ringStep + denseExtra;
    let foundOk = false;
    let foundX = localPos.x;
    let foundY = localPos.y;
    for (let ring = 1; ring <= maxRing && !foundOk; ring++) {
      const r = baseRadius + (ring - 1) * ringStep;
      for (let step = 0; step < 24 && !foundOk; step++) {
        const halfStep = Math.floor((step + 1) / 2);
        const sign = step % 2 === 0 ? 1 : -1;
        const a = startAngle + sign * halfStep * angleStep;
        const cx = ax + Math.cos(a) * r;
        const cy = ay + Math.sin(a) * r;
        const ll = Math.round(cx - labelWidth / 2);
        const tt = Math.round(cy - labelHeight / 2);
        if (ll < 2 || tt < 2 || ll + labelWidth > canvasWidth - 2 || tt + labelHeight > canvasHeight - 2) continue;
        // Avoid overlap with any element bounding box.
        let hitsElement = false;
        if (placedElements) {
          for (const e of placedElements) {
            if (ll < e.x + e.w && ll + labelWidth > e.x && tt < e.y + e.h && tt + labelHeight > e.y) {
              hitsElement = true;
              break;
            }
          }
        } else {
          if (ll < area.x + area.width && ll + labelWidth > area.x && tt < area.y + area.height && tt + labelHeight > area.y) hitsElement = true;
        }
        if (hitsElement) continue;
        // Avoid label-label collisions (with buffer).
        let collides = false;
        if (placedLabels) {
          for (const p of placedLabels) {
            if (ll < p.x + p.w + buffer && ll + labelWidth + buffer > p.x &&
                tt < p.y + p.h + buffer && tt + labelHeight + buffer > p.y) {
              collides = true;
              break;
            }
          }
        }
        if (collides) continue;
        foundX = ll;
        foundY = tt;
        foundOk = true;
      }
    }
    if (foundOk) {
      pos = { x: foundX, y: foundY };
      usedLeader = true;
    } else if (isSmallElement || isDense) {
      // Spiral exhausted. Anchor inside source centre rather than leaving
      // pos overlapping a neighbour — unambiguous even if visually packed.
      pos = {
        x: Math.round(area.x + area.width / 2 - labelWidth / 2),
        y: Math.round(area.y + area.height / 2 - labelHeight / 2),
      };
      usedLeader = false;
    }
  }

  // Register placed label for collision avoidance
  if (placedLabels) {
    placedLabels.push({ x: pos.x, y: pos.y, w: labelWidth, h: labelHeight });
  }

  // Contrast-adaptive color: sample background luminance at label position.
  // If the underlying region is magenta-ish, switch label accent to cyan.
  let annotationColor = '#FF00FF';
  try {
    const sampleData = ctx.getImageData(Math.max(0, Math.round(pos.x)), Math.max(0, Math.round(pos.y)), 1, 1).data;
    if (sampleData[0] > 180 && sampleData[1] < 100 && sampleData[2] > 180) {
      annotationColor = '#00FFFF';
    }
  } catch (_e) { /* keep magenta */ }

  // Detect if this position is outside the element's bounding box. If so we
  // can keep the pill fully opaque (no real content beneath); otherwise we
  // soften it slightly to let underlying content show through.
  const isInside =
    pos.x >= area.x && pos.y >= area.y &&
    pos.x + labelWidth <= area.x + area.width &&
    pos.y + labelHeight <= area.y + area.height;

  ctx.save();

  // Draw the leader line first (under the pill).
  if (usedLeader) {
    const px = pos.x + labelWidth / 2;
    const py = pos.y + labelHeight / 2;
    // Anchor at the element CENTER so it's unambiguous which element this
    // displaced index refers to.
    const ex = area.x + area.width / 2;
    const ey = area.y + area.height / 2;
    const dx = ex - px;
    const dy = ey - py;
    let pAnchorX = px;
    let pAnchorY = py;
    if (Math.abs(dx) * labelHeight > Math.abs(dy) * labelWidth) {
      pAnchorX = dx > 0 ? pos.x + labelWidth : pos.x;
      pAnchorY = py + dy * (labelWidth / 2) / Math.max(1, Math.abs(dx));
    } else {
      pAnchorX = px + dx * (labelHeight / 2) / Math.max(1, Math.abs(dy));
      pAnchorY = dy > 0 ? pos.y + labelHeight : pos.y;
    }
    // Leader-line color is intentionally DIFFERENT from the magenta
    // element-border color so callout lines don't blend with field borders.
    const leaderColor = annotationColor === '#FF00FF' ? '#FF8C00' : '#C71585';
    ctx.strokeStyle = leaderColor;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 2]);
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(pAnchorX, pAnchorY);
    ctx.stroke();
    ctx.setLineDash([]);
    // Translucent filled circle at the element CENTER — marks the anchor
    // without fully hiding any underlying glyph or icon.
    ctx.fillStyle = leaderColor;
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.arc(ex, ey, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = leaderColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(ex, ey, 2.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1.0;
    ctx.globalAlpha = 1.0;
  }

  ctx.globalAlpha = !usedLeader && isInside ? 0.85 : 1.0;
  // Outer black halo for separation from any background
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fillRect(pos.x - 1, pos.y - 1, labelWidth + 2, labelHeight + 2);
  // White background fill
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(pos.x, pos.y, labelWidth, labelHeight);
  // Magenta (or cyan) border
  ctx.strokeStyle = annotationColor;
  ctx.lineWidth = 1;
  ctx.strokeRect(pos.x + 0.5, pos.y + 0.5, labelWidth - 1, labelHeight - 1);
  ctx.globalAlpha = 1.0;
  // Bold text
  ctx.fillStyle = annotationColor;
  ctx.textBaseline = 'top';
  ctx.fillText(id, pos.x + padX, pos.y + padY);
  ctx.restore();
}

/**
 * Find best label position with label-to-label collision avoidance.
 * Extends findBestLabelPosition with penalty for overlapping already-placed labels.
 */
export function findBestLabelPositionWithCollision(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | any,
  area: { x: number; y: number; width: number; height: number },
  lw: number,
  lh: number,
  canvasWidth: number,
  canvasHeight: number,
  placedLabels?: { x: number; y: number; w: number; h: number }[],
  placedElements?: { x: number; y: number; w: number; h: number }[],
): { x: number; y: number } {
  const pad = 1;
  const outsideGap = 2;
  // Outside placements occlude no real content of the element; try many directions.
  const topOutsideC: { x: number; y: number; outside: boolean }[] = [
    { x: area.x + area.width - lw, y: area.y - lh - outsideGap, outside: true },
    { x: area.x + (area.width - lw) / 2, y: area.y - lh - outsideGap, outside: true },
    { x: area.x, y: area.y - lh - outsideGap, outside: true },
  ];
  const bottomOutsideC: { x: number; y: number; outside: boolean }[] = [
    { x: area.x + area.width - lw, y: area.y + area.height + outsideGap, outside: true },
    { x: area.x + (area.width - lw) / 2, y: area.y + area.height + outsideGap, outside: true },
    { x: area.x, y: area.y + area.height + outsideGap, outside: true },
  ];
  const sideOutsideC: { x: number; y: number; outside: boolean }[] = [
    { x: area.x + area.width + outsideGap, y: area.y, outside: true },
    { x: area.x + area.width + outsideGap, y: area.y + (area.height - lh) / 2, outside: true },
    { x: area.x + area.width + outsideGap, y: area.y + area.height - lh, outside: true },
    { x: area.x - lw - outsideGap, y: area.y, outside: true },
    { x: area.x - lw - outsideGap, y: area.y + (area.height - lh) / 2, outside: true },
    { x: area.x - lw - outsideGap, y: area.y + area.height - lh, outside: true },
  ];
  const outsideC: { x: number; y: number; outside: boolean }[] = [...topOutsideC, ...bottomOutsideC, ...sideOutsideC];
  // Inside corners are last-resort (no center placement).
  const insideC: { x: number; y: number; outside: boolean }[] = [
    { x: area.x + area.width - lw - pad, y: area.y + pad, outside: false },
    { x: area.x + pad, y: area.y + pad, outside: false },
    { x: area.x + area.width - lw - pad, y: area.y + area.height - lh - pad, outside: false },
    { x: area.x + pad, y: area.y + area.height - lh - pad, outside: false },
  ];
  const candidates = [...outsideC, ...insideC];

  let bestPos: { x: number; y: number } = { x: candidates[0].x, y: candidates[0].y };
  let bestScore = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const pos = candidates[i];
    const isOutOfBounds = pos.x < 0 || pos.y < 0 || pos.x + lw > canvasWidth || pos.y + lh > canvasHeight;
    const cx = Math.max(0, Math.min(pos.x, Math.max(0, canvasWidth - lw)));
    const cy = Math.max(0, Math.min(pos.y, Math.max(0, canvasHeight - lh)));
    let score = computeRegionComplexity(ctx, cx, cy, lw, lh, canvasWidth, canvasHeight);
    if (isOutOfBounds) score += 200;
    // Inside placement: lighter penalty when source rect has room for a
    // corner pill (clean inside is clearer than a remote leader callout).
    const hasInsideRoom = area.width >= lw * 2.2 && area.height >= lh * 1.6;
    if (!pos.outside) score += hasInsideRoom ? 8 : 100;
    score += i * 0.02;

    // Penalize overlap with other annotated elements (excluding source).
    if (placedElements) {
      const sourceL = area.x;
      const sourceT = area.y;
      const sourceR = area.x + area.width;
      const sourceB = area.y + area.height;
      for (const e of placedElements) {
        const eL = e.x;
        const eT = e.y;
        const eR = e.x + e.w;
        const eB = e.y + e.h;
        const isSource = eL === sourceL && eT === sourceT && eR === sourceR && eB === sourceB;
        if (isSource) continue;
        const ix = Math.max(0, Math.min(cx + lw, eR) - Math.max(cx, eL));
        const iy = Math.max(0, Math.min(cy + lh, eB) - Math.max(cy, eT));
        if (ix > 0 && iy > 0) {
          const overlapRatio = (ix * iy) / Math.max(1, lw * lh);
          score += 300 + overlapRatio * 2000;
        }
      }
    }

    // Penalize near-miss adjacency to reduce visual ambiguity in dense rows.
    const desiredGap = 6;
    const gapPenaltyFromRect = (aL: number, aT: number, aR: number, aB: number) => {
      const dx = Math.max(0, Math.max(aL - (cx + lw), cx - aR));
      const dy = Math.max(0, Math.max(aT - (cy + lh), cy - aB));
      const gap = Math.sqrt(dx * dx + dy * dy);
      return gap < desiredGap ? (desiredGap - gap) * 6 : 0;
    };
    if (placedLabels) {
      for (const p of placedLabels) {
        score += gapPenaltyFromRect(p.x, p.y, p.x + p.w, p.y + p.h);
      }
    }
    if (placedElements) {
      const sourceL = area.x;
      const sourceT = area.y;
      const sourceR = area.x + area.width;
      const sourceB = area.y + area.height;
      for (const e of placedElements) {
        const eL = e.x;
        const eT = e.y;
        const eR = e.x + e.w;
        const eB = e.y + e.h;
        const isSource = eL === sourceL && eT === sourceT && eR === sourceR && eB === sourceB;
        if (isSource) continue;
        score += gapPenaltyFromRect(eL, eT, eR, eB);
      }
    }
    if (placedLabels) {
      for (const placed of placedLabels) {
        if (cx < placed.x + placed.w && cx + lw > placed.x &&
            cy < placed.y + placed.h && cy + lh > placed.y) {
          score += 10000; // heavy label-label overlap penalty
        }
      }
    }
    if (score < bestScore) {
      bestScore = score;
      bestPos = { x: cx, y: cy };
    }
  }
  return bestPos;
}

/**
 * Draw a single label on a canvas using the legacy style (solid background).
 */
export function drawLegacyLabel(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | any,
  id: string,
  area: { x: number; y: number; width: number; height: number },
  color: string,
): void {
  const fontSize = Math.min(12, Math.max(8, area.height / 2));
  ctx.font = `${fontSize}px sans-serif`;
  const metrics = ctx.measureText(id);
  const textWidth = metrics && metrics.width ? metrics.width : 0;
  const padding = 4;
  const labelWidth = textWidth + padding * 2;
  const labelHeight = fontSize + padding * 2;

  const labelX = area.x + area.width - labelWidth;
  let labelY = area.y;
  if (area.width < labelWidth + 4 || area.height < labelHeight + 4) {
    labelY = area.y - labelHeight;
  }

  ctx.fillStyle = color;
  ctx.fillRect(labelX, labelY, labelWidth, labelHeight);
  ctx.fillStyle = "#FFFFFF";
  ctx.textBaseline = "top";
  ctx.fillText(id, labelX + padding, labelY + padding);
}

// =============================================================================
// Primitive drawing helpers used by the gutter-legend canvas layout.
// Kept tiny and side-effect-free so the layout code in utils.ts can use them
// for both inline pills and gutter-strip pills.
// =============================================================================

/** Returns the natural pill bounding box for a given index id. */
export function measureNooccludePill(
  ctx: any,
  id: string,
  refHeight = 16,
): { width: number; height: number; fontSize: number; padX: number; padY: number } {
  const fontSize = Math.min(12, Math.max(10, refHeight / 2));
  ctx.font = `900 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  const metrics = ctx.measureText(id);
  const textWidth = metrics && metrics.width ? metrics.width : id.length * fontSize * 0.6;
  const padX = 2;
  const padY = 1;
  return {
    width: Math.ceil(textWidth + padX * 2),
    height: Math.ceil(fontSize + padY * 2),
    fontSize,
    padX,
    padY,
  };
}

/** Draw the noocclude pill at an exact (left, top) without any layout logic.
 *
 *  When `opacity` < 1 the white fill (and outer halo) becomes translucent so
 *  underlying page content stays legible — used for INSIDE placements where
 *  the corner may sit over real content (e.g. dropdown chevrons, link text
 *  inside a small chip). Border + digits always render fully opaque so the
 *  index remains crisp at any opacity. */
export function drawNooccludePillAt(
  ctx: any,
  id: string,
  left: number,
  top: number,
  color: string = '#FF00FF',
  opacity: number = 1,
  pointTo: 'top' | 'right' | 'bottom' | 'left' | null = null,
): { width: number; height: number } {
  const m = measureNooccludePill(ctx, id);
  ctx.save();
  // Outer black halo for separation (scaled by opacity so it doesn't outshine
  // a translucent pill).
  ctx.fillStyle = `rgba(0,0,0,${(0.4 * opacity).toFixed(3)})`;
  ctx.fillRect(left - 1, top - 1, m.width + 2, m.height + 2);
  // White fill — translucent when opacity < 1.
  ctx.fillStyle = opacity >= 1 ? '#FFFFFF' : `rgba(255,255,255,${opacity.toFixed(3)})`;
  ctx.fillRect(left, top, m.width, m.height);
  // Magenta border — always opaque so the pill outline stays visible.
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.strokeRect(left + 0.5, top + 0.5, m.width - 1, m.height - 1);
  // Bold text — always opaque so digits remain crisp.
  ctx.fillStyle = color;
  ctx.font = `900 ${m.fontSize}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  ctx.textBaseline = 'top';
  ctx.fillText(id, left + m.padX, top + m.padY);
  // Directional anchor tick: a small filled triangle on the pill edge that
  // FACES the source element. Tells the model "this pill belongs to the
  // element on the side my tick points toward" — disambiguates outside-
  // adjacent pills like a chip-row pill that sits between two stacked rows.
  if (pointTo) {
    const cx = left + m.width / 2;
    const cy = top + m.height / 2;
    const tickH = 4; // depth outside the pill
    const tickW = 6; // base width on the pill edge
    ctx.fillStyle = color;
    ctx.beginPath();
    if (pointTo === 'top') {
      ctx.moveTo(cx - tickW / 2, top);
      ctx.lineTo(cx + tickW / 2, top);
      ctx.lineTo(cx, top - tickH);
    } else if (pointTo === 'bottom') {
      ctx.moveTo(cx - tickW / 2, top + m.height);
      ctx.lineTo(cx + tickW / 2, top + m.height);
      ctx.lineTo(cx, top + m.height + tickH);
    } else if (pointTo === 'left') {
      ctx.moveTo(left, cy - tickW / 2);
      ctx.lineTo(left, cy + tickW / 2);
      ctx.lineTo(left - tickH, cy);
    } else {
      // right
      ctx.moveTo(left + m.width, cy - tickW / 2);
      ctx.lineTo(left + m.width, cy + tickW / 2);
      ctx.lineTo(left + m.width + tickH, cy);
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  return { width: m.width, height: m.height };
}

/** Draw the cartographic leader: dotted amber line + translucent centre dot. */
export function drawLeaderTo(
  ctx: any,
  fromCx: number,
  fromCy: number,
  pillLeft: number,
  pillTop: number,
  pillW: number,
  pillH: number,
  pillColor: string = '#FF00FF',
): void {
  // Pill anchor on the side facing the element.
  const pCx = pillLeft + pillW / 2;
  const pCy = pillTop + pillH / 2;
  const dx = fromCx - pCx;
  const dy = fromCy - pCy;
  let pAnchorX = pCx;
  let pAnchorY = pCy;
  if (Math.abs(dx) * pillH > Math.abs(dy) * pillW) {
    pAnchorX = dx > 0 ? pillLeft + pillW : pillLeft;
    pAnchorY = pCy + dy * (pillW / 2) / Math.max(1, Math.abs(dx));
  } else {
    pAnchorX = pCx + dx * (pillH / 2) / Math.max(1, Math.abs(dy));
    pAnchorY = dy > 0 ? pillTop + pillH : pillTop;
  }
  // Distinct leader colour so it doesn't blend with magenta element borders.
  const leaderColor = pillColor === '#FF00FF' ? '#FF8C00' : '#C71585';
  ctx.save();
  ctx.strokeStyle = leaderColor;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 2]);
  ctx.globalAlpha = 0.75;
  ctx.beginPath();
  ctx.moveTo(fromCx, fromCy);
  ctx.lineTo(pAnchorX, pAnchorY);
  ctx.stroke();
  ctx.setLineDash([]);
  // Translucent dot at element centre.
  ctx.fillStyle = leaderColor;
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  ctx.arc(fromCx, fromCy, 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = leaderColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(fromCx, fromCy, 2.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/**
 * Orthogonal (right-angle / "subway-map") leader from a source element to a
 * gutter pill. Produces a path with at most two right-angle bends, biasing
 * the bend close to the pill so that many leaders sharing similar source-Y
 * positions appear as parallel horizontal traces with short vertical kinks
 * — far less visually noisy than diagonal "spaghetti" leaders.
 *
 * Path shape (when pill is to the right of the source, the common case):
 *
 *     dot ────────────────────────────┐
 *                                     └─── pill
 *
 * Falls back to a single horizontal segment when source-centre-Y and
 * pill-centre-Y agree within 1 px (after Y-binning this is the typical
 * case).
 *
 * @param srcX/srcY/srcW/srcH   the source element's bounding rect
 *                              (used to pick which side of the element to
 *                              exit from and to clamp the centre dot).
 * @param dotCx/dotCy           optional explicit centre-dot position; if
 *                              omitted the source element's geometric
 *                              centre is used.
 */
export function drawOrthogonalLeaderTo(
  ctx: any,
  srcX: number,
  srcY: number,
  srcW: number,
  srcH: number,
  pillLeft: number,
  pillTop: number,
  pillW: number,
  pillH: number,
  pillColor: string = '#FF00FF',
  dotCx?: number,
  dotCy?: number,
  noDot: boolean = false,
): void {
  const dotX = dotCx !== undefined ? dotCx : srcX + srcW / 2;
  const dotY = dotCy !== undefined ? dotCy : srcY + srcH / 2;
  const pillCy = pillTop + pillH / 2;

  // Pick which side of the source element to exit from based on pill side.
  // For the common case (pill in right gutter) we exit from the right edge
  // at the row's vertical band so the line traces along the row.
  let exitX: number;
  let exitY: number;
  if (pillLeft >= srcX + srcW) {
    exitX = srcX + srcW;
    exitY = Math.max(srcY, Math.min(srcY + srcH, pillCy));
  } else if (pillLeft + pillW <= srcX) {
    exitX = srcX;
    exitY = Math.max(srcY, Math.min(srcY + srcH, pillCy));
  } else if (pillTop >= srcY + srcH) {
    exitX = Math.max(srcX, Math.min(srcX + srcW, pillLeft + pillW / 2));
    exitY = srcY + srcH;
  } else {
    exitX = Math.max(srcX, Math.min(srcX + srcW, pillLeft + pillW / 2));
    exitY = srcY;
  }

  // Pill entry: enter from the side facing the source.
  let entryX: number;
  let entryY: number;
  if (exitX <= pillLeft) {
    entryX = pillLeft;
    entryY = pillCy;
  } else if (exitX >= pillLeft + pillW) {
    entryX = pillLeft + pillW;
    entryY = pillCy;
  } else {
    entryX = pillLeft + pillW / 2;
    entryY = exitY <= pillTop ? pillTop : pillTop + pillH;
  }

  const leaderColor = pillColor === '#FF00FF' ? '#FF8C00' : '#C71585';
  ctx.save();
  ctx.strokeStyle = leaderColor;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 2]);
  ctx.globalAlpha = 0.75;
  ctx.beginPath();
  ctx.moveTo(dotX, dotY);
  ctx.lineTo(exitX, exitY);
  if (Math.abs(exitY - entryY) <= 1 || Math.abs(exitX - entryX) <= 1) {
    // Already aligned on one axis — single straight segment to the entry.
    // (No bend would just double back; renders cleaner as one line.)
    ctx.lineTo(entryX, entryY);
  } else {
    // L-shape: bend close to the pill so parallel leaders share long
    // horizontal segments and only diverge in the short vertical kink.
    let bendX: number;
    if (entryX > exitX) {
      bendX = entryX - 8;
      if (bendX < exitX + 4) bendX = (exitX + entryX) / 2;
    } else {
      bendX = entryX + 8;
      if (bendX > exitX - 4) bendX = (exitX + entryX) / 2;
    }
    ctx.lineTo(bendX, exitY);
    ctx.lineTo(bendX, entryY);
    ctx.lineTo(entryX, entryY);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  if (!noDot) {
    // Translucent dot at element centre.
    ctx.fillStyle = leaderColor;
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.arc(dotX, dotY, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = leaderColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(dotX, dotY, 2.5, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

