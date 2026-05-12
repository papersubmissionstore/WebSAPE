import { loadPackage } from "../../common/utils";
import { getLabelStyle } from "./label_style";
import {
  drawNooccludeBorder,
  drawLegacyLabel,
  drawNooccludePillAt,
  drawOrthogonalLeaderTo,
  measureNooccludePill,
} from "./highlight_label";

export function extract_page_content(
  max_url_length = 200,
  max_content_length = 50000
) {
  let result = "";
  max_url_length = max_url_length || 200;
  try {
    function traverse(node: any) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tagName = node.tagName.toLowerCase();
        if (["script", "style", "noscript"].includes(tagName)) {
          return;
        }
        const style = window.getComputedStyle(node);
        if (
          style.display == "none" ||
          style.visibility == "hidden" ||
          style.opacity == "0"
        ) {
          return;
        }
      }
      if (node.nodeType === Node.TEXT_NODE) {
        // text
        const text = node.textContent.trim();
        if (text) {
          result += text + " ";
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tagName = node.tagName.toLowerCase();
        if (["input", "select", "textarea"].includes(tagName)) {
          // input / select / textarea
          if (tagName == "input" && node.type == "checkbox") {
            result += node.checked + " ";
          } else if (tagName == "input" && node.type == "radio") {
            if (node.checked && node.value) {
              result += node.value + " ";
            }
          } else if (node.value) {
            result += node.value + " ";
          }
        } else if (tagName === "img") {
          // image
          const src =
            node.src ||
            node.getAttribute("src") ||
            node.getAttribute("data-src");
          const alt = node.alt || node.title || "";
          if (
            src &&
            src.length <= max_url_length &&
            node.width * node.height >= 10000 &&
            src.startsWith("http")
          ) {
            result += `![${alt ? alt : "image"}](${src.trim()}) `;
          }
        } else if (tagName === "a" && node.children.length == 0) {
          // link
          const href = node.href || node.getAttribute("href");
          const text = node.innerText.trim() || node.title;
          if (
            text &&
            href &&
            href.length <= max_url_length &&
            href.startsWith("http")
          ) {
            result += `[${text}](${href.trim()}) `;
          } else {
            result += text + " ";
          }
        } else if (tagName === "video" || tagName == "audio") {
          // video / audio
          let src = node.src || node.getAttribute("src");
          const sources = node.querySelectorAll("source");
          if (sources.length > 0 && sources[0].src) {
            src = sources[0].src;
            if (src && src.startsWith("http") && sources[0].type) {
              result += sources[0].type + " ";
            }
          }
          if (src && src.startsWith("http")) {
            result += src.trim() + " ";
          }
        } else if (tagName === "br") {
          // br
          result += "\n";
        } else if (
          ["p", "div", "h1", "h2", "h3", "h4", "h5", "h6"].includes(tagName)
        ) {
          // block
          result += "\n";
          for (let child of node.childNodes) {
            traverse(child);
          }
          result += "\n";
          return;
        } else if (tagName === "hr") {
          // hr
          result += "\n--------\n";
        } else {
          // recursive
          for (let child of node.childNodes) {
            traverse(child);
          }
        }
      }
    }

    traverse(document.body);
  } catch (e) {
    result = document.body.innerText;
  }
  result = result.replace(/\s*\n/g, "\n").replace(/\n+/g, "\n").trim();
  if (result.length > max_content_length) {
    // result = result.slice(0, max_content_length) + "...";
    result = Array.from(result).slice(0, max_content_length).join("") + "...";
  }
  return result;
}

