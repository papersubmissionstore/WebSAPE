/**
 * Accessibility Tree Builder
 * 
 * Builds an accessibility tree using Chrome DevTools Protocol (CDP),
 * aligning with Chrome DevTools' accessibility tree mechanism.
 * 
 * Uses:
 * - Accessibility.enable
 * - Accessibility.getFullAXTree
 * - Maps backendDOMNodeId to DOM elements
 * - Filters ignored nodes and role=generic with no name
 * - Promotes children when filtering to maintain connected hierarchy
 */

import type { CDPSession, Page } from "playwright";
import { INTERACTIVE_ROLES } from "./interactive_roles";

// ============================================================================
// Types
// ============================================================================

/**
 * Raw AXNode from Chrome DevTools Protocol
 */
export interface AXNode {
  nodeId: string;
  ignored: boolean;
  ignoredReasons?: Array<{ name: string; value?: AXValue }>;
  role?: AXValue;
  name?: AXValue;
  description?: AXValue;
  value?: AXValue;
  properties?: AXProperty[];
  childIds?: string[];
  backendDOMNodeId?: number;
  frameId?: string;
}

export interface AXValue {
  type: string;
  value?: string | number | boolean;
  relatedNodes?: Array<{ backendDOMNodeId?: number; idref?: string; text?: string }>;
  sources?: Array<{
    type: string;
    value?: AXValue;
    attribute?: string;
    attributeValue?: AXValue;
    superseded?: boolean;
    nativeSource?: string;
    nativeSourceValue?: AXValue;
    invalid?: boolean;
    invalidReason?: string;
  }>;
}

export interface AXProperty {
  name: string;
  value: AXValue;
}

/**
 * Processed accessibility tree node
 */
export interface A11yTreeNode {
  id: string;
  role: string;
  name: string;
  description?: string;
  value?: string;
  properties: Record<string, string | number | boolean>;
  children: A11yTreeNode[];
  backendDOMNodeId?: number;
  domElement?: any; // Reference to DOM element if resolved
  depth: number;
  isLeaf: boolean;
}

/**
 * Options for building the accessibility tree
 */
export interface A11yTreeOptions {
  /** Include ignored nodes in the tree (default: false) */
  includeIgnored?: boolean;
  /** Include role=generic nodes without a name (default: false) */
  includeEmptyGeneric?: boolean;
  /** Maximum depth to traverse (default: unlimited) */
  maxDepth?: number;
  /** Resolve DOM elements for each node (default: false) */
  resolveDomElements?: boolean;
  /** Frame ID to focus on (default: main frame) */
  frameId?: string;
}

/**
 * Result of building the accessibility tree
 */
export interface A11yTreeResult {
  tree: A11yTreeNode | null;
  nodeCount: number;
  filteredCount: number;
  nodeMap: Map<string, A11yTreeNode>;
  domNodeMap: Map<number, A11yTreeNode>;
}

// ============================================================================
// Core Implementation
// ============================================================================

/**
 * Build accessibility tree from a Playwright page using CDP
 */
export async function buildA11yTree(
  page: Page,
  options: A11yTreeOptions = {}
): Promise<A11yTreeResult> {
  const cdpSession = await page.context().newCDPSession(page);
  
  try {
    return await buildA11yTreeFromCDP(cdpSession, options);
  } finally {
    await cdpSession.detach();
  }
}

/**
 * Build accessibility tree from a CDP session
 */
