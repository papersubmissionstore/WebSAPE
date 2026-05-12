/**
 * DOM-A11y Tree Builder
 * 
 * Alternative to build_dom_tree.ts that uses the Chrome DevTools Protocol
 * Accessibility API to build the element tree. This provides a more accurate
 * representation of what screen readers see and can be more reliable for
 * element identification.
 * 
 * This module is designed to work with browser_labels.ts screenshot_and_html method.
 */

import type { CDPSession, Page } from "playwright";
import {
  buildA11yTreeFromCDP,
  A11yTreeNode,
  A11yTreeResult,
  traverseA11yTree,
} from "./a11y_tree";
import config from "../../config";
import { INTERACTIVE_ROLES } from "./interactive_roles";

export { INTERACTIVE_ROLES } from "./interactive_roles";

// ============================================================================
// Types matching build_dom_tree.ts output format
// ============================================================================

export interface A11yElementResult {
  element_str: string;
  client_rect: { width: number; height: number };
  selector_map?: Record<number, A11yTreeNode>;
  area_map?: Record<number, { x: number; y: number; width: number; height: number }>;
}

export interface A11yHighlightInfo {
  index: number;
  node: A11yTreeNode;
  boundingBox: { x: number; y: number; width: number; height: number } | null;
  // Real DOM attributes resolved via CDP DOM.describeNode
  // These are the actual HTML attributes, not inferred from a11y tree
  domTag?: string; // Actual DOM tag name (e.g., 'DIV', 'BUTTON', 'SELECT')
  domId?: string; // DOM id attribute
  domClass?: string; // DOM class attribute
  domName?: string; // DOM name attribute (for form elements)
  domType?: string; // DOM type attribute (for input elements)
  domTitle?: string; // DOM title attribute
  domAriaLabel?: string; // DOM aria-label attribute (actual, not computed)
  domHref?: string; // DOM href attribute (for links)
  domAlt?: string; // DOM alt attribute (for images)
  domValue?: string; // DOM value attribute
  domPlaceholder?: string; // DOM placeholder attribute
  domTextContent?: string; // DOM textContent (for selector matching consistency)
}

// ============================================================================
// Interactive Role Detection
// ============================================================================

/**
 * Check if an A11y node represents an interactive element
 */
function isInteractiveNode(node: A11yTreeNode): boolean {
  // Check role
  if (INTERACTIVE_ROLES.has(node.role)) {
    return true;
  }
  
  // Check for focusable property
  if (node.properties.focusable === true) {
    return true;
  }
  
  // Check for editable property
  if (node.properties.editable === "plaintext" || node.properties.editable === "richtext") {
    return true;
  }
  
  // Check for hasPopup property (indicates clickable element)
  if (node.properties.hasPopup) {
    return true;
  }
  
  // Check for expanded property (indicates expandable/collapsible element)
  if (node.properties.expanded !== undefined) {
    return true;
  }
  
  // Check for pressed property (indicates toggle button)
  if (node.properties.pressed !== undefined) {
    return true;
  }
  
  // Check for checked property (indicates checkbox/radio)
  if (node.properties.checked !== undefined) {
    return true;
  }
  
  // Check for selected property (indicates selectable item)
  if (node.properties.selected !== undefined) {
    return true;
  }
  
  return false;
}

// ============================================================================
// Element String Formatting (matching build_dom_tree.ts format)
// ============================================================================

/**
 * Convert A11y role to approximate HTML tag
 */
function roleToTag(role: string): string {
  const roleTagMap: Record<string, string> = {
    button: "button",
    link: "a",
    textbox: "input",
    searchbox: "input",
    checkbox: "input",
    radio: "input",
    combobox: "select",
    listbox: "select",
    option: "option",
    menuitem: "menuitem",
    menuitemcheckbox: "menuitem",
    menuitemradio: "menuitem",
    tab: "button",
    treeitem: "li",
    heading: "h1",
    img: "img",
    image: "img",
    paragraph: "p",
    list: "ul",
    listitem: "li",
    table: "table",
    row: "tr",
    cell: "td",
    gridcell: "td",
    group: "div",
    region: "section",
    navigation: "nav",
    main: "main",
    article: "article",
    banner: "header",
    contentinfo: "footer",
    complementary: "aside",
    form: "form",
    search: "search",
    dialog: "dialog",
    alertdialog: "dialog",
    alert: "div",
    status: "div",
    log: "div",
    marquee: "div",
    timer: "div",
    tooltip: "div",
    slider: "input",
    spinbutton: "input",
    switch: "input",
    progressbar: "progress",
    meter: "meter",
    separator: "hr",
    menu: "menu",
    menubar: "nav",
    toolbar: "div",
    tree: "ul",
    treegrid: "table",
    grid: "table",
    figure: "figure",
    document: "div",
    application: "div",
    generic: "div",
    none: "span",
    presentation: "span",
  };
  
  return roleTagMap[role] || "div";
}

/**
 * Normalize text for consistent matching across different encodings.
 * Handles CJK (Chinese, Japanese, Korean) and other Unicode text properly.
 * 
 * - Applies Unicode NFC normalization (canonical composition)
 * - Converts full-width ASCII characters to half-width (common in CJK text)
 * - Normalizes various whitespace characters to regular spaces
 * - Collapses multiple consecutive whitespace to single space
 * - Trims leading/trailing whitespace
 */
function normalizeText(text: string): string {
  if (!text) return "";
  
  // Apply Unicode NFC normalization (canonical composition)
  // This ensures characters like "é" are represented consistently
  let normalized = text.normalize("NFC");
  
  // Convert full-width ASCII characters to half-width (U+FF01-U+FF5E → U+0021-U+007E)
  // This is common in CJK text where "５０円" should match "50円"
  // Full-width range: U+FF01 (！) to U+FF5E (～) maps to U+0021 (!) to U+007E (~)
  normalized = normalized.replace(/[\uFF01-\uFF5E]/g, (char) => {
    return String.fromCharCode(char.charCodeAt(0) - 0xFEE0);
  });
  
  // Convert full-width space (U+3000) to half-width space
  // Already covered below, but explicit for clarity
  
  // Replace various Unicode whitespace characters with regular space:
  // - U+00A0: Non-breaking space (NBSP)
  // - U+2002: En space
  // - U+2003: Em space
  // - U+2004: Three-per-em space
  // - U+2005: Four-per-em space
  // - U+2006: Six-per-em space
  // - U+2007: Figure space
  // - U+2008: Punctuation space
  // - U+2009: Thin space
  // - U+200A: Hair space
  // - U+202F: Narrow no-break space
  // - U+205F: Medium mathematical space
  // - U+3000: Ideographic space (CJK full-width space)
  normalized = normalized
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
  
  // Remove zero-width and invisible characters:
  // - U+200B: Zero-width space
  // - U+200C: Zero-width non-joiner
  // - U+200D: Zero-width joiner
  // - U+2060: Word joiner
  // - U+FEFF: BOM / Zero-width no-break space
  normalized = normalized.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "");
  
  // Normalize common CJK punctuation variations
  // These are semantically equivalent but may differ between sources
  normalized = normalized
    // Full-width colon/semicolon to half-width (often used in Japanese)
    .replace(/\uFF1A/g, ":")  // ： → :
    .replace(/\uFF1B/g, ";")  // ； → ;
    // Full-width parentheses (already covered by FF01-FF5E range, but kept for clarity)
    // CJK brackets that are commonly interchanged
    .replace(/\u3010/g, "[")  // 【 → [
    .replace(/\u3011/g, "]")  // 】 → ]
    .replace(/\u300C/g, "\"") // 「 → "
    .replace(/\u300D/g, "\"") // 」 → "
    .replace(/\u300E/g, "\"") // 『 → "
    .replace(/\u300F/g, "\""); // 』 → "
  
  // Collapse multiple whitespace to single space and trim
  normalized = normalized.replace(/\s+/g, " ").trim();
  
  return normalized;
}

/**
 * Build attributes string from A11y node for pseudo-HTML output
 * 
 * IMPORTANT: We prefer real DOM attributes over inferred values from a11y tree.
 * This ensures the pseudo DOM matches what the selector will find in the real DOM.
 */
function buildAttributesStr(
  node: A11yTreeNode, 
  includeAttributes: string[], 
  domAttrs: {
    id?: string;
    class?: string;
    name?: string;
    type?: string;
    title?: string;
    ariaLabel?: string;
    href?: string;
    alt?: string;
    value?: string;
    placeholder?: string;
  }
): string {
  const attrs: string[] = [];
  
  // Map A11y properties to HTML-like attributes
  // PRIORITY: Real DOM attribute > A11y inferred value
  const attrMap: Record<string, () => string | undefined> = {
    "id": () => domAttrs.id, // Real DOM id
    "name": () => domAttrs.name, // Real DOM name attribute
    "type": () => domAttrs.type, // Real DOM type attribute (not inferred from role)
    "title": () => domAttrs.title, // Real DOM title (not a11y description)
    "role": () => node.role !== "generic" ? node.role : undefined,
    "class": () => domAttrs.class, // Real DOM class
    "href": () => domAttrs.href, // Real DOM href (not placeholder "#")
    // aria-label: only use real DOM attribute, not computed accessible name (which can't be used for selection)
    "aria-label": () => domAttrs.ariaLabel || undefined,
    // placeholder: only use real DOM attribute, not a11y computed property
    "placeholder": () => domAttrs.placeholder || undefined,
    // value: only use real DOM attribute, not a11y computed value (which reflects current state, not selectable attribute)
    "value": () => domAttrs.value || undefined,
    "alt": () => domAttrs.alt, // Real DOM alt (not inferred from name)
    // aria-expanded: use a11y property as this reflects current state and is a real ARIA attribute
    "aria-expanded": () => {
      const expanded = node.properties.expanded;
      if (expanded !== undefined) return String(expanded);
      return undefined;
    },
    "src": () => undefined, // Not fetching src to avoid large URLs
  };
  
  for (const attrName of includeAttributes) {
    const getValue = attrMap[attrName];
    if (getValue) {
      const value = getValue();
      if (value !== undefined && value !== "") {
        // Truncate long values
        let displayValue = value;
        if ((attrName === "src" || attrName === "href") && value.length > 200) {
          continue;
        }
        if (attrName === "class" && value.length > 30) {
          displayValue = value.split(" ").slice(0, 3).join(" ");
        }
        attrs.push(`${attrName}="${displayValue.replace(/\n+/g, ' ')}"`);
      }
    }
  }
  
  return attrs.length > 0 ? " " + attrs.join(" ") : "";
}