export function mark_screenshot_highlight_elements(
  screenshot: {
    imageBase64: string;
    imageType: "image/jpeg" | "image/png";
  },
  area_map: Record<
    string,
    { x: number; y: number; width: number; height: number; noDraw?: boolean }
  >,
  client_rect: { width: number; height: number }
): Promise<string> {
  return new Promise<string>(async (resolve, reject) => {
    try {
      const hasOffscreen = typeof OffscreenCanvas !== "undefined";
      const hasCreateImageBitmap = typeof createImageBitmap !== "undefined";
      const hasDOM = typeof document !== "undefined" && typeof Image !== "undefined";
      // @ts-ignore
      const isNode = typeof window === "undefined" && typeof process !== "undefined" && !!process.versions && !!process.versions.node;

      const loadImageAny = async () => {
        if (hasCreateImageBitmap) {
          const base64Data = screenshot.imageBase64;
          const binaryString = atob(base64Data);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          const blob = new Blob([bytes], { type: screenshot.imageType });
          const imageBitmap = await createImageBitmap(blob, {
            resizeQuality: "high",
            resizeWidth: client_rect.width,
            resizeHeight: client_rect.height,
          } as any);
          return { img: imageBitmap };
        }
        if (hasDOM) {
          const img = await new Promise<HTMLImageElement>(
            (resolveImg, rejectImg) => {
              const image = new Image();
              image.onload = () => resolveImg(image);
              image.onerror = (e) => rejectImg(e);
              image.src = `data:${screenshot.imageType};base64,${screenshot.imageBase64}`;
            }
          );
          return { img };
        }
        if (isNode) {
          const canvasMod = await loadPackage("canvas");
          const { loadImage } = canvasMod as any;
          const dataUrl = `data:${screenshot.imageType};base64,${screenshot.imageBase64}`;
          const img = await loadImage(dataUrl);
          return { img };
        }
        throw new Error("No image environment available");
      };

      const createCanvasAny = async (width: number, height: number) => {
        if (hasOffscreen) {
          const canvas = new OffscreenCanvas(width, height) as any;
          return {
            ctx: canvas.getContext("2d") as any,
            exportDataUrl: async (mime: string) => {
              const blob = await canvas.convertToBlob({ type: mime });
              return await new Promise<string>((res, rej) => {
                const reader = new FileReader();
                reader.onloadend = () => res(reader.result as string);
                reader.onerror = () =>
                  rej(new Error("Failed to convert blob to base64"));
                reader.readAsDataURL(blob);
              });
            },
          };
        }
        if (hasDOM) {
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          return {
            ctx: canvas.getContext("2d") as any,
            exportDataUrl: async (mime: string) => canvas.toDataURL(mime),
          };
        }
        if (isNode) {
          const canvasMod = await loadPackage("canvas");
          const { createCanvas } = canvasMod as any;
          const canvas = createCanvas(width, height);
          return {
            ctx: canvas.getContext("2d"),
            exportDataUrl: async (mime: string) => canvas.toDataURL(mime),
          };
        }
        throw new Error("No canvas environment available");
      };

      const loaded = await loadImageAny();
      const targetWidth = client_rect.width;
      const targetHeight = client_rect.height;

      const labelStyle = getLabelStyle();

      // ----------------------------------------------------------------
      // Classify each element as INLINE or GUTTER (noocclude mode only).
      // GUTTER = pill is placed in a right-side legend strip and connected
      // by a leader line to its element. Used when:
      //   - element is small (< 80 wide or < 40 tall) AND has a neighbour
      //     within 28px (likely to overlap or fight for space), OR
      //   - element is in a dense cluster (>= 3 neighbour centres within
      //     90px), OR
      //   - element doesn't have a clean inside corner (we don't bother
      //     trying outside placement on the canvas path \u2014 keep it simple).
      // INLINE = pill is drawn at a clean inside corner. No leader line.
      // ----------------------------------------------------------------
      // Entries flagged `noDraw` (e.g. <label> elements that wrap another
      // highlighted control — the entire form-section box around
      // "TITLE + input") are intentionally excluded from sortedEntries so
      // they get NO bounding box, NO inline pill, NO gutter pill. They
      // remain in area_map (and therefore in the structured element list
      // the agent receives) so they can still be referenced by index if
      // the agent ever wants to click the label itself.
      // Suppression only applies under labelStyle === "noocclude"; legacy
      // mode keeps every entry visible to preserve upstream behaviour.
      const sortedEntries = Object.entries(area_map)
        .filter(([id, area]) =>
          area.width > 0 && area.height > 0 &&
          !(labelStyle === "noocclude" && area.noDraw))
        .sort((a, b) => {
          const areaA = a[1].width * a[1].height;
          const areaB = b[1].width * b[1].height;
          return areaB - areaA;
        });

      // List of element rects for density checks (noocclude only).
      const allRects: { x: number; y: number; w: number; h: number }[] = [];
      if (labelStyle === "noocclude") {
        for (const [, area] of sortedEntries) {
          if (area.x + area.width < 0 || area.x > targetWidth ||
              area.y + area.height < 0 || area.y > targetHeight) continue;
          allRects.push({ x: area.x, y: area.y, w: area.width, h: area.height });
        }
      }

      // We need a temp 2D context just to measure pill sizes.
      // Create the FINAL canvas later with correct width.
      const measureCtx = await (async () => {
        if (typeof OffscreenCanvas !== "undefined") {
          return new OffscreenCanvas(1, 1).getContext("2d") as any;
        }
        if (typeof document !== "undefined") {
          return document.createElement("canvas").getContext("2d") as any;
        }
        return null;
      })();

      // ----------------------------------------------------------------
      // Sample canvas: a screenshot-sized scratch canvas used ONLY for
      // pixel-variance occlusion checks during placement classification.
      // We draw the captured screenshot onto it once, then sample candidate
      // pill regions to decide whether they sit on "empty" pixels (safe to
      // place opaque), "soft" pixels (mild gradient — inside but translucent),
      // or "busy" pixels (real content — reject inside, try outside/gutter).
      //
      // This is independent of the FINAL output canvas (which gets created
      // later with extra width for the gutter); keeping them separate avoids
      // re-reading the gutter strip and lets us classify before we know the
      // final width.
      // ----------------------------------------------------------------
      let sampleCtx: any = null;
      let sampleData: Uint8ClampedArray | null = null;
      if (labelStyle === "noocclude") {
        try {
          const sample = await createCanvasAny(targetWidth, targetHeight);
          sampleCtx = sample.ctx;
          if (sampleCtx) {
            sampleCtx.drawImage(loaded.img, 0, 0, targetWidth, targetHeight);
            const imageData = sampleCtx.getImageData(0, 0, targetWidth, targetHeight);
            sampleData = imageData.data as Uint8ClampedArray;
          }
        } catch {
          // Tainted canvas or unsupported env — fall back to geometry-only
          // classification by leaving sampleData null.
          sampleData = null;
        }
      }

      /**
       * Classify a pill-sized region of the screenshot by looking at the
       * underlying pixels.
       *
       *  - "empty" : flat & light (whitespace, padding, page background)
       *             → safe to draw an OPAQUE inside pill on top.
       *  - "soft"  : mild variance OR flat-but-coloured (e.g. a solid-colour
       *             button background) → draw inside but TRANSLUCENT so the
       *             underlying colour/icon stays visible.
       *  - "busy"  : high variance (real text / icon glyph / photo) → REJECT
       *             inside placement and try outside/gutter instead.
       *
       * The classifier reduces each pixel to luminance for variance, plus
       * tracks mean RGB so we can detect the "solid coloured" case (low
       * variance but non-white background — typical avatar circle / colour
       * chip / status pill). For speed we decimate by 2 in each axis (≅¼ the
       * pixels) which is plenty for ≅15-pixel-tall pills.
       */
      const VARIANCE_BUSY = 350;       // ≥ this → "busy"
      const VARIANCE_SOFT = 60;        // ≥ this (and < BUSY) → "soft"
      // Below this, pixels are essentially uniform — a single colour fill,
      // which means "background padding" regardless of what colour it is
      // (white form field, dark navy sidebar, orange button corner, etc.).
      // We treat such regions as fully empty so the pill renders opaque.
      const VARIANCE_FLAT = 15;
      const COLOURED_BG_THRESHOLD = 35; // mean R/G/B spread > this → not white-ish
      const classifyRegion = (x: number, y: number, w: number, h: number): "empty" | "soft" | "busy" => {
        if (!sampleData) return "empty"; // fallback: assume safe
        // Clamp to canvas bounds.
        const x0 = Math.max(0, Math.floor(x));
        const y0 = Math.max(0, Math.floor(y));
        const x1 = Math.min(targetWidth, Math.ceil(x + w));
        const y1 = Math.min(targetHeight, Math.ceil(y + h));
        if (x1 <= x0 || y1 <= y0) return "empty";
        let sum = 0, sumSq = 0, n = 0;
        let sumR = 0, sumG = 0, sumB = 0;
        const step = 2; // decimate
        for (let py = y0; py < y1; py += step) {
          let rowOffset = (py * targetWidth + x0) * 4;
          for (let px = x0; px < x1; px += step) {
            const r = sampleData[rowOffset];
            const g = sampleData[rowOffset + 1];
            const b = sampleData[rowOffset + 2];
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            sum += lum;
            sumSq += lum * lum;
            sumR += r; sumG += g; sumB += b;
            n++;
            rowOffset += 4 * step;
          }
        }
        if (n === 0) return "empty";
        const mean = sum / n;
        const variance = Math.max(0, sumSq / n - mean * mean);
        if (variance >= VARIANCE_BUSY) return "busy";
        // Truly uniform pixels = a single background colour. Doesn't matter
        // whether it's white (form field padding), dark navy (sidebar
        // padding), orange (button corner padding) or anything else — there
        // is no content here, so the pill can sit opaque on top.
        if (variance < VARIANCE_FLAT) return "empty";
        // Otherwise: there is *some* pixel variation in the candidate region.
        // For whitish/light-grey backgrounds with mild variance (e.g. faint
        // text antialiasing), classify as "soft" → translucent pill so any
        // underlying glyph stays partially visible.
        const meanR = sumR / n, meanG = sumG / n, meanB = sumB / n;
        const maxC = Math.max(meanR, meanG, meanB);
        const minC = Math.min(meanR, meanG, meanB);
        const colourSpread = maxC - minC;             // 0 = grey/white, large = saturated colour
        const isWhitish = mean >= 220 && colourSpread < 20;
        const isLightGrey = mean >= 200 && colourSpread < 12;
        if (isWhitish || isLightGrey) {
          return variance >= VARIANCE_SOFT ? "soft" : "empty";
        }
        // Coloured background with non-trivial variance: probably an icon
        // glyph or text on a saturated fill (avatar circle, status pill).
        // Small + saturated → reject (icon-sized centred glyphs); otherwise
        // allow translucent so the colour & glyph still show through.
        if (colourSpread > COLOURED_BG_THRESHOLD && w * h <= 24 * 24) {
          return "busy";
        }
        return "soft";
      };

      // Decide which elements need the gutter.
      type GutterEntry = {
        // Display id used for the pill text — may be a single index ("42") or
        // a combined cluster label ("16+17", "16-19").
        id: string;
        // Union rect of all members in the cluster (single-element clusters
        // collapse to that element's rect). Used to anchor the leader.
        area: { x: number; y: number; width: number; height: number };
        color: string;
        pillW: number;
        pillH: number;
      };
      const gutterEntries: GutterEntry[] = [];
      // `kind` distinguishes pills placed INSIDE the source element (which
      // get rendered with a translucent fill so underlying content is still
      // legible) from pills placed in adjacent OUTSIDE whitespace (fully
      // opaque since they don't sit over real content).
      // `side` (outside pills only) records which edge of the source element
      // the pill is anchored to, so the render pass can stamp a small
      // directional tick on the pill's element-facing edge. "top" means the
      // pill sits ABOVE its source (so the tick goes on the pill's BOTTOM
      // edge, pointing down at the source); etc.
      // `leaderFrom` is set for pills placed by the proximity-search step
      // (Step 2.5): the slot was found a few rings away from the element
      // (typically in modal padding or a row gap), so a thin orthogonal
      // leader is drawn from this source rect to the pill so the model can
      // still tell which element the pill labels. Pills placed inside the
      // source element or immediately adjacent (Step 1 / Step 2) leave this
      // undefined — they're close enough that the directional tick alone
      // suffices.
      // Keyed by *display id* (cluster label), not by individual element id.
      const inlinePosById = new Map<
        string,
        {
          x: number; y: number; w: number; h: number;
          kind: "inside" | "outside";
          opacity: number;
          side?: "top" | "right" | "bottom" | "left";
          leaderFrom?: { x: number; y: number; width: number; height: number };
        }
      >();

      // ----------------------------------------------------------------
      // Sibling clustering pre-pass (noocclude only).
      //
      // Many web layouts contain rows of small adjacent siblings that the
      // model treats as one widget but our scanner indexes individually:
      // checkbox+chip pairs in tag pickers, action-button pairs in list
      // rows, toolbar icon groups, etc. Without clustering each member
      // produces its own gutter pill and leader, creating a dense fan of
      // overlapping leaders that's hard to follow.
      //
      // The pre-pass groups *small same-row adjacent* siblings into a
      // single visual cluster. The cluster gets ONE combined pill drawn
      // at the cluster's union rect (e.g. labelled "16+17" or "16-19")
      // and ONE leader. Each individual member still gets its own dotted
      // bounding box and still appears in the structured element list,
      // so the model can target a specific index from the cluster — the
      // collapse is purely a screenshot-rendering optimisation.
      //
      // Eligible for clustering:
      //   - Both elements small (height ≤ 32, width ≤ 80).
      //   - Same row (centre-Y within 4 px AND heights within 6 px).
      //   - Horizontal gap between them is small (≤ 8 px).
      //   - Cluster has not yet hit MAX_CLUSTER_SIZE.
      // ----------------------------------------------------------------
      type ElementMember = {
        id: string;
        area: { x: number; y: number; width: number; height: number };
      };
      type PlacementUnit = {
        displayId: string;
        rect: { x: number; y: number; width: number; height: number };
        members: ElementMember[];
      };
      const formatClusterDisplayId = (ids: string[]): string => {
        if (ids.length === 1) return ids[0];
        const nums = ids.map(s => parseInt(s, 10));
        const allInt = nums.every(n => !isNaN(n));
        if (allInt) {
          let contiguous = true;
          for (let i = 1; i < nums.length; i++) {
            if (nums[i] !== nums[i - 1] + 1) { contiguous = false; break; }
          }
          if (contiguous) return `${nums[0]}-${nums[nums.length - 1]}`;
        }
        if (ids.length === 2) return `${ids[0]}+${ids[1]}`;
        return ids.join(",");
      };
      const buildPlacementUnits = (): PlacementUnit[] => {
        if (labelStyle !== "noocclude") {
          // Legacy path doesn't cluster.
          return sortedEntries.map(([id, a]) => ({
            displayId: id,
            rect: { x: a.x, y: a.y, width: a.width, height: a.height },
            members: [{ id, area: { x: a.x, y: a.y, width: a.width, height: a.height } }],
          }));
        }
        const MAX_CLUSTER_SIZE = 6;
        const SMALL_H_MAX = 32;
        const SMALL_W_MAX = 80;
        const ROW_Y_TOL = 4;
        const ROW_H_TOL = 6;
        const X_GAP_MAX = 8;
        // Walk in document order: top-to-bottom, then left-to-right within row.
        const docOrder = sortedEntries.slice().sort((a, b) => {
          const ay = a[1].y, by = b[1].y;
          if (Math.abs(ay - by) > ROW_Y_TOL) return ay - by;
          return a[1].x - b[1].x;
        });
        const unitsByFirstId = new Map<string, PlacementUnit>();
        const memberToUnit = new Map<string, PlacementUnit>();
        let current: PlacementUnit | null = null;
        for (const [id, a] of docOrder) {
          const member: ElementMember = { id, area: { x: a.x, y: a.y, width: a.width, height: a.height } };
          const isSmall = a.height <= SMALL_H_MAX && a.width <= SMALL_W_MAX;
          let attached = false;
          if (current && isSmall) {
            const last = current.members[current.members.length - 1];
            const la = last.area;
            const sameRow =
              Math.abs((la.y + la.height / 2) - (a.y + a.height / 2)) <= ROW_Y_TOL &&
              Math.abs(la.height - a.height) <= ROW_H_TOL;
            const xGap = a.x - (la.x + la.width);
            const closeEnough = xGap >= -2 && xGap <= X_GAP_MAX;
            const lastWasSmall = la.height <= SMALL_H_MAX && la.width <= SMALL_W_MAX;
            if (sameRow && closeEnough && lastWasSmall && current.members.length < MAX_CLUSTER_SIZE) {
              current.members.push(member);
              const ux = Math.min(current.rect.x, a.x);
              const uy = Math.min(current.rect.y, a.y);
              const ur = Math.max(current.rect.x + current.rect.width, a.x + a.width);
              const ub = Math.max(current.rect.y + current.rect.height, a.y + a.height);
              current.rect = { x: ux, y: uy, width: ur - ux, height: ub - uy };
              memberToUnit.set(id, current);
              attached = true;
            }
          }
          if (!attached) {
            current = {
              displayId: id, // finalised after all members collected
              rect: { x: a.x, y: a.y, width: a.width, height: a.height },
              members: [member],
            };
            unitsByFirstId.set(id, current);
            memberToUnit.set(id, current);
          }
        }
        // Finalise display ids and return units in placement order (largest first).
        const units = Array.from(unitsByFirstId.values());
        for (const u of units) {
          u.displayId = formatClusterDisplayId(u.members.map(m => m.id));
        }
        units.sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height);
        return units;
      };
      const placementUnits = buildPlacementUnits();

      const colors = [
        "#FF0000", "#00FF00", "#0000FF", "#FFA500", "#800080",
        "#008080", "#FF69B4", "#4B0082", "#FF4500", "#2E8B57",
        "#DC143C", "#4682B4",
      ];

      // ----------------------------------------------------------------
      // Placement helpers shared by per-element placement (forEach below)
      // and the dense-band proximity step further down. Hoisted out of
      // the placement block so the same logic applies to BOTH individual
      // pills and collapsed row-range pills (e.g. "18-26") — letting a
      // row that can't fit individual pills find nearby empty space for
      // the combined range pill instead of falling all the way to the
      // right-edge gutter.
      // ----------------------------------------------------------------
      // Helper: does the rect (l,t,w,h) overlap any element rect EXCEPT
      // the source element? Used to validate outside-pill candidates.
      const overlapsOtherElement = (
        l: number, t: number, w: number, h: number,
        srcX: number, srcY: number, srcW: number, srcH: number,
      ): boolean => {
        for (const r of allRects) {
          if (r.x === srcX && r.y === srcY && r.w === srcW && r.h === srcH) continue;
          if (l < r.x + r.w && l + w > r.x && t < r.y + r.h && t + h > r.y) return true;
        }
        return false;
      };
      // Helper: does the rect collide with any already-placed inline pill?
      const overlapsPlacedPill = (l: number, t: number, w: number, h: number): boolean => {
        for (const p of inlinePosById.values()) {
          if (l < p.x + p.w && l + w > p.x && t < p.y + p.h && t + h > p.y) return true;
        }
        return false;
      };
      // Helper: candidate fully on-canvas?
      const onCanvas = (l: number, t: number, w: number, h: number): boolean =>
        l >= 0 && t >= 0 && l + w <= targetWidth && t + h <= targetHeight;

      // Helper: NEAREST-EMPTY proximity search.
      //
      // Performs an EXPANDING-RING search around the given source rect,
      // looking for empty pixel regions where a pill of size pillW x pillH
      // can sit cleanly without overlapping other elements or already-
      // placed pills. Returns the closest valid slot, or null if no empty
      // region was found within MAX_NEARBY_RADIUS px.
      //
      // Used in two places:
      //   (a) Per-element "Step 2.5" — when the 12 fixed adjacent slots
      //       all fail (typical for dense grids like emoji pickers).
      //   (b) Per-row "band proximity" — when an entire dense row falls
      //       to the gutter, the band-collapse range pill ("18-26") tries
      //       to find empty space near the row before being routed to the
      //       right-edge gutter.
      //
      // The caller is expected to draw a thin orthogonal leader from the
      // source rect to the pill so the model can still tell which element
      // (or row of elements) the pill labels.
      const findNearbyEmptySlot = (
        area: { x: number; y: number; width: number; height: number },
        pillW: number,
        pillH: number,
      ): { x: number; y: number; side: "top" | "right" | "bottom" | "left" } | null => {
        if (!sampleData) return null;
        const MAX_NEARBY_RADIUS = Math.min(
          Math.max(targetWidth, targetHeight) / 3,
          240,
        );
        const RING_STEP = Math.max(pillH, 6);
        // Cardinal first (cheaper & visually cleaner), diagonals last.
        const dirs: Array<{
          dx: number; dy: number;
          side: "top" | "right" | "bottom" | "left";
          diag: boolean;
        }> = [
          { dx: 0, dy: 1, side: "top", diag: false },     // below
          { dx: 0, dy: -1, side: "bottom", diag: false }, // above
          { dx: 1, dy: 0, side: "left", diag: false },    // right
          { dx: -1, dy: 0, side: "right", diag: false },  // left
          { dx: 1, dy: 1, side: "top", diag: true },      // below-right
          { dx: -1, dy: 1, side: "top", diag: true },     // below-left
          { dx: 1, dy: -1, side: "bottom", diag: true },  // above-right
          { dx: -1, dy: -1, side: "bottom", diag: true }, // above-left
        ];
        type NearCand = {
          x: number; y: number;
          side: "top" | "right" | "bottom" | "left";
          dist: number;
        };
        for (let r = RING_STEP; r <= MAX_NEARBY_RADIUS; r += RING_STEP) {
          const ringCands: NearCand[] = [];
          for (const d of dirs) {
            if (d.diag) {
              const baseX = d.dx > 0 ? area.x + area.width + r : area.x - r - pillW;
              const baseY = d.dy > 0 ? area.y + area.height + r : area.y - r - pillH;
              ringCands.push({ x: baseX, y: baseY, side: d.side, dist: r * 1.4 });
              continue;
            }
            if (d.dx === 0) {
              // Vertical (above/below): sweep across the source's width so
              // we can drift to a nearby gap to the left/right.
              const baseY = d.dy > 0 ? area.y + area.height + r : area.y - r - pillH;
              const sweepCount = 5;
              for (let s = 0; s < sweepCount; s++) {
                const t = s / (sweepCount - 1);
                const span = area.width + pillW;
                const x = area.x + (area.width / 2) - (pillW / 2)
                  + (t - 0.5) * span;
                const offsetPenalty = Math.abs(t - 0.5) * 4;
                ringCands.push({ x, y: baseY, side: d.side, dist: r + offsetPenalty });
              }
            } else {
              // Horizontal (left/right): sweep across the source's height.
              const baseX = d.dx > 0 ? area.x + area.width + r : area.x - r - pillW;
              const sweepCount = 3;
              for (let s = 0; s < sweepCount; s++) {
                const t = s / (sweepCount - 1);
                const span = area.height + pillH;
                const y = area.y + (area.height / 2) - (pillH / 2)
                  + (t - 0.5) * span;
                const offsetPenalty = Math.abs(t - 0.5) * 4;
                ringCands.push({ x: baseX, y, side: d.side, dist: r + offsetPenalty });
              }
            }
          }
          // Closest candidates first.
          ringCands.sort((a, b) => a.dist - b.dist);
          for (const c of ringCands) {
            const lx = Math.round(c.x);
            const ly = Math.round(c.y);
            if (!onCanvas(lx, ly, pillW, pillH)) continue;
            if (overlapsOtherElement(lx, ly, pillW, pillH, area.x, area.y, area.width, area.height)) continue;
            if (overlapsPlacedPill(lx, ly, pillW, pillH)) continue;
            // Wider search demands a stricter classifier: only land on
            // truly "empty" regions. "soft" regions are typically very
            // close to busy content and would hurt readability when the
            // pill is far from the source.
            if (classifyRegion(lx, ly, pillW, pillH) !== "empty") continue;
            return { x: lx, y: ly, side: c.side };
          }
        }
        return null;
      };

      if (labelStyle === "noocclude" && measureCtx) {
        placementUnits.forEach((unit, idx) => {
          const area = unit.rect;
          const id = unit.displayId;
          if (area.x + area.width < 0 || area.x > targetWidth ||
              area.y + area.height < 0 || area.y > targetHeight) return;
          const color = colors[idx % colors.length];
          // Measure pill for this id.
          const m = measureNooccludePill(measureCtx, id, area.height);
          const pad = 1;
          const gap = 2;

          // ============================================================
          // Step 1: Try INSIDE corners (top-right preferred). Accept if the
          // element is just big enough to fit the pill with a tiny inset.
          // ============================================================
          const insideCandidates = [
            // Top-right
            { x: area.x + area.width - m.width - pad, y: area.y + pad },
            // Top-left
            { x: area.x + pad, y: area.y + pad },
            // Bottom-right
            { x: area.x + area.width - m.width - pad, y: area.y + area.height - m.height - pad },
            // Bottom-left
            { x: area.x + pad, y: area.y + area.height - m.height - pad },
          ];
          // Reject "too short" elements (chips, avatars, single-line links)
          // even if they geometrically fit a pill: their content is
          // typically centred and fills the whole element, so any inside
          // corner sits over real text. 28 px keeps tag chips (~22 px) and
          // avatar circles (~28 px) out of the inside path while letting
          // sidebar items (~36 px) and form rows (~30+ px) qualify.
          const MIN_INSIDE_HEIGHT = 28;
          const fitsInside =
            area.width >= m.width + pad * 2 &&
            area.height >= m.height + pad * 2 &&
            area.height >= MIN_INSIDE_HEIGHT;
          if (fitsInside) {
            for (const c of insideCandidates) {
              const lx = Math.round(c.x);
              const ly = Math.round(c.y);
              if (!onCanvas(lx, ly, m.width, m.height)) continue;
              // Inside placement is by construction inside the source element,
              // so we ONLY need to avoid landing on a previously-placed pill.
              if (overlapsPlacedPill(lx, ly, m.width, m.height)) continue;
              // Pixel-variance occlusion check: skip corners that sit over
              // real content; record translucent for soft regions.
              const cls = classifyRegion(lx, ly, m.width, m.height);
              if (cls === "busy") continue;
              const opacity = cls === "empty" ? 1 : 0.6;
              inlinePosById.set(id, { x: lx, y: ly, w: m.width, h: m.height, kind: "inside", opacity });
              return;
            }
          }

          // ============================================================
          // Step 2: Try OUTSIDE positions adjacent to the element, in order
          // of preference (bottom > top > right > left, centered). The pill
          // must not overlap any OTHER element rect or any already-placed
          // pill. This handles avatar-style elements that are too small to
          // host a pill but have whitespace right beneath them.
          // ============================================================
          const outsideCandidates: Array<{ x: number; y: number; side: "top" | "right" | "bottom" | "left" }> = [
            // Below center
            { x: area.x + (area.width - m.width) / 2, y: area.y + area.height + gap, side: "top" },
            // Below-right
            { x: area.x + area.width - m.width, y: area.y + area.height + gap, side: "top" },
            // Below-left
            { x: area.x, y: area.y + area.height + gap, side: "top" },
            // Above center
            { x: area.x + (area.width - m.width) / 2, y: area.y - m.height - gap, side: "bottom" },
            // Above-right
            { x: area.x + area.width - m.width, y: area.y - m.height - gap, side: "bottom" },
            // Above-left
            { x: area.x, y: area.y - m.height - gap, side: "bottom" },
            // Right middle
            { x: area.x + area.width + gap, y: area.y + (area.height - m.height) / 2, side: "left" },
            // Right top
            { x: area.x + area.width + gap, y: area.y, side: "left" },
            // Right bottom
            { x: area.x + area.width + gap, y: area.y + area.height - m.height, side: "left" },
            // Left middle
            { x: area.x - m.width - gap, y: area.y + (area.height - m.height) / 2, side: "right" },
            // Left top
            { x: area.x - m.width - gap, y: area.y, side: "right" },
            // Left bottom
            { x: area.x - m.width - gap, y: area.y + area.height - m.height, side: "right" },
          ];
          for (const c of outsideCandidates) {
            const lx = Math.round(c.x);
            const ly = Math.round(c.y);
            if (!onCanvas(lx, ly, m.width, m.height)) continue;
            if (overlapsOtherElement(lx, ly, m.width, m.height, area.x, area.y, area.width, area.height)) continue;
            if (overlapsPlacedPill(lx, ly, m.width, m.height)) continue;
            // Even outside-adjacent slots can land on real content (e.g. the
            // line of text directly below a small link). Skip busy regions;
            // accept empty/soft (outside pills are always opaque since they
            // don't sit on the source element itself).
            if (classifyRegion(lx, ly, m.width, m.height) === "busy") continue;
            inlinePosById.set(id, { x: lx, y: ly, w: m.width, h: m.height, kind: "outside", opacity: 1, side: c.side });
            return;
          }

          // ============================================================
          // Step 2.5: NEAREST-EMPTY proximity search.
          //
          // The 12 fixed adjacent candidates above only check positions
          // touching the source element's edge. Dense layouts (emoji
          // pickers, tag-picker rows, calendar grids, keyboard-like
          // controls) typically have no whitespace at the immediate edge
          // but DO have whitespace a few pixels further out — between
          // rows of cells, in modal padding, in margins between columns.
          //
          // findNearbyEmptySlot() performs an EXPANDING-RING search and
          // returns the closest valid slot (or null). Pills placed by
          // this step get a thin orthogonal leader from the source to
          // the pill so the element they label is still unambiguous.
          //
          // Falls through to the gutter (Step 3) only when no nearby
          // empty region is found.
          // ============================================================
          {
            const slot = findNearbyEmptySlot(area, m.width, m.height);
            if (slot) {
              inlinePosById.set(id, {
                x: slot.x, y: slot.y, w: m.width, h: m.height,
                kind: "outside", opacity: 1, side: slot.side,
                leaderFrom: { x: area.x, y: area.y, width: area.width, height: area.height },
              });
              return;
            }
          }

          // ============================================================
          // Step 3: Last resort - route to gutter.
          // ============================================================
          gutterEntries.push({ id, area, color, pillW: m.width, pillH: m.height });
        });
      }

      // ----------------------------------------------------------------
      // Gutter layout (Y-binned lane allocation).
      //
      // Each gutter pill is positioned at a y-coordinate derived from its
      // source element's centre-Y, so leaders run mostly horizontally and
      // pills appear to the right of "their" row. When two pills want the
      // same vertical band, the second spills into a new column — this
      // produces a layout that mirrors the screenshot's vertical structure
      // instead of a tightly-packed top-to-bottom stack.
      // ----------------------------------------------------------------
      const gutterPadding = 8;        // gap between screenshot and gutter
      const gutterColGap = 6;         // gap between gutter sub-columns
      const gutterRowGap = 4;         // gap between stacked pills in a column
      type GutterPlacement = { entry: GutterEntry; col: number; py: number };
      const gutterPlacements: GutterPlacement[] = [];
      let gutterColW = 0;
      // ----------------------------------------------------------------
      // Gutter routing for dense bands uses a **range-pill + bracket**
      // overlay instead of a fan of per-element pills:
      //
      //   - Gutter entries are bucketed by source-Y in BAND_PX bins.
      //   - Buckets with ≥ DENSE_THRESHOLD entries (e.g. tag-picker rows
      //     of checkbox+chip pairs) are collapsed into a SINGLE synthetic
      //     gutter entry whose label is the numeric range ("16-26").
      //   - A thin amber bracket is drawn on the screenshot just below
      //     the band, spanning the band's element X-extent, so the model
      //     can see exactly which row of elements the range covers.
      //   - The model refers to elements within the range by their
      //     visible text/colour ("click 19, the BACKEND chip").
      //   - Sparse entries (singletons or small bands) keep their normal
      //     1:1 right-gutter pills with orthogonal leaders.
      // ----------------------------------------------------------------
      const BAND_PX = 32;
      const DENSE_THRESHOLD = 4;
      type Band = { sourceBottom: number; entries: GutterEntry[] };
      const bandsMap = new Map<number, Band>();
      for (const g of gutterEntries) {
        const cy = g.area.y + g.area.height / 2;
        const key = Math.round(cy / BAND_PX);
        let b = bandsMap.get(key);
        if (!b) {
          b = { sourceBottom: g.area.y + g.area.height, entries: [] };
          bandsMap.set(key, b);
        }
        b.sourceBottom = Math.max(b.sourceBottom, g.area.y + g.area.height);
        b.entries.push(g);
      }
      // Merge adjacent (or overlapping-Y) bins so a row whose centre-Y
      // straddles a 32-px boundary doesn't get split into two half-bands
      // (which would dodge the dense-threshold and leak per-element pills
      // into the gutter).
      type RawBand = { minY: number; maxY: number; entries: GutterEntry[] };
      const rawBands: RawBand[] = Array.from(bandsMap.values()).map(b => {
        let minY = Infinity, maxY = -Infinity;
        for (const e of b.entries) {
          minY = Math.min(minY, e.area.y);
          maxY = Math.max(maxY, e.area.y + e.area.height);
        }
        return { minY, maxY, entries: b.entries };
      }).sort((a, b) => a.minY - b.minY);
      const mergedBands: RawBand[] = [];
      for (const rb of rawBands) {
        const last = mergedBands[mergedBands.length - 1];
        // Merge if the new band's Y-range overlaps or is within 6 px of
        // the previous band's Y-range — i.e. they are visually the same
        // row, just split by the bin boundary.
        if (last && rb.minY <= last.maxY + 6) {
          last.maxY = Math.max(last.maxY, rb.maxY);
          last.entries.push(...rb.entries);
        } else {
          mergedBands.push({ minY: rb.minY, maxY: rb.maxY, entries: rb.entries.slice() });
        }
      }
      const denseBands: Band[] = [];
      const sparseGutterEntries: GutterEntry[] = [];
      for (const rb of mergedBands) {
        if (rb.entries.length >= DENSE_THRESHOLD) {
          denseBands.push({ sourceBottom: rb.maxY, entries: rb.entries });
        } else {
          sparseGutterEntries.push(...rb.entries);
        }
      }

      // Enclosing-box overlays drawn around the source elements of each
      // dense band. The synthetic gutter entry's leader is anchored at
      // the RIGHT-EDGE midpoint of this box (no centre dot), so the eye
      // can trace from the gutter pill straight back to a single
      // unmistakable rectangle that contains every element in the range.
      type BandBoxRender = {
        x: number; y: number; w: number; h: number;
        rightX: number; midY: number;
      };
      const bandBoxRenders: BandBoxRender[] = [];
      // Band range-pills (e.g. "18-26") that found nearby empty space
      // via findNearbyEmptySlot and therefore stay INLINE on the
      // screenshot instead of being routed to the right-edge gutter.
      // Each entry pairs the pill rect (with its directional `side`)
      // with the band's bounding box so the render pass can draw a thin
      // orthogonal leader from the box to the pill.
      type BandInlinePill = {
        id: string;
        x: number; y: number; w: number; h: number;
        side: "top" | "right" | "bottom" | "left";
        leaderFrom: { x: number; y: number; width: number; height: number };
      };
      const bandInlinePills: BandInlinePill[] = [];
      // Track which gutter entries are synthetic band-pills so the render
      // pass knows to skip the centre dot and start the leader at the
      // box's right edge instead of the (now meaningless) area centre.
      const synthBandEntries = new Set<GutterEntry>();
      // Element ids absorbed into a band-box. The render pass uses this
      // set to (a) skip the per-element dotted bounding-box border and
      // (b) skip the inline pill, so the band-box + range pill becomes
      // the only annotation for these elements.
      const absorbedElementIds = new Set<string>();
      for (const band of denseBands) {
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxBottom = -Infinity;
        const allIds: string[] = [];
        const memberIdSet = new Set<string>();
        const collectMember = (id: string, area: { x: number; y: number; width: number; height: number }) => {
          minX = Math.min(minX, area.x);
          maxX = Math.max(maxX, area.x + area.width);
          minY = Math.min(minY, area.y);
          maxBottom = Math.max(maxBottom, area.y + area.height);
          const nums = id.split(/[-+,]/).map(s => parseInt(s, 10)).filter(n => !isNaN(n));
          for (const n of nums) {
            allIds.push(String(n));
            memberIdSet.add(String(n));
          }
        };
        for (const g of band.entries) collectMember(g.id, g.area);
        if (allIds.length === 0) continue;

        // Absorption pass: scan placementUnits for any unit (inline pill
        // or otherwise) that visually belongs to this row but escaped
        // gutter routing because it found an inline slot. Typical cases:
        //   - The leftmost checkbox of a tag picker (whitespace to its
        //     left → got an outside-left pill, not a gutter pill).
        //   - The rightmost chip flush against the modal edge (got an
        //     inside-corner pill).
        // We absorb a unit if its centre-Y falls inside the band's Y
        // range (with small tolerance). X is intentionally NOT checked:
        // any element vertically inside the band's row belongs to the
        // row, even if its inline pill drifted far horizontally.
        const Y_TOL = 8;
        const initialMinY = minY, initialMaxBottom = maxBottom;
        for (const unit of placementUnits) {
          // Numeric tokens for this unit's display id.
          const unitNums = unit.displayId.split(/[-+,]/).map(s => parseInt(s, 10)).filter(n => !isNaN(n)).map(String);
          if (unitNums.length === 0) continue;
          // Skip if any of this unit's ids is already a band member.
          if (unitNums.some(n => memberIdSet.has(n))) continue;
          const r = unit.rect;
          const cy = r.y + r.height / 2;
          const yIn = cy >= initialMinY - Y_TOL && cy <= initialMaxBottom + Y_TOL;
          if (!yIn) continue;
          // Absorb: drop its inline pill (so the render pass skips it)
          // and fold its members into the band.
          inlinePosById.delete(unit.displayId);
          collectMember(unit.displayId, r);
          for (const n of unitNums) memberIdSet.add(n);
        }
        // Mark every member of the (possibly expanded) band for
        // border/pill suppression.
        for (const n of memberIdSet) absorbedElementIds.add(n);

        // Sort numerically + dedupe so formatClusterDisplayId picks the
        // most compact representation: contiguous → "30-39", pair → "16+17",
        // otherwise comma-separated list.
        const uniqIds = Array.from(new Set(allIds)).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
        const rangeId = formatClusterDisplayId(uniqIds);
        const m = measureNooccludePill(measureCtx!, rangeId);
        // Inflate the band's union rect slightly so the enclosing box
        // doesn't sit exactly on top of the per-element dotted borders.
        const PAD = 3;
        const boxX = Math.max(0, minX - PAD);
        const boxY = Math.max(0, minY - PAD);
        const boxW = Math.min(targetWidth, maxX + PAD) - boxX;
        const boxH = Math.min(targetHeight, maxBottom + PAD) - boxY;
        const rightX = boxX + boxW;
        const midY = boxY + boxH / 2;
        bandBoxRenders.push({ x: boxX, y: boxY, w: boxW, h: boxH, rightX, midY });
        // ----------------------------------------------------------------
        // Band-proximity step: try to place the range pill in nearby empty
        // space (inline on the screenshot) BEFORE falling through to the
        // gutter. This handles dense rows like emoji-picker grids where
        // every individual element fell to gutter — the row collapses to
        // a single "18-26" pill which we now try to seat in the modal
        // padding right next to the row, with a short orthogonal leader
        // from the band-box to the pill. Only when no nearby empty space
        // exists does the range pill go to the right-edge gutter.
        // ----------------------------------------------------------------
        const bandRect = { x: boxX, y: boxY, width: boxW, height: boxH };
        const bandSlot = findNearbyEmptySlot(bandRect, m.width, m.height);
        if (bandSlot) {
          bandInlinePills.push({
            id: rangeId,
            x: bandSlot.x, y: bandSlot.y, w: m.width, h: m.height,
            side: bandSlot.side,
            leaderFrom: bandRect,
          });
          // Also record in inlinePosById so subsequent bands' proximity
          // searches treat this pill as an obstacle.
          inlinePosById.set(rangeId, {
            x: bandSlot.x, y: bandSlot.y, w: m.width, h: m.height,
            kind: "outside", opacity: 1, side: bandSlot.side,
            leaderFrom: bandRect,
          });
          continue;
        }
        // The synthetic gutter entry's "area" is a 1-px slice on the
        // right edge of the enclosing box, so the orthogonal leader exits
        // exactly at the right-edge midpoint with no horizontal travel
        // along the source rect.
        const synth: GutterEntry = {
          id: rangeId,
          area: { x: rightX - 1, y: Math.round(midY) - 1, width: 1, height: 2 },
          color: '#FF00FF',
          pillW: m.width,
          pillH: m.height,
        };
        sparseGutterEntries.push(synth);
        synthBandEntries.add(synth);
      }

      let gutterCols = 0;
      let totalGutterW = 0;
      if (sparseGutterEntries.length > 0) {
        for (const g of sparseGutterEntries) {
          if (g.pillW > gutterColW) gutterColW = g.pillW;
          if (g.pillH === 0) g.pillH = 14;
        }
        gutterColW = gutterColW || 24;
        // Sort by source element centre-Y so lanes fill top-to-bottom.
        sparseGutterEntries.sort((a, b) => {
          const ay = a.area.y + a.area.height / 2;
          const by = b.area.y + b.area.height / 2;
          if (ay !== by) return ay - by;
          return (a.area.x + a.area.width / 2) - (b.area.x + b.area.width / 2);
        });
        // lane[i] = next-free Y for column i (initially 4 = top padding).
        const laneNextY: number[] = [];
        for (const g of sparseGutterEntries) {
          const ec = g.area.y + g.area.height / 2;
          const desiredY = Math.max(
            4,
            Math.min(Math.round(ec - g.pillH / 2), targetHeight - g.pillH - 4),
          );
          // Find the leftmost lane where we can sit at desiredY (i.e. lane's
          // next free Y ≤ desiredY). Otherwise open a new lane.
          let col = -1;
          for (let i = 0; i < laneNextY.length; i++) {
            if (desiredY >= laneNextY[i]) { col = i; break; }
          }
          if (col === -1) {
            laneNextY.push(4);
            col = laneNextY.length - 1;
          }
          const py = Math.max(desiredY, laneNextY[col]);
          laneNextY[col] = py + g.pillH + gutterRowGap;
          gutterPlacements.push({ entry: g, col, py });
        }
        gutterCols = laneNextY.length;
        totalGutterW = gutterPadding + gutterCols * gutterColW + (gutterCols - 1) * gutterColGap + 4;
      }

      const canvasWidth = targetWidth + totalGutterW;
      const canvasHeight = targetHeight;

      const { ctx, exportDataUrl } = await createCanvasAny(
        canvasWidth,
        canvasHeight
      );
      if (!ctx) {
        reject(new Error("Failed to get canvas context"));
        return;
      }

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      // Fill any extension area (right gutter) with white first.
      if (totalGutterW > 0) {
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(targetWidth, 0, totalGutterW, canvasHeight);
        // Subtle separator between screenshot and gutter.
        ctx.strokeStyle = '#CCCCCC';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(targetWidth + 0.5, 0);
        ctx.lineTo(targetWidth + 0.5, canvasHeight);
        ctx.stroke();
      }
      // Draw the original screenshot at (0,0).
      ctx.drawImage(loaded.img, 0, 0, targetWidth, targetHeight);

      if (labelStyle === "noocclude") {
        // 1. Draw bounding boxes for ALL individual elements (not clusters).
        //    Each interactive element keeps its own dotted box so the model
        //    can still see exactly where every indexed element lives, even
        //    when several share a single combined cluster pill. Elements
        //    absorbed into a dense band-box are skipped — the band-box
        //    already encloses them and individual borders would just be
        //    visual noise inside it.
        for (const [id, area] of sortedEntries) {
          if (area.x + area.width < 0 || area.x > targetWidth ||
              area.y + area.height < 0 || area.y > targetHeight) continue;
          if (absorbedElementIds.has(id)) continue;
          drawNooccludeBorder(ctx, area, '#FF00FF');
        }
        // 2. Draw inline pills (one per placement unit / cluster). Opacity
        //    is per-pill, decided during classification: 1.0 for outside
        //    pills and inside pills landing on truly empty pixels; ~0.6
        //    for inside pills landing on "soft" regions. Units absorbed
        //    into a dense band-box are skipped (their inlinePosById entry
        //    was already removed during the absorption pass).
        //    For pills placed by the proximity-search step (Step 2.5),
        //    `leaderFrom` is set: draw a thin orthogonal leader from the
        //    source element to the pill so the model can still tell which
        //    element the pill labels. We suppress the directional tick on
        //    leadered pills so the leader's entry point isn't visually
        //    fighting a tick on the same edge.
        for (const unit of placementUnits) {
          const pos = inlinePosById.get(unit.displayId);
          if (!pos) continue;
          if (pos.leaderFrom) {
            drawOrthogonalLeaderTo(
              ctx,
              pos.leaderFrom.x, pos.leaderFrom.y,
              pos.leaderFrom.width, pos.leaderFrom.height,
              pos.x, pos.y, pos.w, pos.h,
              '#FF00FF',
            );
          }
          drawNooccludePillAt(
            ctx, unit.displayId, pos.x, pos.y, '#FF00FF', pos.opacity,
            pos.kind === "outside" && !pos.leaderFrom ? (pos.side ?? null) : null,
          );
        }
        // 3. Draw gutter pills using Y-binned placements + orthogonal
        //    (right-angle) leaders. Leaders are drawn BEFORE the pill so
        //    the pill sits on top of any incoming line.
        if (gutterPlacements.length > 0) {
          const colStartX = targetWidth + gutterPadding;
          for (const gp of gutterPlacements) {
            const g = gp.entry;
            const colLeft = colStartX + gp.col * (gutterColW + gutterColGap);
            const px = Math.round(colLeft + (gutterColW - g.pillW) / 2);
            const py = gp.py;
            const isSynth = synthBandEntries.has(g);
            // For synthetic band-pills, anchor the leader at the right
            // edge midpoint of the enclosing band-box (no centre dot).
            const dotX = isSynth ? g.area.x + g.area.width : undefined;
            const dotY = isSynth ? g.area.y + g.area.height / 2 : undefined;
            drawOrthogonalLeaderTo(
              ctx,
              g.area.x, g.area.y, g.area.width, g.area.height,
              px, py, g.pillW, g.pillH,
              '#FF00FF',
              dotX, dotY, isSynth,
            );
            drawNooccludePillAt(ctx, g.id, px, py, '#FF00FF');
          }
        }
        // 4. Draw enclosing band-boxes for dense rows. The box wraps the
        //    union rect of all elements in the band with a thicker solid
        //    magenta border so the eye can immediately associate the
        //    range pill (e.g. "19-29") with the row of elements it
        //    represents. The leader from the band's range pill (whether
        //    inline or in the gutter) points at the right edge of this
        //    box, not at any single element inside it.
        if (bandBoxRenders.length > 0) {
          ctx.save();
          ctx.strokeStyle = '#FF00FF';
          ctx.lineWidth = 2;
          ctx.globalAlpha = 0.85;
          ctx.setLineDash([]);
          for (const bb of bandBoxRenders) {
            ctx.strokeRect(bb.x + 0.5, bb.y + 0.5, bb.w - 1, bb.h - 1);
          }
          ctx.restore();
        }
        // 5. Draw band range-pills that found nearby empty space (inline,
        //    not in the gutter). Each pill gets an orthogonal leader from
        //    the band-box to the pill so the eye can trace from the row
        //    of elements straight to the range label.
        for (const bp of bandInlinePills) {
          drawOrthogonalLeaderTo(
            ctx,
            bp.leaderFrom.x, bp.leaderFrom.y,
            bp.leaderFrom.width, bp.leaderFrom.height,
            bp.x, bp.y, bp.w, bp.h,
            '#FF00FF',
            undefined, undefined, true, // suppress centre dot — the band-box already marks the source
          );
          drawNooccludePillAt(ctx, bp.id, bp.x, bp.y, '#FF00FF');
        }
      } else {
        // Legacy: solid border + tinted background fill.
        sortedEntries.forEach(([id, area], index) => {
          const color = colors[index % colors.length];
          if (area.width * area.height < 40000) {
            ctx.fillStyle = color + "1A";
            ctx.fillRect(area.x, area.y, area.width, area.height);
          }
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.strokeRect(area.x, area.y, area.width, area.height);
          drawLegacyLabel(ctx, id, area, color);
        });
      }

      // Export the image
      const out = await exportDataUrl(screenshot.imageType);
      resolve(out);
    } catch (error) {
      reject(error);
    }
  });
}