export async function buildA11yTreeFromCDP(
  cdp: CDPSession,
  options: A11yTreeOptions = {}
): Promise<A11yTreeResult> {
  const {
    includeIgnored = false,
    includeEmptyGeneric = false,
    maxDepth = Infinity,
    resolveDomElements = false,
    frameId,
  } = options;

  // Step 1: Enable accessibility domain
  await cdp.send("Accessibility.enable");

  // Step 2: Get full accessibility tree
  const params: { depth?: number; frameId?: string } = {};
  if (maxDepth !== Infinity) {
    params.depth = maxDepth;
  }
  if (frameId) {
    params.frameId = frameId;
  }

  const response = await cdp.send("Accessibility.getFullAXTree", params);
  const nodes = response?.nodes;

  if (!nodes || !Array.isArray(nodes) || nodes.length === 0) {
    return { tree: null, nodeCount: 0, nodeMap: new Map(), domNodeMap: new Map(), filteredCount: 0 };
  }

  // Step 3: Build id → node map
  const rawNodeMap = new Map<string, AXNode>();
  for (const node of nodes as AXNode[]) {
    rawNodeMap.set(node.nodeId, node);
  }

  // Step 4: Process and filter nodes, building the tree
  const nodeMap = new Map<string, A11yTreeNode>();
  const domNodeMap = new Map<number, A11yTreeNode>();
  let filteredCount = 0;

  /**
   * Check if a node should be filtered out
   * Aligned with Chrome DevTools accessibility tree behavior
   */
  function shouldFilter(node: AXNode): boolean {
    const role = extractValue(node.role);
    const name = extractValue(node.name);
    
    // Never filter nodes with interactive roles (uses same set as build_dom_a11y_tree.ts)
    if (INTERACTIVE_ROLES.has(role)) {
      return false;
    }
    
    // Check for focusable property - never filter focusable elements
    const hasFocusable = node.properties?.some(p => p.name === "focusable" && p.value?.value === true);
    if (hasFocusable) {
      return false;
    }
    
    // Filter ignored nodes (but promote their children)
    if (node.ignored && !includeIgnored) {
      return true;
    }

    // Filter role=generic with no name
    if (!includeEmptyGeneric && role === "generic" && !name) {
      return true;
    }

    return false;
  }

  /**
   * Extract string value from AXValue
   */
  function extractValue(axValue?: AXValue): string {
    if (!axValue) return "";
    if (typeof axValue.value === "string") return axValue.value;
    if (typeof axValue.value === "number") return String(axValue.value);
    if (typeof axValue.value === "boolean") return String(axValue.value);
    return "";
  }

  /**
   * Extract properties from AXNode
   */
  function extractProperties(node: AXNode): Record<string, string | number | boolean> {
    const props: Record<string, string | number | boolean> = {};
    
    if (node.properties) {
      for (const prop of node.properties) {
        const value = prop.value?.value;
        if (value !== undefined) {
          props[prop.name] = value;
        }
      }
    }
    
    return props;
  }

  /**
   * Process a node and its children, promoting children when parent is filtered
   */
  function processNode(nodeId: string, depth: number): A11yTreeNode | A11yTreeNode[] | null {
    const rawNode = rawNodeMap.get(nodeId);
    if (!rawNode) return null;

    // Check if node should be filtered
    if (shouldFilter(rawNode)) {
      filteredCount++;
      
      // Promote children: process all children and return them as an array
      if (rawNode.childIds && rawNode.childIds.length > 0) {
        const promotedChildren: A11yTreeNode[] = [];
        for (const childId of rawNode.childIds) {
          const result = processNode(childId, depth);
          if (result) {
            if (Array.isArray(result)) {
              promotedChildren.push(...result);
            } else {
              promotedChildren.push(result);
            }
          }
        }
        return promotedChildren.length > 0 ? promotedChildren : null;
      }
      return null;
    }

    // Create processed node
    const role = extractValue(rawNode.role) || "none";
    const name = extractValue(rawNode.name);
    
    const processedNode: A11yTreeNode = {
      id: rawNode.nodeId,
      role,
      name,
      description: extractValue(rawNode.description) || undefined,
      value: extractValue(rawNode.value) || undefined,
      properties: extractProperties(rawNode),
      children: [],
      backendDOMNodeId: rawNode.backendDOMNodeId,
      depth,
      isLeaf: true,
    };

    // Process children
    if (rawNode.childIds && rawNode.childIds.length > 0) {
      for (const childId of rawNode.childIds) {
        const result = processNode(childId, depth + 1);
        if (result) {
          if (Array.isArray(result)) {
            processedNode.children.push(...result);
          } else {
            processedNode.children.push(result);
          }
        }
      }
      processedNode.isLeaf = processedNode.children.length === 0;
    }

    // Add to maps
    nodeMap.set(processedNode.id, processedNode);
    if (rawNode.backendDOMNodeId !== undefined) {
      domNodeMap.set(rawNode.backendDOMNodeId, processedNode);
    }

    return processedNode;
  }

  // Find root node (first node in the list is typically the root)
  let root: A11yTreeNode | null = null;
  
  if (nodes.length > 0) {
    const result = processNode((nodes[0] as AXNode).nodeId, 0);
    if (result) {
      if (Array.isArray(result)) {
        // If root was filtered, create a synthetic root
        root = {
          id: "synthetic-root",
          role: "RootWebArea",
          name: "",
          properties: {},
          children: result,
          depth: 0,
          isLeaf: false,
        };
      } else {
        root = result;
      }
    }
  }

  // Step 5: Optionally resolve DOM elements
  if (resolveDomElements && root) {
    await resolveDomNodesFromCDP(cdp, domNodeMap);
  }

  return {
    tree: root,
    nodeCount: nodeMap.size,
    filteredCount,
    nodeMap,
    domNodeMap,
  };
}