/**
 * Format a single interactive element as pseudo-HTML string
 */
function formatElementString(
  index: number,
  node: A11yTreeNode,
  includeAttributes: string[],
  elem: A11yHighlightInfo
): string {
  // Use actual DOM tag if available, otherwise fall back to role-based mapping
  const tag = elem.domTag ? elem.domTag.toLowerCase() : roleToTag(node.role);
  
  // Build DOM attributes object from the element's resolved DOM info
  const domAttrs = {
    id: elem.domId,
    class: elem.domClass,
    name: elem.domName,
    type: elem.domType,
    title: elem.domTitle,
    ariaLabel: elem.domAriaLabel,
    href: elem.domHref,
    alt: elem.domAlt,
    value: elem.domValue,
    placeholder: elem.domPlaceholder,
  };
  
  const attrsStr = buildAttributesStr(node, includeAttributes, domAttrs);
  // Use DOM textContent for pseudo DOM to match selector's el.textContent
  const text = normalizeText(elem.domTextContent || "");
  
  return `[${index}]:<${tag}${attrsStr}>${text}</${tag}>`;
}

// ============================================================================
// Main API
// ============================================================================

/**
 * Find the active modal dialog in the accessibility tree.
 * 
 * When a modal dialog is open, per ARIA spec:
 * - User interaction is restricted to the dialog
 * - Content outside the dialog is considered "inert" (not focusable, not interactive)
 * - Elements outside the modal should not be exposed as interactive
 * 
 * This function handles:
 * - role="dialog" with modal=true
 * - role="alertdialog" with modal=true  
 * - Nested modals: returns the deepest (most recently opened) modal
 * 
 * Other accessibility states considered but NOT blocking interactivity:
 * - aria-hidden="true": Chrome's a11y API already excludes these from the tree
 * - aria-busy="true": Indicates loading, but elements may still be interactive
 * - aria-disabled="true": Elements are perceivable but not operable (handled separately)
 */
function findActiveModalDialog(root: A11yTreeNode): A11yTreeNode | null {
  let modalDialog: A11yTreeNode | null = null;
  
  // Traverse the entire tree to find the deepest modal dialog
  // In case of nested modals, the deepest one (last in DOM order) is the active one
  traverseA11yTree(root, (node) => {
    // Check if this is a modal dialog
    const isDialogRole = node.role === "dialog" || node.role === "alertdialog";
    const isModal = node.properties.modal === true;
    
    if (isDialogRole && isModal) {
      // Keep updating to get the deepest/last modal (don't stop traversal)
      modalDialog = node;
    }
  });
  
  return modalDialog;
}

/**
 * Collect IDs of elements inside the modal that have open popups/menus.
 * These are elements with aria-expanded="true" and aria-haspopup or similar.
 * The IDs will be used to find portal-rendered popups that reference them.
 */
function collectExpandedElementIds(modalNode: A11yTreeNode): Set<string> {
  const expandedIds = new Set<string>();
  
  traverseA11yTree(modalNode, (node) => {
    // Check if element has an open popup (aria-expanded=true)
    const isExpanded = node.properties.expanded === true;
    const hasPopup = node.properties.hasPopup !== undefined && node.properties.hasPopup !== false;
    
    if (isExpanded || hasPopup) {
      // The node's id property or name might be used as a reference
      // We store the node.id (accessibility tree node ID) for matching
      if (node.id) {
        expandedIds.add(node.id);
      }
      // Also collect the DOM-level properties that might be referenced
      // The aria-labelledby on popups typically references the triggering button's DOM id
      if (node.properties.describedby) {
        expandedIds.add(String(node.properties.describedby));
      }
    }
  });
  
  return expandedIds;
}

/**
 * Find portal-rendered popups/menus that are associated with the modal.
 * 
 * React UI frameworks like Fluent UI render popups via portals at the document root,
 * outside the modal's DOM subtree. These popups reference their trigger elements
 * via aria-labelledby, aria-controls, or similar attributes.
 * 
 * This function finds such popups by looking for:
 * - role="menu", "listbox", "dialog", "tooltip", "tree" outside the modal
 * - That have properties indicating they're associated with the modal content
 */
function findAssociatedPortalPopups(
  root: A11yTreeNode,
  modalDialog: A11yTreeNode
): A11yTreeNode[] {
  const portalPopups: A11yTreeNode[] = [];
  const modalNodeIds = new Set<string>();
  
  // Collect all node IDs inside the modal
  traverseA11yTree(modalDialog, (node) => {
    modalNodeIds.add(node.id);
  });
  
  // Portal popup roles that might be rendered outside the modal
  const popupRoles = new Set([
    "menu",
    "listbox", 
    "tree",
    "grid",
    "dialog", // Non-modal dialogs like tooltips
    "tooltip",
    "alertdialog",
  ]);
  
  // Traverse the entire tree to find popups outside the modal
  traverseA11yTree(root, (node) => {
    // Skip nodes inside the modal
    if (modalNodeIds.has(node.id)) {
      return;
    }
    
    // Check if this is a popup-type role
    if (!popupRoles.has(node.role)) {
      return;
    }
    
    // Check if it's associated with the modal via labelledby, controls, etc.
    // Popups often have aria-labelledby pointing to the trigger button's ID
    // The Chrome a11y API exposes this as various properties
    const hasAssociation = 
      node.properties.labelledby !== undefined ||
      node.properties.describedby !== undefined ||
      node.properties.controls !== undefined ||
      node.properties.owns !== undefined ||
      // Also check if it has focusable children (active popup)
      node.properties.focusable === true ||
      // Menu with items is likely active
      (node.role === "menu" && node.children.length > 0);
    
    if (hasAssociation) {
      portalPopups.push(node);
      console.log(`[findAssociatedPortalPopups] Found portal popup: role=${node.role}, name="${node.name}", children=${node.children.length}`);
    }
  });
  
  return portalPopups;
}

/**
 * Build element result from accessibility tree via CDP
 * This is the main entry point, designed to match build_dom_tree.ts interface
 */
