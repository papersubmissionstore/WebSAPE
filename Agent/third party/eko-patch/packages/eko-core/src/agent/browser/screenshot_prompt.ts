/**
 * Screenshot-description prompt fragments for the browser agent.
 *
 * Kept in a separate file (rather than inlined in browser_labels.ts) so that
 * (a) browser_labels.ts changes minimally vs. upstream eko, reducing merge
 *     conflicts when we sync the patch from the external eko repo, and
 * (b) the noocclude/draw-mode logic — which is entirely our addition — lives
 *     alongside the other noocclude helpers (highlight_label.ts, label_style.ts,
 *     utils.ts) instead of being scattered through the agent constructor.
 *
 * Public entry point: `getScreenshotDescription(labelStyle, markImageMode)`.
 */

import type { LabelStyle } from "./label_style";

export type MarkImageMode = "dom" | "draw";

/**
 * Original eko/legacy description: solid coloured pill with white text drawn
 * at the top-right corner of every element. Used when `labelStyle = "legacy"`,
 * regardless of markImageMode (legacy is rendered the same way in both paths).
 */
const LEGACY_BLOCK = `* Screenshot description:
  - Screenshot are used to understand page layouts, with labeled bounding boxes corresponding to element indexes. Each bounding box and its label share the same color, with labels typically positioned in the top-right corner of the box.
  - Screenshot help verify element positions and relationships. Labels may sometimes overlap, so extracted elements are used to verify the correct elements.
  - In addition to screenshot, simplified information about interactive elements is returned, with element indexes corresponding to those in the screenshot.
  - This tool can ONLY screenshot the VISIBLE content. If a complete content is required, use 'extract_page_content' instead.
  - If the webpage content hasn't loaded, please use the \`wait\` tool to allow time for the content to load.`;

/**
 * Noocclude pill style rendered as a DOM overlay (markImageMode = "dom").
 * Placement uses the spiral-callout engine in highlight_label.ts: most pills
 * sit just outside the element; very crowded clusters get displaced into
 * surrounding whitespace with an amber leader line. There is NO right-edge
 * gutter strip in this path because the labels are real <div> overlays on the
 * live page — we cannot widen the viewport.
 */
const NOOCCLUDE_DOM_BLOCK = `* Screenshot description:
  - Screenshot are used to understand page layouts, with labeled bounding boxes corresponding to element indexes.
  - Bounding boxes are drawn as semi-transparent magenta (#FF00FF) dotted lines.
  - Each interactive element is tagged with a compact rectangular pill containing its index number. The pill has a white background, a magenta border, and bold magenta monospace digits inside (e.g., a small box reading "42"). On magenta-coloured backgrounds the accent automatically switches to cyan (#00FFFF) for contrast.
  - Pills are placed *outside* the element bounding box whenever possible (above, below, left, or right) so they do not cover real page content. They only sit inside the box when no clean outside slot is available; inside pills are rendered slightly translucent so the underlying text/icon stays visible. The pill border and index digits are always fully opaque so the index itself is never ambiguous.
  - For small elements in dense clusters (rows of tag pills, toolbar icons, avatar groups, tightly-packed form rows) the index pill may be *displaced into surrounding whitespace* and connected to its element by a thin dotted **amber/orange (#FF8C00)** leader line ending in a translucent amber centre dot. (When the pill is cyan because the underlying background is magenta-ish, the leader switches to deep magenta #C71585.) Each pill in a cluster fans out radially in a different direction so leader lines diverge rather than cross. To resolve such an index, follow the amber dotted line from the pill to the centre dot — the element under the dot is the one referred to by that index. Pills without a leader line refer to the element they sit on top of or directly adjacent to.
  - The number inside the pill is the element's index — match it to the same index in the structured element list. Do NOT confuse pill digits with numeric content that belongs to the page itself (page numbers, prices, counts, etc.).
  - In addition to the screenshot, simplified information about interactive elements is returned, with element indexes corresponding to those in the screenshot.
  - This tool can ONLY screenshot the VISIBLE content. If a complete content is required, use 'extract_page_content' instead.
  - If the webpage content hasn't loaded, please use the \`wait\` tool to allow time for the content to load.`;

/**
 * Noocclude pill style rendered onto the captured screenshot canvas
 * (markImageMode = "draw"). Placement uses the 3-step priority pipeline in
 * utils.ts (inside corner → outside-adjacent → right-edge gutter strip).
 * The canvas is widened on the right so gutter pills sit on a clean white
 * strip connected back to the element by an amber dotted leader.
 */