/**
 * Resolve DOM nodes for accessibility nodes using CDP
 */
async function resolveDomNodesFromCDP(
  cdp: CDPSession,
  domNodeMap: Map<number, A11yTreeNode>
): Promise<void> {
  const backendNodeIds = Array.from(domNodeMap.keys());
  
  if (backendNodeIds.length === 0) return;

  try {
    // Request DOM nodes for all backend node IDs
    const response = await cdp.send("DOM.getNodesForSubtreeByStyle", {
      nodeId: 0, // Root node
      computedStyles: [],
      pierce: true,
    }) as { nodes?: any[] };
    const nodes = response.nodes || [];

    // Build a map from backendNodeId to node info
    const domNodes = new Map<number, any>();
    for (const node of nodes as any[]) {
      if (node.backendNodeId) {
        domNodes.set(node.backendNodeId, node);
      }
    }

    // Attach DOM info to A11yTreeNode
    for (const [backendNodeId, a11yNode] of domNodeMap) {
      const domNode = domNodes.get(backendNodeId);
      if (domNode) {
        a11yNode.domElement = {
          nodeId: domNode.nodeId,
          nodeName: domNode.nodeName,
          nodeType: domNode.nodeType,
          localName: domNode.localName,
          attributes: domNode.attributes,
        };
      }
    }
  } catch (error) {
    // DOM resolution is optional, log but don't fail
    console.warn("Failed to resolve DOM nodes:", error);
  }
}

// ============================================================================
// Tree Traversal and Utilities
// ============================================================================

/**
 * Traverse the accessibility tree and call a callback for each node
 */
export function traverseA11yTree(
  node: A11yTreeNode,
  callback: (node: A11yTreeNode, path: A11yTreeNode[]) => void | boolean,
  path: A11yTreeNode[] = []
): void {
  const currentPath = [...path, node];
  const shouldStop = callback(node, currentPath);
  
  if (shouldStop === true) return;
  
  for (const child of node.children) {
    traverseA11yTree(child, callback, currentPath);
  }
}

/**
 * Find nodes matching a predicate
 */
export function findA11yNodes(
  node: A11yTreeNode,
  predicate: (node: A11yTreeNode) => boolean
): A11yTreeNode[] {
  const results: A11yTreeNode[] = [];
  
  traverseA11yTree(node, (n) => {
    if (predicate(n)) {
      results.push(n);
    }
  });
  
  return results;
}

/**
 * Find nodes by role
 */
export function findNodesByRole(node: A11yTreeNode, role: string): A11yTreeNode[] {
  return findA11yNodes(node, (n) => n.role === role);
}

/**
 * Find nodes by name (exact match or contains)
 */
export function findNodesByName(
  node: A11yTreeNode,
  name: string,
  exact: boolean = false
): A11yTreeNode[] {
  return findA11yNodes(node, (n) => {
    if (exact) {
      return n.name === name;
    }
    return n.name.toLowerCase().includes(name.toLowerCase());
  });
}

/**
 * Find interactive elements (buttons, links, inputs, etc.)
 */
export function findInteractiveNodes(node: A11yTreeNode): A11yTreeNode[] {
  const interactiveRoles = new Set([
    "button",
    "link",
    "textbox",
    "checkbox",
    "radio",
    "combobox",
    "listbox",
    "option",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "searchbox",
    "slider",
    "spinbutton",
    "switch",
    "tab",
    "treeitem",
  ]);
  
  return findA11yNodes(node, (n) => interactiveRoles.has(n.role));
}

// ============================================================================
// String Serialization (for LLM consumption)
// ============================================================================

/**
 * Options for serializing the accessibility tree to string
 */
export interface A11ySerializeOptions {
  /** Include node properties in output (default: false) */
  includeProperties?: boolean;
  /** Include description in output (default: true) */
  includeDescription?: boolean;
  /** Include value in output (default: true) */
  includeValue?: boolean;
  /** Maximum depth to serialize (default: unlimited) */
  maxDepth?: number;
  /** Indent string (default: "  ") */
  indent?: string;
  /** Only include interactive elements (default: false) */
  interactiveOnly?: boolean;
  /** Include node IDs for reference (default: false) */
  includeIds?: boolean;
}