export async function buildA11yElementTree(
  cdp: CDPSession,
  options: {
    markHighlightElements?: boolean;
    includeAttributes?: string[];
    includeNonIndexedElements?: boolean;
  } = {}
): Promise<A11yElementResult> {
  const {
    markHighlightElements = true,
    includeAttributes = [
      "id",
      "title",
      "type",
      "name",
      "role",
      "class",
      "src",
      "href",
      "aria-label",
      "placeholder",
      "value",
      "alt",
      "aria-expanded",
    ],
    includeNonIndexedElements = true,
  } = options;

  // Build the accessibility tree
  const result = await buildA11yTreeFromCDP(cdp, {
    includeIgnored: false,
    includeEmptyGeneric: false,
  });

  if (!result.tree) {
    return {
      element_str: "",
      client_rect: { width: 0, height: 0 },
    };
  }

  // Get viewport size
  const layoutMetrics = await cdp.send("Page.getLayoutMetrics") as any;
  const visualViewport = layoutMetrics?.visualViewport || layoutMetrics?.cssVisualViewport;
  const client_rect = {
    width: visualViewport?.clientWidth || 1920,
    height: visualViewport?.clientHeight || 1080,
  };

  // Check for modal dialogs - when a modal is open, only elements inside it are interactive
  // Elements outside a modal dialog are considered "inert" per ARIA spec
  const modalDialog = findActiveModalDialog(result.tree);
  const treeToTraverse = modalDialog || result.tree;
  
  // Find portal-rendered popups associated with the modal (e.g., menus rendered via React portals)
  const portalPopups: A11yTreeNode[] = [];
  if (modalDialog) {
    console.log(`[buildA11yElementTree] Modal dialog detected (role=${modalDialog.role}, name="${modalDialog.name}"), restricting to modal content only`);
    
    // Also find popups rendered outside the modal DOM tree but logically belonging to it
    const foundPopups = findAssociatedPortalPopups(result.tree, modalDialog);
    portalPopups.push(...foundPopups);
    if (foundPopups.length > 0) {
      console.log(`[buildA11yElementTree] Found ${foundPopups.length} portal-rendered popup(s) associated with modal`);
    }
  }

  // Collect interactive nodes as candidates (indices assigned later after filtering)
  const candidateNodes: A11yTreeNode[] = [];

  // Traverse the main tree (modal or full tree)
  traverseA11yTree(treeToTraverse, (node) => {
    if (isInteractiveNode(node)) {
      candidateNodes.push(node);
    }
  });

  // Also traverse portal-rendered popups that are associated with the modal
  for (const popup of portalPopups) {
    traverseA11yTree(popup, (node) => {
      if (isInteractiveNode(node)) {
        candidateNodes.push(node);
      }
    });
  }

  // Get bounding boxes for interactive elements if marking is enabled
  const area_map: Record<number, { x: number; y: number; width: number; height: number }> = {};
  const selector_map: Record<number, A11yTreeNode> = {};

  // Enable DOM domain for bounding box queries
  try {
    await cdp.send("DOM.enable");
  } catch (e) {
    // DOM may already be enabled
  }
  
  // Get the document first to ensure DOM is ready
  try {
    await cdp.send("DOM.getDocument", { depth: 0 });
  } catch (e) {
    // Ignore errors
  }

  // Cap the number of candidate nodes to prevent hanging on complex pages
  // When maxA11yElements is 0 (unlimited), skip capping entirely
  const maxElements = config.maxA11yElements !== undefined ? config.maxA11yElements : 1000;
  if (maxElements > 0 && candidateNodes.length > maxElements) {
    console.warn(`[buildA11yElementTree] Capping candidate nodes from ${candidateNodes.length} to ${maxElements} to prevent performance issues`);
    candidateNodes.length = maxElements; // Truncate in place
  }

  console.log(`[buildA11yElementTree] Processing ${candidateNodes.length} candidate nodes`);

  let successCount = 0;
  let failCount = 0;
  let textNodeCount = 0;
  let noBackendIdCount = 0;
  let zeroDimensionCount = 0;
  let getBoxModelErrorCount = 0;

  // Process each candidate node, resolve DOM info, and filter out text nodes
  // Only valid elements (real DOM Elements, not text nodes) get indices
  const interactiveElements: A11yHighlightInfo[] = [];
  let highlightIndex = 0;

  for (const node of candidateNodes) {
    if (node.backendDOMNodeId === undefined) {
      noBackendIdCount++;
      failCount++;
      continue;
    }

    // Temporary object to collect DOM info before deciding to include
    const elemInfo: Partial<A11yHighlightInfo> = {
      node,
      boundingBox: null,
    };
    let isTextNode = false;

    try {
      // Use getBoundingClientRect via DOM.resolveNode + Runtime.callFunctionOn
      // This returns viewport-relative coordinates directly, avoiding scroll calculation issues
      const resolveResult = await cdp.send("DOM.resolveNode", {
        backendNodeId: node.backendDOMNodeId,
      });
      
      if (resolveResult?.object?.objectId) {
        const rectResult = await cdp.send("Runtime.callFunctionOn", {
          objectId: resolveResult.object.objectId,
          functionDeclaration: `function() { 
            const r = this.getBoundingClientRect(); 
            return { x: r.x, y: r.y, width: r.width, height: r.height, textContent: (this.textContent || '').trim() }; 
          }`,
          returnByValue: true,
        });
        
        // Release the object to avoid memory leaks
        await cdp.send("Runtime.releaseObject", { objectId: resolveResult.object.objectId });
        
        const rect = rectResult?.result?.value;
        if (rect && rect.width > 0 && rect.height > 0) {
          // Log first few successful bounding boxes for debugging
          if (successCount < 3) {
            console.log(`[buildA11yElementTree] BBox #${successCount} role=${node.role}: viewport=(${rect.x.toFixed(0)},${rect.y.toFixed(0)}) size=${rect.width.toFixed(0)}x${rect.height.toFixed(0)}`);
          }
          
          elemInfo.boundingBox = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          successCount++;
        } else if (rect && (rect.width === 0 || rect.height === 0)) {
          zeroDimensionCount++;
        }
        // Store textContent for pseudo DOM consistency with selector matching
        if (rect && rect.textContent) {
          elemInfo.domTextContent = rect.textContent;
        }
      }
    } catch (e) {
      getBoxModelErrorCount++;
      // Log first few errors for debugging
      if (getBoxModelErrorCount <= 3) {
        console.log(`[buildA11yElementTree] getBoundingClientRect error #${getBoxModelErrorCount} for backendNodeId=${node.backendDOMNodeId}, role=${node.role}:`, e);
      }
      // Element may not be visible or in DOM - continue to try describeNode
    }
      
    // Fetch DOM tag and all attributes using DOM.describeNode
    // This gives us the REAL DOM attributes, not inferred from a11y tree
    try {
      const describeResponse = await cdp.send("DOM.describeNode", {
        backendNodeId: node.backendDOMNodeId,
      });
      const nodeInfo = describeResponse?.node;
      if (nodeInfo) {
        // Get the actual DOM tag name (e.g., 'DIV', 'BUTTON', 'SELECT')
        // This is more accurate than roleToTag() mapping
        if (nodeInfo.nodeName) {
          elemInfo.domTag = nodeInfo.nodeName;
          // Check if this is a text node (nodeName starts with #, like #text)
          // Text nodes cannot be interacted with - they don't have getAttribute()
          if (nodeInfo.nodeName.startsWith('#')) {
            isTextNode = true;
          }
        }
        if (nodeInfo.attributes) {
          // Attributes are in format ["attr1", "value1", "attr2", "value2", ...]
          // Extract ALL relevant attributes for accurate pseudo DOM
          const attrs = nodeInfo.attributes as string[];
          for (let i = 0; i < attrs.length; i += 2) {
            const attrName = attrs[i];
            const attrValue = attrs[i + 1];
            if (!attrValue) continue;
            
            switch (attrName) {
              case "id":
                elemInfo.domId = attrValue;
                break;
              case "class":
                elemInfo.domClass = attrValue;
                break;
              case "name":
                elemInfo.domName = attrValue;
                break;
              case "type":
                elemInfo.domType = attrValue;
                break;
              case "title":
                elemInfo.domTitle = attrValue;
                break;
              case "aria-label":
                elemInfo.domAriaLabel = attrValue;
                break;
              case "href":
                elemInfo.domHref = attrValue;
                break;
              case "alt":
                elemInfo.domAlt = attrValue;
                break;
              case "value":
                elemInfo.domValue = attrValue;
                break;
              case "placeholder":
                elemInfo.domPlaceholder = attrValue;
                break;
            }
          }
        }
      }
    } catch (e) {
      // Ignore errors when fetching DOM info
    }

    // Skip text nodes - they cannot be interacted with
    if (isTextNode) {
      textNodeCount++;
      continue;
    }

    // This is a valid element - assign an index and add to the list
    const elem: A11yHighlightInfo = {
      index: highlightIndex,
      node,
      boundingBox: elemInfo.boundingBox || null,
      domTag: elemInfo.domTag,
      domId: elemInfo.domId,
      domClass: elemInfo.domClass,
      domName: elemInfo.domName,
      domType: elemInfo.domType,
      domTitle: elemInfo.domTitle,
      domAriaLabel: elemInfo.domAriaLabel,
      domHref: elemInfo.domHref,
      domAlt: elemInfo.domAlt,
      domValue: elemInfo.domValue,
      domPlaceholder: elemInfo.domPlaceholder,
    };
    
    interactiveElements.push(elem);
    selector_map[highlightIndex] = node;
    if (elem.boundingBox) {
      area_map[highlightIndex] = elem.boundingBox;
    }
    highlightIndex++;
  }
  
  // Log stats for debugging
  console.log(`[buildA11yElementTree] Bounding boxes: ${successCount} success, ${getBoxModelErrorCount} errors, ${zeroDimensionCount} zero-dimension, ${noBackendIdCount} no-backendId, ${textNodeCount} text nodes, ${interactiveElements.length} final elements`);

  // Build element string in format matching build_dom_tree.ts
  const elementLines: string[] = [];
  
  for (const elem of interactiveElements) {
    elementLines.push(formatElementString(elem.index, elem.node, includeAttributes, elem));
  }

  // Also collect non-interactive text for context (like build_dom_tree does)
  // Use treeToTraverse to respect modal dialog boundaries
  // Only include if includeNonIndexedElements is true
  if (includeNonIndexedElements) {
    traverseA11yTree(treeToTraverse, (node) => {
      if (!isInteractiveNode(node) && node.role === "StaticText" && node.name) {
        elementLines.push(`[]:${normalizeText(node.name)}`);
      }
    });

    // Also collect static text from portal popups
    for (const popup of portalPopups) {
      traverseA11yTree(popup, (node) => {
        if (!isInteractiveNode(node) && node.role === "StaticText" && node.name) {
          elementLines.push(`[]:${normalizeText(node.name)}`);
        }
      });
    }
  }

  const areaMapSize = Object.keys(area_map).length;
  console.log(`[buildA11yElementTree] Returning area_map with ${areaMapSize} entries, markHighlightElements=${markHighlightElements}`);

  // Always return area_map for A11y mode since we don't inject DOM overlays
  // The caller will decide whether to draw boxes on the screenshot
  return {
    element_str: elementLines.join("\n"),
    client_rect,
    selector_map,
    area_map,
  };
}

/**
 * Build element result from a Playwright Page
 */
export async function buildA11yElementTreeFromPage(
  page: Page,
  options: {
    markHighlightElements?: boolean;
    includeAttributes?: string[];
  } = {}
): Promise<A11yElementResult> {
  const cdp = await page.context().newCDPSession(page);
  
  try {
    return await buildA11yElementTree(cdp, options);
  } finally {
    await cdp.detach();
  }
}

/**
 * Highlight elements on the page using CDP
 * Similar to the DOM highlighting in build_dom_tree.ts
 */
export async function highlightA11yElements(
  cdp: CDPSession,
  elements: A11yHighlightInfo[]
): Promise<void> {
  // Use DOM.Overlay API to highlight elements
  await cdp.send("Overlay.enable");
  
  for (const elem of elements) {
    if (elem.node.backendDOMNodeId !== undefined) {
      try {
        await cdp.send("Overlay.highlightNode", {
          highlightConfig: {
            contentColor: { r: 255, g: 0, b: 0, a: 0.1 },
            borderColor: { r: 255, g: 0, b: 0, a: 1 },
            showInfo: true,
          },
          backendNodeId: elem.node.backendDOMNodeId,
        });
      } catch (e) {
        // Node may not be highlightable
      }
    }
  }
}

/**
 * Remove highlights from the page (CDP Overlay - not visible in screenshots)
 */
export async function removeA11yHighlights(cdp: CDPSession): Promise<void> {
  try {
    await cdp.send("Overlay.hideHighlight");
    await cdp.send("Overlay.disable");
  } catch (e) {
    // Ignore errors
  }
}

/**
 * Inject DOM highlight overlays that are visible in screenshots.
 * This injects actual DOM elements similar to what build_dom_tree.ts does.
 * When window.__eko_styleHighlightOverlay / __eko_styleHighlightLabel hooks
 * are installed (e.g. by run_install_noocclude_label_hook), delegates to them;
 * otherwise falls through to legacy styling.
 */