const NOOCCLUDE_DRAW_BLOCK = `* Screenshot description:
  - Screenshot are used to understand page layouts, with labeled bounding boxes corresponding to element indexes.
  - Bounding boxes are drawn as semi-transparent magenta (#FF00FF) dotted lines.
  - Each interactive element is tagged with a compact rectangular pill containing its index number. The pill has a white background, a magenta border, and bold magenta monospace digits inside (e.g., a small box reading "42"). On magenta-coloured backgrounds the accent automatically switches to cyan (#00FFFF) for contrast.
  - Pill placement follows a 3-step priority so pills stay close to their element:
      1. **INSIDE the element's top-right corner** when the element is large enough to physically contain the pill (sidebar items, buttons, toolbar entries, list rows). Other corners are tried if top-right collides with another pill.
      2. **OUTSIDE adjacent to the element** when it's too small to host the pill (avatars, icons, tag chips, dense controls). Positions are searched in priority order **bottom-center → bottom corners → above → right → left**, picking the first slot that lies on canvas, doesn't cover any other element's bounding box, and doesn't collide with any pill that has already been placed. So a row of avatars typically gets pills directly *underneath* each avatar; an element flush against the right edge of the screen may instead get its pill on the right side.
      3. **GUTTER strip on the right edge of the screenshot** as a last resort, when both inside and adjacent-outside placement are impossible (extremely dense regions like rows of tag pills with no whitespace gap). The screenshot canvas is widened with a vertical white strip on the right; pills are placed so their vertical position roughly matches their source element's row, and connected to the element by a thin dotted **amber/orange (#FF8C00)** orthogonal (right-angle, "subway-map") leader ending in a translucent amber centre dot. (When the pill is cyan because the underlying background is magenta-ish, the leader switches to deep magenta #C71585.) Leaders use right-angles so parallel rows produce parallel horizontal traces instead of crossing diagonals.
      4. **RANGE pill + enclosing box** for *dense rows* (when many small interactive elements share the same source row, e.g. a tag-picker with 10+ checkbox/chip pairs side by side). Instead of giving each element its own pill (which would flood the gutter with crossing leaders), the entire row gets ONE single pill in the right gutter labelled with the index range it covers. The label uses the same compact notation as cluster pills: a hyphen for contiguous runs ("19-29"), commas for non-contiguous lists ("30,32,34,36"), or a plus sign for pairs. A solid magenta rectangle (thicker than the per-element dotted borders) is drawn directly on the screenshot wrapping every element in the row, and a short amber dotted leader connects the right edge of that rectangle to the gutter pill — there is no centre dot to hunt for. To act on a specific element inside a range, locate it in the structured element list by its visible text or colour (e.g. "the BACKEND chip in the 19-29 row"), and use its individual index from that list — every element inside the rectangle still has its own entry in the element list with its own per-element dotted bounding box.
  - **Cluster pills.** When several small adjacent siblings form one visual widget (a checkbox glued to a chip, an "Edit" + "+ Sprint" action pair, etc.) they may share a single combined pill. The pill text uses a hyphen for contiguous index runs (e.g. "16-19" means indices 16, 17, 18, 19), a plus sign for pairs (e.g. "16+17"), or comma-separated for non-contiguous groups (e.g. "16,18,21"). All members still appear individually in the structured element list — to act on a specific one, use its individual index from the list rather than the combined pill text. The combined pill is purely a visual hint that those indices live in the same widget cluster.
  - **Pill opacity** is chosen automatically per pill based on the underlying pixels: pills landing on truly empty padding (any uniform colour — white form fields, dark sidebar, coloured button corners, etc.) render fully opaque; pills landing on areas with mild visual content (e.g. a pill covering the corner of an icon or text glyph) render slightly **translucent** so the underlying content stays visible. A faded-looking pill is just an opacity hint that real content sits beneath it; the index digit and pill border are always rendered fully opaque so the index itself is never ambiguous.
  - **Directional tick on outside-adjacent pills.** When a pill sits in whitespace next to its element (rather than inside the element or in the gutter), it carries a small filled magenta triangular tick on the edge that FACES its source element. The tick points AT the element it belongs to: a tick on the pill's top edge means "the element is directly above me", on the bottom edge means "directly below me", left/right analogously. Use the tick to disambiguate which of two stacked rows or columns of elements a free-standing pill belongs to. Pills inside their element have no tick; pills in the right gutter use the amber leader instead.
  - The leader line uses a deliberately different colour from the magenta element-border boxes so callout lines never blend with field borders. To resolve a gutter index, follow the amber dotted line from the pill to the centre dot — the element under the dot is the one referred to by that index. Pills without a leader line refer to the element they sit inside or directly adjacent to.
  - The number inside the pill is the element's index — match it to the same index in the structured element list. Do NOT confuse pill digits with numeric content that belongs to the page itself (page numbers, prices, counts, etc.).
  - In addition to the screenshot, simplified information about interactive elements is returned, with element indexes corresponding to those in the screenshot.
  - This tool can ONLY screenshot the VISIBLE content. If a complete content is required, use 'extract_page_content' instead.
  - If the webpage content hasn't loaded, please use the \`wait\` tool to allow time for the content to load.`;

/**
 * Pick the right "Screenshot description" prompt block for the active
 * (labelStyle, markImageMode) combination.
 *
 * The return value is a single block of text that begins with the
 * `* Screenshot description:` header and ends with the `wait`-tool note,
 * ready to be dropped into the agent's system prompt.
 */
export function getScreenshotDescription(
  labelStyle: LabelStyle,
  markImageMode: MarkImageMode | string | undefined,
): string {
  if (labelStyle !== "noocclude") {
    return LEGACY_BLOCK;
  }
  return markImageMode === "draw" ? NOOCCLUDE_DRAW_BLOCK : NOOCCLUDE_DOM_BLOCK;
}