/**
 * Serialize accessibility tree to a compact string format
 * Suitable for LLM consumption
 */
export function serializeA11yTree(
  node: A11yTreeNode,
  options: A11ySerializeOptions = {}
): string {
  const {
    includeProperties = false,
    includeDescription = true,
    includeValue = true,
    maxDepth = Infinity,
    indent = "  ",
    interactiveOnly = false,
    includeIds = false,
  } = options;

  const interactiveRoles = new Set([
    "button",
    "link",
    "textbox",
    "checkbox",
    "radio",
    "combobox",
    "listbox",
    "option",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "searchbox",
    "slider",
    "spinbutton",
    "switch",
    "tab",
    "treeitem",
  ]);

  const lines: string[] = [];
  let nodeIndex = 0;

  function serializeNode(n: A11yTreeNode, depth: number): void {
    if (depth > maxDepth) return;
    
    // Skip non-interactive nodes if interactiveOnly is true
    if (interactiveOnly && !interactiveRoles.has(n.role)) {
      // Still process children
      for (const child of n.children) {
        serializeNode(child, depth);
      }
      return;
    }

    const prefix = indent.repeat(depth);
    const parts: string[] = [];

    // Node index for reference
    if (includeIds) {
      parts.push(`[${nodeIndex++}]`);
    }

    // Role
    parts.push(n.role);

    // Name (in quotes if non-empty)
    if (n.name) {
      parts.push(`"${escapeString(n.name)}"`);
    }

    // Value
    if (includeValue && n.value) {
      parts.push(`value="${escapeString(n.value)}"`);
    }

    // Description
    if (includeDescription && n.description) {
      parts.push(`desc="${escapeString(n.description)}"`);
    }

    // Properties
    if (includeProperties && Object.keys(n.properties).length > 0) {
      const propStr = Object.entries(n.properties)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      parts.push(`{${propStr}}`);
    }

    lines.push(prefix + parts.join(" "));

    // Process children
    for (const child of n.children) {
      serializeNode(child, depth + 1);
    }
  }

  serializeNode(node, 0);
  return lines.join("\n");
}

/**
 * Escape special characters in strings
 */