export async function injectDomHighlightOverlays(
  cdp: CDPSession,
  area_map: Record<number, { x: number; y: number; width: number; height: number; noDraw?: boolean }>
): Promise<void> {
  // JavaScript code to inject highlight overlays into the page.
  // Hook delegation mirrors build_dom_tree.ts so both tree modes share
  // the same styling logic.
  const injectScript = `
    (function(areaMap) {
      // Remove any existing highlight container
      let existing = document.getElementById('eko-highlight-container');
      if (existing) existing.remove();
      
      // Reset placed-labels tracker (noocclude collision avoidance)
      if (window.__eko_placedLabels) window.__eko_placedLabels.length = 0;
      if (window.__eko_placedElements) window.__eko_placedElements.length = 0;
      if (typeof window.__eko_clearDeferredPills === 'function') window.__eko_clearDeferredPills();
      // Pre-populate the element-rect tracker with ALL elements that will be
      // annotated this pass. This way every element's placement scoring sees
      // the full visual cluster, not just elements processed before it.
      if (window.__eko_placedElements) {
        for (const [, b] of Object.entries(areaMap)) {
          window.__eko_placedElements.push({ t: b.y, l: b.x, w: b.width, h: b.height });
        }
      }
      // Clear any leader lines drawn by the previous pass.
      if (typeof window.__eko_clearLeaders === 'function') window.__eko_clearLeaders();
      
      // Create highlight container
      const container = document.createElement('div');
      container.id = 'eko-highlight-container';
      container.style.position = 'fixed';
      container.style.pointerEvents = 'none';
      container.style.top = '0';
      container.style.left = '0';
      container.style.width = '100%';
      container.style.height = '100%';
      container.style.zIndex = '2147483647';
      document.documentElement.appendChild(container);
      
      // Color palette
      const colors = [
        '#FF0000', '#00FF00', '#0000FF', '#FFA500', '#800080',
        '#008080', '#FF69B4', '#4B0082', '#FF4500', '#2E8B57',
        '#DC143C', '#4682B4',
      ];
      
      // Detect external styler hooks (installed by run_install_noocclude_label_hook)
      const externalOverlayStyler = window.__eko_styleHighlightOverlay;
      const externalLabelStyler = window.__eko_styleHighlightLabel;
      
      // Create overlays for each element
      // Note: coordinates in areaMap are already viewport-relative (adjusted for scroll in buildA11yElementTree)
      for (const [indexStr, box] of Object.entries(areaMap)) {
        // Entries flagged \`noDraw\` (e.g. wrapper labels around an
        // entire form section) keep their slot in the structured element
        // list but get no overlay drawn on the page. Only honoured under
        // noocclude (detected via the external styler hook) so legacy
        // mode keeps every overlay.
        if (box && box.noDraw && typeof externalOverlayStyler === 'function') continue;
        const index = parseInt(indexStr);
        const colorIndex = index % colors.length;
        const baseColor = colors[colorIndex];
        const backgroundColor = baseColor + '1A'; // 10% opacity
        
        const top = box.y;
        const left = box.x;
        const rect = { top: top, left: left, right: left + box.width, bottom: top + box.height, width: box.width, height: box.height, x: left, y: top, toJSON: function(){} };
        
        // Create highlight overlay
        const overlay = document.createElement('div');
        overlay.style.position = 'absolute';
        overlay.style.pointerEvents = 'none';
        overlay.style.boxSizing = 'border-box';
        
        // Hook: delegate to external overlay styler if installed, else legacy
        if (typeof externalOverlayStyler === 'function') {
          externalOverlayStyler(overlay, baseColor);
        } else {
          overlay.style.border = '2px solid ' + baseColor;
        }
        
        if (typeof externalOverlayStyler !== 'function' &&
            (box.width < window.innerWidth / 2 || box.height < window.innerHeight / 2)) {
          overlay.style.backgroundColor = backgroundColor;
        }
        
        overlay.style.top = top + 'px';
        overlay.style.left = left + 'px';
        overlay.style.width = box.width + 'px';
        overlay.style.height = box.height + 'px';
        
        // Create label
        const label = document.createElement('div');
        label.className = 'eko-highlight-label';
        label.style.position = 'absolute';
        label.style.padding = '1px 4px';
        label.style.borderRadius = '4px';
        label.style.fontSize = Math.min(12, Math.max(8, box.height / 2)) + 'px';
        
        // Hook: delegate to external label styler if installed, else legacy
        if (typeof externalLabelStyler === 'function') {
          label.textContent = index.toString();
          // a11y path has no actual DOM element — pass a stub with computed style
          const stubElement = document.createElement('span');
          externalLabelStyler(label, stubElement, baseColor, top, left, rect, null);
        } else {
          label.style.background = baseColor;
          label.style.color = 'white';
          label.textContent = index.toString();
          
          // Label position (top-right corner inside the box)
          const labelWidth = 20;
          const labelHeight = 16;
          let labelTop = top + 2;
          let labelLeft = left + box.width - labelWidth - 2;
          
          // Adjust if box is too small
          if (box.width < labelWidth + 4 || box.height < labelHeight + 4) {
            labelTop = top - labelHeight - 2;
            labelLeft = left + box.width - labelWidth;
          }
          
          // Ensure label stays within viewport
          if (labelTop < 0) labelTop = top + 2;
          if (labelLeft < 0) labelLeft = left + 2;
          if (labelLeft + labelWidth > window.innerWidth) {
            labelLeft = left + box.width - labelWidth - 2;
          }
          
          label.style.top = labelTop + 'px';
          label.style.left = labelLeft + 'px';
        }
        
        container.appendChild(overlay);
        container.appendChild(label);
      }
      
      // Cluster-legend pass: place all dense-cluster pills (deferred during
      // the per-element styling loop) into a gutter region with leader lines.
      if (typeof window.__eko_finalizeDeferredLabels === 'function') {
        try { window.__eko_finalizeDeferredLabels(); } catch (_e) { /* best-effort */ }
      }
      
      // Force layout reflow to ensure overlays are rendered before screenshot
      void container.offsetHeight;
      
      // Return count of overlays added
      return { overlayCount: container.childNodes.length, containerAttached: document.getElementById('eko-highlight-container') !== null };
    })
  `;
  
  // Log first 3 entries to debug coordinates
  const entries = Object.entries(area_map).slice(0, 3);
  console.log(`[injectDomHighlightOverlays] First 3 area_map entries:`, JSON.stringify(entries));
  
  try {
    const result = await cdp.send("Runtime.evaluate", {
      expression: injectScript + `(${JSON.stringify(area_map)})`,
      awaitPromise: false,
      returnByValue: true,
    });
    console.log(`[injectDomHighlightOverlays] Injection result:`, JSON.stringify(result));
  } catch (e) {
    console.warn("[injectDomHighlightOverlays] Failed to inject overlays:", e);
  }
}

/**
 * Remove DOM highlight overlays from the page.
 */
export async function removeDomHighlightOverlays(cdp: CDPSession): Promise<void> {
  try {
    await cdp.send("Runtime.evaluate", {
      expression: `
        (function() {
          const container = document.getElementById('eko-highlight-container');
          if (container) container.remove();
        })()
      `,
      awaitPromise: false,
      returnByValue: true,
    });
  } catch (e) {
    // Ignore errors
  }
}

/**
 * Take a screenshot using CDP Page.captureScreenshot.
 * This is more reliable than chrome.tabs.captureVisibleTab when we have CDP-injected DOM elements.
 */
export async function captureScreenshotViaCDP(
  cdp: CDPSession,
  options: {
    format?: "jpeg" | "png";
    quality?: number;
  } = {}
): Promise<{ imageBase64: string; imageType: "image/jpeg" | "image/png" }> {
  const format = options.format || "jpeg";
  const quality = options.quality || 60;
  
  const result = await cdp.send("Page.captureScreenshot", {
    format,
    quality: format === "jpeg" ? quality : undefined,
    captureBeyondViewport: false,
  });

  if (!result?.data) {
    throw new Error("[captureScreenshotViaCDP] CDP Page.captureScreenshot returned no data");
  }
  
  return {
    imageBase64: result.data,
    imageType: format === "jpeg" ? "image/jpeg" : "image/png",
  };
}

/**
 * Get element by index from selector_map and resolve to DOM for interaction
 */
export async function resolveA11yElementForInteraction(
  cdp: CDPSession,
  selectorMap: Record<number, A11yTreeNode>,
  index: number
): Promise<{ objectId: string; backendNodeId: number } | null> {
  const node = selectorMap[index];
  if (!node || node.backendDOMNodeId === undefined) {
    return null;
  }

  try {
    const { object } = await cdp.send("DOM.resolveNode", {
      backendNodeId: node.backendDOMNodeId,
    });

    if (object?.objectId) {
      return {
        objectId: object.objectId,
        backendNodeId: node.backendDOMNodeId,
      };
    }
  } catch (e) {
    // Resolution failed
  }

  return null;
}

/**
 * Set up window.clickable_elements and window.resolve_element_by_selector for a11y mode.
 * 
 * This function uses CDP to:
 * 1. Inject the resolver function into the page
 * 2. Resolve each backendDOMNodeId to an actual DOM element
 * 3. Store the elements in window.clickable_elements
 * 4. Store a11y metadata (like computed accessible name) in window.clickable_elements_a11y
 * 
 * This allows the standard click/hover/type operations to work with a11y tree elements.
 * 
 * IMPORTANT: Pseudo DOM vs window.clickable_elements
 * ================================================
 * 
 * There are TWO different data sources that must stay in sync:
 * 
 * 1. PSEUDO DOM (element_str sent to LLM):
 *    - Built from A11y tree nodes via buildA11yElementTree()
 *    - Uses node.name (computed accessible name) for aria-label attribute
 *    - Example: [21]:<button aria-label="Rules">Rules</button>
 *    - This is what the LLM sees and uses to generate selectors
 * 
 * 2. window.clickable_elements (actual DOM elements for interaction):
 *    - Built here by resolving backendDOMNodeId to real DOM elements
 *    - The actual DOM may NOT have aria-label attribute (name comes from text content)
 *    - Example: <button role="tab">RulesRules</button> (no aria-label!)
 * 
 * THE MISMATCH PROBLEM:
 * - LLM sees aria-label="Rules" in pseudo DOM
 * - LLM generates selector: { ariaLabel: "Rules" }
 * - Semantic matcher checks el.getAttribute('aria-label') on real DOM
 * - Real DOM has no aria-label → MATCH FAILS
 * 
 * THE SOLUTION:
 * - Store a11y metadata in window.clickable_elements_a11y[index]
 * - Matcher checks BOTH real DOM attribute AND a11y metadata
 * - This bridges the gap between what LLM sees and actual DOM
 */