function escapeString(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/**
 * Serialize accessibility tree to a flat list format with indices
 * Useful for element selection in agents
 */
export function serializeA11yTreeFlat(
  node: A11yTreeNode,
  options: A11ySerializeOptions = {}
): { text: string; nodeList: A11yTreeNode[] } {
  const {
    includeDescription = true,
    includeValue = true,
  } = options;

  const interactiveRoles = new Set([
    "button",
    "link",
    "textbox",
    "checkbox",
    "radio",
    "combobox",
    "listbox",
    "option",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "searchbox",
    "slider",
    "spinbutton",
    "switch",
    "tab",
    "treeitem",
  ]);

  const nodeList: A11yTreeNode[] = [];
  const lines: string[] = [];

  function collectInteractive(n: A11yTreeNode): void {
    if (interactiveRoles.has(n.role)) {
      const index = nodeList.length;
      nodeList.push(n);

      const parts: string[] = [`[${index}]`, n.role];
      
      if (n.name) {
        parts.push(`"${escapeString(n.name)}"`);
      }
      
      if (includeValue && n.value) {
        parts.push(`value="${escapeString(n.value)}"`);
      }
      
      if (includeDescription && n.description) {
        parts.push(`desc="${escapeString(n.description)}"`);
      }

      lines.push(parts.join(" "));
    }

    for (const child of n.children) {
      collectInteractive(child);
    }
  }

  collectInteractive(node);

  return {
    text: lines.join("\n"),
    nodeList,
  };
}

// ============================================================================
// DOM Node Resolution via CDP
// ============================================================================

/**
 * Resolve a specific accessibility node to its DOM node using CDP
 */
export async function resolveA11yNodeToDOM(
  cdp: CDPSession,
  a11yNode: A11yTreeNode
): Promise<{ nodeId: number; objectId: string } | null> {
  if (a11yNode.backendDOMNodeId === undefined) {
    return null;
  }

  try {
    // Resolve backend node ID to a runtime object
    const { object } = await cdp.send("DOM.resolveNode", {
      backendNodeId: a11yNode.backendDOMNodeId,
    });

    if (!object?.objectId) {
      return null;
    }

    // Get node ID
    const { node } = await cdp.send("DOM.describeNode", {
      backendNodeId: a11yNode.backendDOMNodeId,
    });

    return {
      nodeId: node.nodeId,
      objectId: object.objectId,
    };
  } catch (error) {
    console.warn("Failed to resolve node to DOM:", error);
    return null;
  }
}

/**
 * Get bounding box for an accessibility node via CDP
 */
export async function getA11yNodeBoundingBox(
  cdp: CDPSession,
  a11yNode: A11yTreeNode
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  if (a11yNode.backendDOMNodeId === undefined) {
    return null;
  }

  try {
    // Use DOM.getBoxModel which is most reliable
    const { model } = await cdp.send("DOM.getBoxModel", {
      backendNodeId: a11yNode.backendDOMNodeId,
    });

    if (!model) return null;

    // Use border quad for accurate visual bounds
    const border = model.border || model.content;
    const x = Math.min(border[0], border[2], border[4], border[6]);
    const y = Math.min(border[1], border[3], border[5], border[7]);
    const maxX = Math.max(border[0], border[2], border[4], border[6]);
    const maxY = Math.max(border[1], border[3], border[5], border[7]);

    return {
      x,
      y,
      width: maxX - x,
      height: maxY - y,
    };
  } catch (error) {
    return null;
  }
}

// ============================================================================
// High-Level API for Browser Agent Integration
// ============================================================================

/**
 * Get accessibility tree in a format suitable for browser agents
 */
export async function getA11yTreeForAgent(
  page: Page,
  options: {
    interactiveOnly?: boolean;
    includeIds?: boolean;
  } = {}
): Promise<{
  treeText: string;
  interactiveElements: Array<{
    index: number;
    node: A11yTreeNode;
    role: string;
    name: string;
  }>;
}> {
  const result = await buildA11yTree(page, {
    includeIgnored: false,
    includeEmptyGeneric: false,
  });

  if (!result.tree) {
    return {
      treeText: "",
      interactiveElements: [],
    };
  }

  const { text, nodeList } = serializeA11yTreeFlat(result.tree);

  return {
    treeText: text,
    interactiveElements: nodeList.map((node, index) => ({
      index,
      node,
      role: node.role,
      name: node.name,
    })),
  };
}

/**
 * Click an element by its accessibility tree index
 */
export async function clickA11yNode(
  page: Page,
  a11yNode: A11yTreeNode
): Promise<boolean> {
  if (a11yNode.backendDOMNodeId === undefined) {
    return false;
  }

  const cdp = await page.context().newCDPSession(page);
  
  try {
    const boundingBox = await getA11yNodeBoundingBox(cdp, a11yNode);
    
    if (!boundingBox) {
      return false;
    }

    // Click at center of element
    const x = boundingBox.x + boundingBox.width / 2;
    const y = boundingBox.y + boundingBox.height / 2;

    await page.mouse.click(x, y);
    return true;
  } finally {
    await cdp.detach();
  }
}

/**
 * Type into an element by its accessibility tree index
 */
export async function typeIntoA11yNode(
  page: Page,
  a11yNode: A11yTreeNode,
  text: string
): Promise<boolean> {
  if (a11yNode.backendDOMNodeId === undefined) {
    return false;
  }

  const cdp = await page.context().newCDPSession(page);
  
  try {
    // Focus the element first
    const resolved = await resolveA11yNodeToDOM(cdp, a11yNode);
    if (!resolved) {
      return false;
    }

    await cdp.send("DOM.focus", {
      backendNodeId: a11yNode.backendDOMNodeId,
    });

    // Type the text
    await page.keyboard.type(text);
    return true;
  } finally {
    await cdp.detach();
  }
}

// ============================================================================
// Export default function for compatibility with existing infrastructure
// ============================================================================

export default {
  buildA11yTree,
  buildA11yTreeFromCDP,
  traverseA11yTree,
  findA11yNodes,
  findNodesByRole,
  findNodesByName,
  findInteractiveNodes,
  serializeA11yTree,
  serializeA11yTreeFlat,
  resolveA11yNodeToDOM,
  getA11yNodeBoundingBox,
  getA11yTreeForAgent,
  clickA11yNode,
  typeIntoA11yNode,
};