export async function run_build_dom_a11y_tree(
  cdp: CDPSession,
  selector_map: Record<number, A11yTreeNode>
): Promise<void> {
  // First, inject the resolver function and initialize clickable_elements
  const initScript = `
    (function() {
      window.clickable_elements = {};
      // Store a11y metadata separately - this contains the computed accessible name
      // from the accessibility tree, which may differ from DOM attributes
      window.clickable_elements_a11y = {};
      
      /**
       * Normalize text for consistent matching across different encodings.
       * Handles CJK (Chinese, Japanese, Korean) and other Unicode text properly.
       */
      function normalizeText(text) {
        if (!text) return '';
        // Apply Unicode NFC normalization
        var normalized = text.normalize ? text.normalize('NFC') : text;
        
        // Convert full-width ASCII characters to half-width (U+FF01-U+FF5E → U+0021-U+007E)
        // This is common in CJK text where "５０円" should match "50円"
        normalized = normalized.replace(/[\\uFF01-\\uFF5E]/g, function(char) {
          return String.fromCharCode(char.charCodeAt(0) - 0xFEE0);
        });
        
        // Replace various Unicode whitespace with regular space
        // Includes: NBSP, en/em space, thin space, hair space, ideographic space, etc.
        normalized = normalized.replace(/[\\u00A0\\u2002-\\u200A\\u202F\\u205F\\u3000]/g, ' ');
        
        // Remove zero-width and invisible characters
        normalized = normalized.replace(/[\\u200B-\\u200D\\u2060\\uFEFF]/g, '');
        
        // Normalize common CJK punctuation variations
        normalized = normalized
          .replace(/\\uFF1A/g, ':')   // ： → :
          .replace(/\\uFF1B/g, ';')   // ； → ;
          .replace(/\\u3010/g, '[')   // 【 → [
          .replace(/\\u3011/g, ']')   // 】 → ]
          .replace(/\\u300C/g, '"')   // 「 → "
          .replace(/\\u300D/g, '"')   // 」 → "
          .replace(/\\u300E/g, '"')   // 『 → "
          .replace(/\\u300F/g, '"');  // 』 → "
        
        // Collapse multiple whitespace and trim
        normalized = normalized.replace(/\\s+/g, ' ').trim();
        return normalized;
      }
      
      function get_highlight_element(highlightIndex) {
        var el = window.clickable_elements[highlightIndex];
        // Validate it's a proper DOM Element before returning
        if (el && typeof el.getAttribute !== 'function') {
          console.warn('[get_highlight_element] Element at index', highlightIndex, 'is not a valid Element (no getAttribute) - likely a text node');
          return null;
        }
        // Log when element is not found for debugging
        if (!el) {
          var knownIndices = Object.keys(window.clickable_elements || {}).slice(0, 20).join(',');
          console.warn('[get_highlight_element] No element at index', highlightIndex, '. Available indices (first 20):', knownIndices);
        }
        return el;
      }
      
      function resolve_element_by_selector(selector) {
        const VALID_PROPS = ['index', 'id', 'name', 'ariaLabel', 'title', 'text', 'textContains', 'placeholder', 'tag', 'type', 'role', 'class', 'value'];
        const selectorDesc = JSON.stringify(selector);
        
        // === VALIDATION ===
        if (selector === null || selector === undefined) {
          throw new Error('Element resolution failed: Selector is ' + selector + '. You must provide a valid selector (numeric index or object with properties: ' + VALID_PROPS.join(', ') + ').');
        }
        
        if (typeof selector !== 'number' && typeof selector !== 'object') {
          throw new Error('Element resolution failed: Invalid selector type. Expected number or object, got ' + typeof selector + '. Selector value: ' + selectorDesc);
        }
        
        if (Array.isArray(selector)) {
          throw new Error('Element resolution failed: Selector cannot be an array. Expected number or object. Received: ' + selectorDesc);
        }
        
        // For object selectors, check it has at least one valid property
        if (typeof selector === 'object') {
          var hasValidProp = VALID_PROPS.some(function(prop) { return selector[prop] !== undefined; });
          if (!hasValidProp) {
            throw new Error('Element resolution failed: Selector object is empty or has no valid properties. You must provide at least one of: ' + VALID_PROPS.join(', ') + '. Received: ' + selectorDesc);
          }
        }
        
        // === RESOLUTION ===
        var element = null;
        var candidates = [];
        
        // Normalize selector to object form
        var sel = typeof selector === 'number' ? { index: selector } : selector;
        var hasOnlyIndex = sel.index !== undefined && VALID_PROPS.filter(function(p) { return p !== 'index'; }).every(function(p) { return sel[p] === undefined; });
        
        // Try index-based lookup first if only index is specified
        if (hasOnlyIndex) {
          element = get_highlight_element(sel.index);
        } else {
          // Try semantic matching
          element = find_element_by_semantic_selector(sel, candidates);
          
          // Fallback to index if semantic match failed but index is available
          if (!element && sel.index !== undefined) {
            element = get_highlight_element(sel.index);
          }
        }
        
        // === RESULT ===
        if (!element) {
          throw new Error(build_resolution_error(sel, selectorDesc, candidates));
        }
        
        // === VALIDATE ELEMENT IS INTERACTABLE ===
        var interactableCheck = validate_element_interactable(element, selectorDesc);
        if (!interactableCheck.ok) {
          // If element is disconnected (zombie node from framework re-render), try cheap re-resolve
          // from the live DOM using CSS attribute selectors instead of failing immediately.
          if (interactableCheck.disconnected && typeof sel === 'object') {
            console.log('[resolve_element_by_selector] Element disconnected, attempting quick re-resolve from live DOM for:', selectorDesc);
            var reResolved = quick_re_resolve_from_dom(sel);
            if (reResolved) {
              var reCheck = validate_element_interactable(reResolved, selectorDesc);
              if (reCheck.ok) {
                console.log('[resolve_element_by_selector] Quick re-resolve succeeded for disconnected element');
                element = reResolved;
              } else {
                console.warn('[resolve_element_by_selector] Quick re-resolve found element but it failed validation:', reCheck.error);
                throw new Error(interactableCheck.error);
              }
            } else {
              console.warn('[resolve_element_by_selector] Quick re-resolve found no matching element in live DOM');
              throw new Error(interactableCheck.error);
            }
          } else {
            throw new Error(interactableCheck.error);
          }
        }
        
        // === BUILD CANONICAL SELECTOR ===
        // Find the index for this element to get a11y metadata
        var elementIndex = find_element_index(element);
        var a11yMeta = elementIndex !== null ? (window.clickable_elements_a11y[elementIndex] || {}) : {};
        var canonicalSelector = build_canonical_selector(element, a11yMeta);
        
        console.log('[resolve_element_by_selector] Resolved element:', element, 'for selector:', selector, 'canonical:', JSON.stringify(canonicalSelector));
        
        // Return both the element and canonical selector
        return { element: element, canonicalSelector: canonicalSelector };
      }
      
      /**
       * Find the index of an element in window.clickable_elements
       */
      function find_element_index(element) {
        var clickableElements = window.clickable_elements || {};
        var keys = Object.keys(clickableElements);
        for (var i = 0; i < keys.length; i++) {
          if (clickableElements[keys[i]] === element) {
            return parseInt(keys[i], 10);
          }
        }
        return null;
      }
      
      /**
       * Build a canonical (generalizable) selector from an element.
       * 
       * This function generates a selector that:
       * 1. Prioritizes stable, semantic attributes (role, ariaLabel, name, title)
       * 2. Avoids random strings/numbers (GUIDs, timestamps, generated IDs)
       * 3. Prefers human-readable, meaningful identifiers
       * 4. Uses a11y tree metadata when DOM attributes are insufficient
       * 
       * Priority order for attributes (highest to lowest):
       * 1. role + ariaLabel (most semantic, from a11y tree)
       * 2. role + name (form elements)
       * 3. role + title
       * 4. role + text (for short, meaningful text)
       * 5. id (only if it looks semantic, not auto-generated)
       * 6. name attribute
       * 7. placeholder (for inputs)
       * 8. role alone (if specific enough)
       * 9. tag + text (last resort)
       */
      function build_canonical_selector(element, a11yMeta) {
        var selector = {};
        
        // Helper: Check if a string looks like an auto-generated ID
        // Auto-generated IDs often contain: GUIDs, random hex, timestamps, sequential numbers
        function looksAutoGenerated(str) {
          if (!str) return true;
          // UUID pattern
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str)) return true;
          // Long hex strings (8+ chars)
          if (/^[0-9a-f]{8,}$/i.test(str)) return true;
          // Strings that are mostly numbers
          if (/^\d{4,}$/.test(str)) return true;
          // Common auto-generated patterns: react-xxx, id_123, item-456, etc.
          if (/^(react|vue|angular|ember|id|item|el|element|node|dom)[-_]?\d+/i.test(str)) return true;
          // Contains long number sequences
          if (/\d{6,}/.test(str)) return true;
          // Very short IDs that are just numbers
          if (/^[_-]?\d{1,3}$/.test(str)) return true;
          // Random-looking strings (high entropy: mix of uppercase, lowercase, numbers)
          if (str.length > 10 && /[A-Z]/.test(str) && /[a-z]/.test(str) && /\d/.test(str)) {
            // Count character type transitions - high transitions suggest randomness
            var transitions = 0;
            for (var i = 1; i < str.length; i++) {
              var prevType = /[A-Z]/.test(str[i-1]) ? 'U' : (/[a-z]/.test(str[i-1]) ? 'L' : 'D');
              var currType = /[A-Z]/.test(str[i]) ? 'U' : (/[a-z]/.test(str[i]) ? 'L' : 'D');
              if (prevType !== currType) transitions++;
            }
            if (transitions > str.length * 0.4) return true;
          }
          return false;
        }
        
        // Helper: Check if text is short and meaningful (good for selector)
        function isGoodTextSelector(text) {
          if (!text) return false;
          var normalized = normalizeText(text);
          // Too short or too long
          if (normalized.length < 1 || normalized.length > 50) return false;
          // Contains newlines (multi-line text is usually not a good selector)
          if (/\\n/.test(text)) return false;
          // All numbers
          if (/^\\d+$/.test(normalized)) return false;
          // Starts with a number followed by space (likely positional like "5 History", "Chapter 1")
          if (/^\\d+\\s/.test(normalized)) return false;
          return true;
        }
        
        // Get element properties
        var tag = element.tagName ? element.tagName.toLowerCase() : '';
        var id = element.id || '';
        var name = element.name || element.getAttribute('name') || '';
        var domAriaLabel = element.getAttribute('aria-label') || '';
        var title = element.getAttribute('title') || '';
        var placeholder = element.placeholder || element.getAttribute('placeholder') || '';
        var domRole = element.getAttribute('role') || '';
        var text = normalizeText(element.textContent || '');
        var value = element.value || element.getAttribute('value') || '';
        var type = element.type || element.getAttribute('type') || '';
        
        // A11y metadata (from accessibility tree - more reliable for computed names)
        var a11yName = normalizeText(a11yMeta.name || '');
        var a11yRole = a11yMeta.role || '';
        
        // Effective role (prefer a11y role, fall back to DOM role or implicit tag role)
        var effectiveRole = a11yRole || domRole || '';
        if (!effectiveRole) {
          // Infer role from tag
          var tagRoleMap = {
            'button': 'button',
            'a': 'link',
            'input': type === 'checkbox' ? 'checkbox' : (type === 'radio' ? 'radio' : 'textbox'),
            'select': 'combobox',
            'textarea': 'textbox',
            'img': 'img',
            'nav': 'navigation',
            'main': 'main',
            'header': 'banner',
            'footer': 'contentinfo',
            'aside': 'complementary',
            'form': 'form',
            'table': 'table',
            'li': 'listitem'
          };
          effectiveRole = tagRoleMap[tag] || '';
        }
        
        // Effective label (prefer a11y name which is the computed accessible name)
        var effectiveLabel = a11yName || domAriaLabel || '';
        
        // === BUILD SELECTOR WITH PRIORITY ===
        
        // 1. ID (most reliable - unique identifier, stable across page changes)
        if (id && !looksAutoGenerated(id)) {
          selector.id = id;
          return selector;
        }
        
        // 2. Name attribute (for form elements - also very stable)
        if (name && !looksAutoGenerated(name)) {
          selector.name = name;
          if (tag === 'input' && type) {
            selector.type = type;
          }
          return selector;
        }
        
        // 3. Role + ariaLabel (semantic combination)
        if (effectiveRole && effectiveLabel && isGoodTextSelector(effectiveLabel)) {
          selector.role = effectiveRole;
          selector.ariaLabel = effectiveLabel;
          return selector;
        }
        
        // 4. Role + name (for form elements)
        if (effectiveRole && name && !looksAutoGenerated(name)) {
          selector.role = effectiveRole;
          selector.name = name;
          return selector;
        }
        
        // 5. Role + title
        if (effectiveRole && title && isGoodTextSelector(title)) {
          selector.role = effectiveRole;
          selector.title = title;
          return selector;
        }
        
        // 6. Role + text (for short, meaningful text like button labels)
        if (effectiveRole && isGoodTextSelector(text) && text.length <= 30) {
          selector.role = effectiveRole;
          selector.text = text;
          return selector;
        }
        
        // 7. Placeholder (for inputs)
        if (placeholder && isGoodTextSelector(placeholder)) {
          selector.placeholder = placeholder;
          if (tag) selector.tag = tag;
          return selector;
        }
        
        // 8. AriaLabel alone (if meaningful)
        if (effectiveLabel && isGoodTextSelector(effectiveLabel)) {
          selector.ariaLabel = effectiveLabel;
          return selector;
        }
        
        // 9. Role + value (for tabs, options)
        if (effectiveRole && value && isGoodTextSelector(value)) {
          selector.role = effectiveRole;
          selector.value = value;
          return selector;
        }
        
        // 10. Tag + text (last resort for semantic selection)
        if (tag && isGoodTextSelector(text)) {
          selector.tag = tag;
          if (text.length <= 50) {
            selector.text = text;
          } else {
            selector.textContains = text.substring(0, 30);
          }
          return selector;
        }
        
        // 11. Role alone (if specific enough - not generic roles)
        var specificRoles = ['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 
                            'combobox', 'slider', 'switch', 'tab', 'menuitem', 'option'];
        if (effectiveRole && specificRoles.indexOf(effectiveRole) !== -1) {
          selector.role = effectiveRole;
          // Try to add any distinguishing attribute
          if (type) selector.type = type;
          return selector;
        }
        
        // 12. Fallback: return minimal selector with what we have
        if (tag) selector.tag = tag;
        if (effectiveRole) selector.role = effectiveRole;
        
        return selector;
      }
      
      /**
       * Cheap re-resolve: when a cached element is disconnected (zombie node from React re-render),
       * try to find the equivalent element in the live DOM using CSS attribute selectors.
       * This avoids the cost of rebuilding the full pseudo DOM tree.
       */
      function quick_re_resolve_from_dom(sel) {
        var parts = [];

        // Build a CSS selector from known semantic properties
        if (sel.tag) parts.push(sel.tag);
        if (sel.id) parts.push('#' + CSS.escape(sel.id));
        if (sel.ariaLabel) parts.push('[aria-label="' + CSS.escape(sel.ariaLabel) + '"]');
        if (sel.role) parts.push('[role="' + CSS.escape(sel.role) + '"]');
        if (sel.name) parts.push('[name="' + CSS.escape(sel.name) + '"]');
        if (sel.placeholder) parts.push('[placeholder="' + CSS.escape(sel.placeholder) + '"]');
        if (sel.title) parts.push('[title="' + CSS.escape(sel.title) + '"]');
        if (sel.type) parts.push('[type="' + CSS.escape(sel.type) + '"]');
        if (sel.value) parts.push('[value="' + CSS.escape(sel.value) + '"]');

        var cssSelector = parts.join('');
        if (!cssSelector) return null;

        try {
          var candidates = document.querySelectorAll(cssSelector);
          if (candidates.length === 0) return null;
          if (candidates.length === 1) return candidates[0];

          // Multiple matches - filter by text content if available
          if (sel.text) {
            for (var i = 0; i < candidates.length; i++) {
              if ((candidates[i].textContent || '').trim() === sel.text) return candidates[i];
            }
          }
          if (sel.textContains) {
            for (var i = 0; i < candidates.length; i++) {
              if ((candidates[i].textContent || '').indexOf(sel.textContains) !== -1) return candidates[i];
            }
          }

          // If class is specified, narrow down further
          if (sel.class) {
            for (var i = 0; i < candidates.length; i++) {
              if (candidates[i].classList.contains(sel.class)) return candidates[i];
            }
          }

          // Return first connected candidate as best-effort
          for (var i = 0; i < candidates.length; i++) {
            if (candidates[i].isConnected) return candidates[i];
          }
          return null;
        } catch (e) {
          console.warn('[quick_re_resolve_from_dom] CSS query failed:', e);
          return null;
        }
      }
      
      function validate_element_interactable(element, selectorDesc) {
        // Check if element is still in the DOM (use isConnected to support Shadow DOM)
        if (!element.isConnected) {
          return { 
            ok: false, 
            error: 'Element resolution failed: Element found but is no longer in the DOM. Selector: ' + selectorDesc + '. Try calling current_page to refresh the element list.',
            disconnected: true
          };
        }
        
        // Check if element is visible
        var style = window.getComputedStyle(element);
        if (style.display === 'none') {
          return { 
            ok: false, 
            error: 'Element resolution failed: Element found but has display:none. Selector: ' + selectorDesc + '. The element may be hidden.'
          };
        }
        if (style.visibility === 'hidden') {
          return { 
            ok: false, 
            error: 'Element resolution failed: Element found but has visibility:hidden. Selector: ' + selectorDesc + '. The element may be hidden.'
          };
        }
        
        // Check if element has zero dimensions
        var rect = element.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) {
          // Special case: <option> elements inside native <select> always have zero dimensions
          // They are rendered by the browser's native dropdown UI, not the DOM
          var isOptionInSelect = element.tagName.toLowerCase() === 'option' && 
                                 element.parentElement && 
                                 element.parentElement.tagName.toLowerCase() === 'select';
          if (isOptionInSelect) {
            return { 
              ok: false, 
              error: 'Element resolution failed: Cannot directly click <option> elements in native <select> dropdowns. Selector: ' + selectorDesc + '. Use select_option tool on the parent <select> element instead.'
            };
          }
          return { 
            ok: false, 
            error: 'Element resolution failed: Element found but has zero dimensions. Selector: ' + selectorDesc + '. The element may not be rendered yet.'
          };
        }
        
        // Check if element is disabled
        if (element.disabled === true || element.getAttribute('aria-disabled') === 'true') {
          return { 
            ok: false, 
            error: 'Element resolution failed: Element found but is disabled. Selector: ' + selectorDesc + '. Wait for the element to become enabled.'
          };
        }
        
        return { ok: true };
      }
      
      function find_element_by_semantic_selector(sel, candidates) {
        // Only search within indexed elements (those in pseudo DOM)
        // This prevents matching non-interactive elements with similar names
        // Throws an error if multiple elements match the selector (ambiguous)
        var clickableElements = window.clickable_elements || {};
        var a11yMetadata = window.clickable_elements_a11y || {};
        var keys = Object.keys(clickableElements);
        console.log('[find_element_by_semantic_selector] Searching for:', JSON.stringify(sel));
        console.log('[find_element_by_semantic_selector] clickable_elements has', keys.length, 'elements, keys:', keys.slice(0, 10).join(','), keys.length > 10 ? '...' : '');
        
        var indexedElements = keys.map(function(key) {
          return { index: parseInt(key, 10), element: clickableElements[key], a11y: a11yMetadata[key] || {} };
        }).filter(function(item) { 
          // Filter out null/undefined elements AND non-Element objects
          // Some CDP resolutions may return non-Element nodes (text nodes, etc.)
          var el = item.element;
          if (!el) return false;
          // Check if it's a valid DOM Element by verifying getAttribute exists
          if (typeof el.getAttribute !== 'function') {
            console.warn('[find_element_by_semantic_selector] Skipping index', item.index, '- not a valid Element (no getAttribute)');
            return false;
          }
          return true;
        });
        
        // Collect ALL matching elements to detect ambiguous selectors
        var matches = [];
        
        for (var i = 0; i < indexedElements.length; i++) {
          var el = indexedElements[i].element;
          var a11y = indexedElements[i].a11y;
          var result = match_element(el, sel, a11y);
          
          if (result.matches) {
            console.log('[find_element_by_semantic_selector] Found match at index', indexedElements[i].index, ':', el.tagName);
            matches.push({ el: el, index: indexedElements[i].index });
          } else {
            // Track near-misses
            var specifiedProps = Object.keys(sel).filter(function(k) { return sel[k] !== undefined && k !== 'index'; }).length;
            if (result.failReasons.length === 1 && specifiedProps > 1) {
              candidates.push({ el: el, index: indexedElements[i].index, failReasons: result.failReasons });
            }
          }
        }

        // If multiple matches and the selector specifies a text-based discriminator
        // (text or textContains), treat the selector as ambiguous and throw — text
        // discriminators are intended to uniquely identify an element, so silently
        // picking one is unsafe (e.g. {role:"listitem", textContains:"Jordan Kim"}
        // matching both FAVORITES and RECENT sections). For non-text selectors
        // (role-only, tag-only, etc.) we keep the interactivity-scoring fallback.
        if (matches.length > 1 && (sel.text !== undefined || sel.textContains !== undefined)) {
          throw new Error(
            'Ambiguous selector: ' + JSON.stringify(sel) + ' matched ' + matches.length + ' elements ' +
            'at indices [' + matches.map(function(m) { return m.index; }).join(', ') + ']. ' +
            'Refine the selector with additional discriminators (e.g. ariaLabel, id, more specific text) ' +
            'or use the numeric index of the intended element.'
          );
        }

        // If multiple matches, pick the most interactive/clickable element
        if (matches.length > 1) {
          console.log('[find_element_by_semantic_selector] Multiple matches found:', matches.length, '- selecting most interactive element');

          // Score each element based on interactivity (higher = more interactive)
          var scored = matches.map(function(m) {
            var el = m.el;
            var tag = el.tagName.toLowerCase();
            var role = el.getAttribute('role');
            var score = 0;

            // HIGHEST PRIORITY: Prefer elements that are visible in viewport
            // This is critical for pages with duplicate IDs or similar elements
            var rect = el.getBoundingClientRect();
            var viewportHeight = window.innerHeight || document.documentElement.clientHeight;
            var viewportWidth = window.innerWidth || document.documentElement.clientWidth;
            var isInViewport = rect.top >= 0 && rect.left >= 0 && 
                               rect.bottom <= viewportHeight && rect.right <= viewportWidth;
            var isPartiallyInViewport = rect.bottom > 0 && rect.top < viewportHeight &&
                                        rect.right > 0 && rect.left < viewportWidth;
            
            if (isInViewport) {
              score += 500;  // Fully visible - very strong preference
            } else if (isPartiallyInViewport) {
              score += 300;  // Partially visible - strong preference
            }
            // Elements completely outside viewport get no bonus
            
            // Highly interactive tags
            if (tag === 'a') score += 100;  // Links are very clickable
            if (tag === 'button') score += 95;
            if (tag === 'input') score += 90;
            if (tag === 'select') score += 85;
            if (tag === 'textarea') score += 80;
            
            // Interactive ARIA roles
            var interactiveRoles = ['button', 'link', 'tab', 'menuitem', 'option', 'checkbox', 'radio', 'switch', 'slider'];
            if (role && interactiveRoles.indexOf(role) !== -1) score += 70;
            
            // Less interactive but still clickable
            if (tag === 'label') score += 40;
            if (tag === 'li') score += 30;
            
            // Prefer elements with shorter text (more specific, less likely to be a container)
            var textLen = (el.textContent || '').trim().length;
            if (textLen > 0 && textLen < 100) score += 20;
            if (textLen > 100) score -= 10;  // Penalize long text (likely a container)
            
            // Prefer smaller elements (less likely to be a wrapper)
            var area = rect.width * rect.height;
            if (area < 10000) score += 15;  // Small element bonus
            if (area > 50000) score -= 15;  // Large element penalty
            
            return { el: m.el, index: m.index, score: score };
          });
          
          // Sort by score descending and pick the best
          scored.sort(function(a, b) { return b.score - a.score; });
          console.log('[find_element_by_semantic_selector] Scored matches:', scored.map(function(s) { return '[' + s.index + '] ' + s.el.tagName.toLowerCase() + ' score=' + s.score; }).join(', '));
          
          // Warn about duplicate IDs - this indicates invalid HTML that may cause issues
          if (sel.id) {
            var matchIndices = scored.map(function(s) { return s.index; }).join(', ');
            console.warn('[find_element_by_semantic_selector] WARNING: Multiple elements with id="' + sel.id + '" found at indices [' + matchIndices + ']. This is invalid HTML. Selecting element at index ' + scored[0].index + ' (highest score: ' + scored[0].score + ')');
          }
          
          console.log('[find_element_by_semantic_selector] Selected:', scored[0].el.tagName.toLowerCase(), 'at index', scored[0].index);
          
          return scored[0].el;
        }
        
        if (matches.length === 0) {
          console.log('[find_element_by_semantic_selector] No match found. Near-misses:', candidates.length);
          
          // Fallback: If text selector was used, try to find elements containing the text
          // and drill down to find the most specific INDEXED child with matching text
          if (sel.text) {
            console.log('[find_element_by_semantic_selector] Trying text containment fallback for:', sel.text);
            // Build a Set of indexed elements for quick lookup
            var indexedElementSet = new Set();
            for (var idx = 0; idx < indexedElements.length; idx++) {
              indexedElementSet.add(indexedElements[idx].element);
            }
            var fallbackElement = find_element_by_text_containment(sel.text, indexedElements, indexedElementSet);
            if (fallbackElement) {
              console.log('[find_element_by_semantic_selector] Text containment fallback found element:', fallbackElement.tagName);
              return fallbackElement;
            }
          }
        }
        return matches.length === 1 ? matches[0].el : null;
      }
      
      /**
       * Fallback text search: Find indexed elements whose textContent contains the given text,
       * then drill down to find the most specific INDEXED child element with EXACT matching text.
       * 
       * IMPORTANT: Only returns elements that:
       * 1. Are in the indexedElementSet (i.e., exist in the pseudo DOM with an index)
       * 2. Have textContent that EXACTLY matches the target text
       * 
       * If no exact match is found among indexed elements, returns null.
       */
      function find_element_by_text_containment(targetText, indexedElements, indexedElementSet) {
        var normalizedTarget = normalizeText(targetText);
        console.log('[find_element_by_text_containment] Searching for text:', normalizedTarget);
        
        // First, find indexed elements whose textContent contains the target text
        var containingElements = [];
        for (var i = 0; i < indexedElements.length; i++) {
          var el = indexedElements[i].element;
          var elText = normalizeText(el.textContent || '');
          if (elText.includes(normalizedTarget)) {
            containingElements.push({ el: el, index: indexedElements[i].index, textLen: elText.length });
          }
        }
        
        if (containingElements.length === 0) {
          console.log('[find_element_by_text_containment] No elements contain the target text');
          return null;
        }
        
        console.log('[find_element_by_text_containment] Found', containingElements.length, 'elements containing target text');
        
        // Sort by text length (shorter = more specific) to start with the most specific container
        containingElements.sort(function(a, b) { return a.textLen - b.textLen; });
        
        // For each containing element, try to find an INDEXED element with EXACT matching text
        for (var j = 0; j < containingElements.length; j++) {
          var container = containingElements[j].el;
          var containerIndex = containingElements[j].index;
          var containerText = normalizeText(container.textContent || '');
          
          // First check if the container itself has exact text (it's already indexed)
          if (containerText === normalizedTarget) {
            console.log('[find_element_by_text_containment] Container has exact text, returning container at index', containerIndex);
            return container;
          }
          
          // Then try to find an indexed child with exact matching text
          var exactMatch = find_deepest_indexed_child_with_exact_text(container, normalizedTarget, indexedElementSet);
          if (exactMatch) {
            console.log('[find_element_by_text_containment] Found exact match in indexed child:', exactMatch.tagName);
            return exactMatch;
          }
        }
        
        // No exact match found among indexed elements - return null
        console.log('[find_element_by_text_containment] No indexed element with exact text match found');
        return null;
      }
      
      /**
       * Recursively find the deepest INDEXED child element whose normalized textContent
       * exactly matches the target text.
       * 
       * Only returns elements that are in the indexedElementSet (i.e., elements that
       * have an index in the pseudo DOM). This ensures we only return elements that
       * are known to the system.
       */
      function find_deepest_indexed_child_with_exact_text(element, normalizedTarget, indexedElementSet) {
        // Check children first (depth-first, to find the deepest match)
        var children = element.children;
        for (var i = 0; i < children.length; i++) {
          var child = children[i];
          var childText = normalizeText(child.textContent || '');
          
          // Skip children that don't contain the target at all
          if (!childText.includes(normalizedTarget)) {
            continue;
          }
          
          // Recurse first to find the deepest match
          var deeperMatch = find_deepest_indexed_child_with_exact_text(child, normalizedTarget, indexedElementSet);
          if (deeperMatch) {
            return deeperMatch;
          }
          
          // Check if this child has exact matching text AND is indexed
          if (childText === normalizedTarget && indexedElementSet.has(child)) {
            console.log('[find_deepest_indexed_child_with_exact_text] Found indexed child with exact text:', child.tagName);
            return child;
          }
        }
        
        // Check if current element itself is an exact match AND is indexed
        var elementText = normalizeText(element.textContent || '');
        if (elementText === normalizedTarget && indexedElementSet.has(element)) {
          return element;
        }
        
        return null;
      }
      
      function match_element(el, sel, a11y) {
        var failReasons = [];
        
        var checks = [
          { prop: 'id', getValue: function() { return el.id; }, compare: function(a, b) { return a === b; } },
          { prop: 'name', getValue: function() { return el.name; }, compare: function(a, b) { return a === b; } },
          // ariaLabel: Check BOTH DOM attribute AND a11y computed name
          // This bridges the gap between pseudo DOM (uses a11y name) and real DOM (may not have aria-label)
          // Use normalizeText for consistent matching across encodings
          { prop: 'ariaLabel', getValue: function() { 
              var domAriaLabel = el.getAttribute('aria-label');
              var a11yName = a11y.name || '';
              // Return a11y name if DOM attribute is empty - this matches what pseudo DOM shows
              return normalizeText(domAriaLabel || a11yName);
            }, compare: function(a, b) { return a === normalizeText(b); } },
          { prop: 'title', getValue: function() { return normalizeText(el.getAttribute('title') || ''); }, compare: function(a, b) { return a === normalizeText(b); } },
          // text and textContains: Use normalizeText for consistent matching across Unicode encodings
          { prop: 'text', getValue: function() { var t = el.textContent; return normalizeText(t || ''); }, compare: function(a, b) { return a === normalizeText(b); } },
          { prop: 'textContains', getValue: function() { var t = el.textContent; return normalizeText(t || ''); }, compare: function(a, b) { return a.includes(normalizeText(b)); } },
          { prop: 'placeholder', getValue: function() { return normalizeText(el.placeholder || ''); }, compare: function(a, b) { return a === normalizeText(b); } },
          { prop: 'tag', getValue: function() { return el.tagName.toLowerCase(); }, compare: function(a, b) { return a === b.toLowerCase(); } },
          { prop: 'type', getValue: function() { return el.type; }, compare: function(a, b) { return a === b; } },
          // role: Check BOTH DOM attribute AND a11y computed role
          // This bridges the gap between pseudo DOM (uses a11y role) and real DOM (may not have role attribute)
          // Example: <button> has implicit role="button" in a11y tree but no role attribute in DOM
          { prop: 'role', getValue: function() { 
              var domRole = el.getAttribute('role');
              var a11yRole = a11y.role || '';
              // Return a11y role if DOM attribute is empty - this matches what pseudo DOM shows
              return domRole || a11yRole;
            }, compare: function(a, b) { return a === b; } },
          // Use getAttribute('class') instead of className to handle SVG elements
          // (SVG elements return SVGAnimatedString for className, not a plain string)
          { prop: 'class', getValue: function() { return (el.getAttribute('class') || '').split(/\\s+/).filter(Boolean).sort().join(' '); }, 
            compare: function(a, b) { return a === b.split(/\\s+/).filter(Boolean).sort().join(' '); } },
          { prop: 'value', getValue: function() { return el.value || el.getAttribute('value'); }, compare: function(a, b) { return a === b; } },
        ];
        
        for (var i = 0; i < checks.length; i++) {
          var check = checks[i];
          if (sel[check.prop] === undefined) continue;
          
          var actual = check.getValue();
          var expected = sel[check.prop];
          
          if (!check.compare(actual, expected)) {
            var displayActual = (check.prop === 'text' || check.prop === 'textContains') 
              ? ((actual || '').substring(0, 50) + ((actual || '').length > 50 ? '...' : ''))
              : (actual || '(none)');
            failReasons.push(check.prop + ': expected "' + expected + '", got "' + displayActual + '"');
            return { matches: false, failReasons: failReasons };
          }
        }
        
        return { matches: true, failReasons: [] };
      }
      
      function build_resolution_error(sel, selectorDesc, candidates) {
        var errorMsg = 'Element resolution failed: No element matches selector ' + selectorDesc + '.\\n\\n';
        
        if (candidates.length > 0) {
          errorMsg += 'Near-miss elements (matched most criteria but failed on one):\\n';
          candidates.slice(0, 3).forEach(function(c) {
            var indexInfo = c.index !== undefined ? '[' + c.index + '] ' : '';
            errorMsg += '  - ' + indexInfo + '<' + c.el.tagName.toLowerCase() + '> failed: ' + c.failReasons.join(', ') + '\\n';
          });
          errorMsg += '\\n';
        }
        
        errorMsg += 'Note: Semantic search only matches indexed elements in the pseudo DOM. Try using index as a fallback, or call current_page to refresh the element list.';
        return errorMsg;
      }
      
      window.get_highlight_element = get_highlight_element;
      window.resolve_element_by_selector = resolve_element_by_selector;
      window.remove_highlight = function() {};
    })();
  `;
  
  // Enable DOM domain first - required for DOM.resolveNode
  try {
    await cdp.send("DOM.enable");
  } catch (e) {
    // DOM may already be enabled, ignore
  }
  
  // Get the document to ensure DOM is ready
  try {
    await cdp.send("DOM.getDocument", { depth: 0 });
  } catch (e) {
    // Ignore errors
  }
  
  try {
    const evalResult = await cdp.send("Runtime.evaluate", {
      expression: initScript,
      awaitPromise: false,
      returnByValue: true,
    });
    
    // Check for evaluation errors
    if (evalResult?.exceptionDetails) {
      console.warn("[run_build_dom_a11y_tree] Init script exception:", evalResult.exceptionDetails);
      return;
    }
  } catch (e) {
    console.warn("[run_build_dom_a11y_tree] Failed to inject resolver script:", e);
    return;
  }
  
  // Now resolve each element's backendDOMNodeId to a DOM element and store in window.clickable_elements
  // Also store a11y metadata (like computed accessible name) in window.clickable_elements_a11y
  // This is crucial because:
  // - Pseudo DOM uses node.name for aria-label (what LLM sees)
  // - Real DOM may not have aria-label attribute (name computed from text content)
  // - By storing a11y.name, the matcher can bridge this gap
  let successCount = 0;
  let failCount = 0;
  
  for (const [indexStr, node] of Object.entries(selector_map)) {
    if (node.backendDOMNodeId !== undefined) {
      try {
        // Resolve the backendNodeId to a JS object reference
        const result = await cdp.send("DOM.resolveNode", {
          backendNodeId: node.backendDOMNodeId,
        });
        
        const object = result?.object;
        if (object?.objectId) {
          // Store the element reference in window.clickable_elements
          await cdp.send("Runtime.callFunctionOn", {
            objectId: object.objectId,
            functionDeclaration: `function() { window.clickable_elements[${indexStr}] = this; }`,
            awaitPromise: false,
            returnByValue: true,
          });
          
          // Release the object to avoid memory leaks
          await cdp.send("Runtime.releaseObject", { objectId: object.objectId });
          
          // Store a11y metadata - this includes the computed accessible name
          // which is what the pseudo DOM shows as aria-label
          const a11yName = node.name || "";
          const a11yRole = node.role || "";
          await cdp.send("Runtime.evaluate", {
            expression: `window.clickable_elements_a11y[${indexStr}] = { name: ${JSON.stringify(a11yName)}, role: ${JSON.stringify(a11yRole)} };`,
            awaitPromise: false,
            returnByValue: true,
          });
          
          successCount++;
        } else {
          failCount++;
        }
      } catch (e) {
        // Skip elements that can't be resolved (may be off-screen, in shadow DOM, etc.)
        failCount++;
        // console.warn(`[run_build_dom_a11y_tree] Failed to resolve element ${indexStr}:`, e);
      }
    } else {
      failCount++;
    }
  }
  
  console.log(`[run_build_dom_a11y_tree] Populated window.clickable_elements: ${successCount} succeeded, ${failCount} failed, ${Object.keys(selector_map).length} total`);
  
  // Verify that window.clickable_elements was correctly set
  try {
    const verifyResult = await cdp.send("Runtime.evaluate", {
      expression: `JSON.stringify({
        clickable_elements_exists: typeof window.clickable_elements !== 'undefined',
        clickable_elements_type: typeof window.clickable_elements,
        clickable_elements_keys: window.clickable_elements ? Object.keys(window.clickable_elements).length : 0,
        resolve_element_by_selector_exists: typeof window.resolve_element_by_selector !== 'undefined'
      })`,
      returnByValue: true,
    });
    if (verifyResult?.result?.value) {
      console.log(`[run_build_dom_a11y_tree] Verification: ${verifyResult.result.value}`);
    }
    
    // Log all clickable elements for debugging
    const windowStateResult = await cdp.send("Runtime.evaluate", {
      expression: `(function() {
        var elements = window.clickable_elements || {};
        var a11yMeta = window.clickable_elements_a11y || {};
        var keys = Object.keys(elements);
        var details = keys.map(function(key) {
          var el = elements[key];
          var a11y = a11yMeta[key] || {};
          if (!el) return { index: key, info: '(null)' };
          // Check if it's a valid DOM Element
          var isValidElement = typeof el.getAttribute === 'function';
          if (!isValidElement) {
            return { index: key, info: '(invalid - no getAttribute)', nodeType: el.nodeType, constructor: el.constructor ? el.constructor.name : 'unknown' };
          }
          return {
            index: key,
            tag: el.tagName ? el.tagName.toLowerCase() : '(unknown)',
            id: el.id || '',
            // DOM aria-label attribute (may be empty)
            domAriaLabel: el.getAttribute ? (el.getAttribute('aria-label') || '') : '',
            // A11y computed name from accessibility tree (used in pseudo DOM)
            a11yName: a11y.name || '',
            // DOM role attribute (may be empty for implicit roles)
            domRole: el.getAttribute ? (el.getAttribute('role') || '') : '',
            // A11y computed role from accessibility tree
            a11yRole: a11y.role || '',
            text: (el.textContent || '').trim().substring(0, 50)
          };
        });
        return JSON.stringify(details, null, 2);
      })()`,
      returnByValue: true,
    });
    // if (windowStateResult?.result?.value) {
    //   console.log(`[run_build_dom_a11y_tree] Window state - clickable_elements:\n${windowStateResult.result.value}`);
    // }
  } catch (e) {
    console.warn("[run_build_dom_a11y_tree] Verification failed:", e);
  }
}

// ============================================================================
// Export
// ============================================================================

export default {
  buildA11yElementTree,
  buildA11yElementTreeFromPage,
  highlightA11yElements,
  removeA11yHighlights,
  injectDomHighlightOverlays,
  removeDomHighlightOverlays,
  resolveA11yElementForInteraction,
  run_build_dom_a11y_tree,
  isInteractiveNode,
};
