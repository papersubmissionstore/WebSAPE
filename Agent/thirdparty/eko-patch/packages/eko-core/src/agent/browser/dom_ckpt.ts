/**
 * DOM Checkpoint - Generic DOM state capture for detecting ANY DOM changes.
 * Uses a simple fingerprinting approach: capture key properties of visible elements
 * and compare them to detect additions, removals, and modifications.
 */

/**
 * Fingerprint of a single DOM element for comparison.
 */
export interface ElementFingerprint {
  /** Unique path/selector for this element */
  path: string;
  /** Tag name */
  tag: string;
  /** Key attributes as a string */
  attrs: string;
  /** Text content (truncated) */
  text: string;
  /** Bounding rect (for position/visibility changes) */
  rect: string;
}

/**
 * DOM state captured at a point in time - a map of element paths to their fingerprints.
 */
export interface DomState {
  /** Timestamp when captured */
  timestamp: number;
  /** Map of element path -> fingerprint string */
  elements: Record<string, string>;
  /** Total element count for quick comparison */
  totalCount: number;
}

/**
 * Information about a changed element for LLM context.
 */
export interface ChangedElement {
  /** Type of change */
  changeType: 'added' | 'removed' | 'modified';
  /** DOM selector for the changed element */
  selector: string;
  /** Human-readable description of change */
  description: string;
}

/**
 * Result of comparing two DOM states.
 */
export interface DomChanges {
  /** Whether any change was detected */
  hasChange: boolean;
  /** Number of elements added */
  addedCount: number;
  /** Number of elements removed */
  removedCount: number;
  /** Number of elements modified */
  modifiedCount: number;
  /** Detailed info about changed elements (for LLM) */
  changedElements: ChangedElement[];
  /** Summary description */
  summary: string;
}

/**
 * Captures DOM state as a map of element fingerprints.
 * This function runs in the browser context via execute_script.
 * 
 * Strategy: Capture fingerprints of "interesting" visible elements:
 * - Interactive elements (buttons, inputs, links, etc.)
 * - Elements with text content
 * - Elements with key ARIA attributes
 * - Dialog/modal elements
 * 
 * Each element gets a unique path and a fingerprint string containing
 * its key properties. Any change to any property will be detected.
 */
export function capture_dom_state(): DomState {
  const elements: Record<string, string> = {};
  
  // Selectors for elements we care about tracking
  const selectors = [
    // Interactive elements
    'button', 'a', 'input', 'textarea', 'select', 'option',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
    '[role="menuitem"]', '[role="option"]', '[role="tab"]', '[role="switch"]',
    // Labels and text
    'label', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'li',
    // Dialogs and modals
    '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]',
    // Error/status elements
    '[role="alert"]', '[role="status"]', '[aria-live]',
    '[aria-invalid]', '[aria-disabled]', '[disabled]',
    // Common UI classes (keep it minimal)
    '.error', '.warning', '.success', '.modal', '.dialog', '.popup'
  ];
  
  const allElements = document.querySelectorAll(selectors.join(','));
  
  // Generate unique path for element
  function getPath(el: Element): string {
    const parts: string[] = [];
    let current: Element | null = el;
    let depth = 0;
    while (current && current !== document.body && depth < 5) {
      const tag = current.tagName.toLowerCase();
      const id = current.id ? `#${current.id}` : '';
      const cls = current.className && typeof current.className === 'string' 
        ? '.' + current.className.split(/\s+/).slice(0, 2).join('.') 
        : '';
      // Add index among siblings with same tag
      const parent = current.parentElement;
      let index = '';
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === current!.tagName);
        if (siblings.length > 1) {
          index = `[${siblings.indexOf(current) + 1}]`;
        }
      }
      parts.unshift(`${tag}${id}${cls}${index}`);
      current = current.parentElement;
      depth++;
    }
    return parts.join('>');
  }
  
  // Get fingerprint string for element
  function getFingerprint(el: Element): string {
    const parts: string[] = [];
    const tag = el.tagName.toLowerCase();
    parts.push(`tag:${tag}`);
    
    // Key attributes
    const keyAttrs = ['id', 'name', 'type', 'role', 'aria-label', 'aria-labelledby',
      'aria-invalid', 'aria-disabled', 'aria-expanded', 'aria-checked', 'aria-selected',
      'disabled', 'readonly', 'checked', 'selected', 'href', 'src', 'placeholder'];
    for (const attr of keyAttrs) {
      const val = el.getAttribute(attr);
      if (val !== null) {
        parts.push(`${attr}:${val.slice(0, 50)}`);
      }
    }
    
    // IMPORTANT: For form elements, capture the current DOM property value, not the HTML attribute.
    // el.getAttribute('value') only returns the initial/default value from HTML.
    // el.value (DOM property) returns the CURRENT value after user/script input.
    // This is critical for detecting changes made by input_text.
    const inputEl = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if ('value' in inputEl && inputEl.value !== undefined && inputEl.value !== null) {
      // Use the DOM property value (current value)
      parts.push(`value:${String(inputEl.value).slice(0, 100)}`);
    }
    
    // Also capture checked state for checkboxes/radios (DOM property, not attribute)
    if (tag === 'input' && (inputEl as HTMLInputElement).type) {
      const inputType = (inputEl as HTMLInputElement).type;
      if (inputType === 'checkbox' || inputType === 'radio') {
        parts.push(`checked-prop:${(inputEl as HTMLInputElement).checked}`);
      }
    }
    
    // Capture selected state for <option> elements (DOM property, not attribute)
    // This is critical for detecting select dropdown changes
    if (tag === 'option') {
      const optionEl = el as HTMLOptionElement;
      parts.push(`selected-prop:${optionEl.selected}`);
    }
    
    // For <select> elements, also capture selectedIndex to detect which option is selected
    if (tag === 'select') {
      const selectEl = el as HTMLSelectElement;
      parts.push(`selectedIndex:${selectEl.selectedIndex}`);
      // Also capture the selected option's text for better change description
      if (selectEl.selectedOptions && selectEl.selectedOptions.length > 0) {
        parts.push(`selectedText:${selectEl.selectedOptions[0].text.slice(0, 50)}`);
      }
    }
    
    // Class names (first 3)
    if (el.className && typeof el.className === 'string') {
      parts.push(`class:${el.className.split(/\s+/).slice(0, 3).join(' ')}`);
    }
    
    // Text content (truncated, direct text only to avoid huge strings)
    let text = '';
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += (node.textContent || '').trim();
      }
    }
    if (!text && el.textContent) {
      // For leaf elements, get all text
      if (el.children.length === 0) {
        text = (el.textContent || '').trim();
      }
    }
    if (text) {
      parts.push(`text:${text.slice(0, 100)}`);
    }
    
    // Visibility and position (coarse)
    try {
      const rect = el.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0;
      parts.push(`visible:${visible}`);
      if (visible) {
        // Round to avoid noise from minor pixel shifts
        parts.push(`pos:${Math.round(rect.left/10)*10},${Math.round(rect.top/10)*10}`);
      }
    } catch (e) {
      parts.push('visible:unknown');
    }
    
    return parts.join('|');
  }
  
  // Process elements
  let count = 0;
  allElements.forEach((el) => {
    try {
      const rect = el.getBoundingClientRect();
      // Only track visible elements (or elements that could become visible)
      if (rect.width > 0 || rect.height > 0 || el.getAttribute('aria-hidden') !== 'true') {
        const path = getPath(el);
        const fingerprint = getFingerprint(el);
        elements[path] = fingerprint;
        count++;
      }
    } catch (e) {
      // Ignore errors
    }
  });
  
  return {
    timestamp: Date.now(),
    elements,
    totalCount: count
  };
}

/**
 * Compares two DOM states and returns detailed diff information.
 * Any change (addition, removal, modification) is detected.
 * Returns changed elements info that can be fed to LLM for attention.
 */
export function detectDomChanges(
  before: DomState,
  after: DomState
): { hasSignificantChange: boolean; changes: DomChanges; changeDescriptions: string[] } {
  const changedElements: ChangedElement[] = [];
  const beforePaths = new Set(Object.keys(before.elements));
  const afterPaths = new Set(Object.keys(after.elements));
  
  // Find added elements
  for (const path of afterPaths) {
    if (!beforePaths.has(path)) {
      const fingerprint = after.elements[path];
      const tag = fingerprint.match(/tag:(\w+)/)?.[1] || 'element';
      const text = fingerprint.match(/text:([^|]*)/)?.[1] || '';
      changedElements.push({
        changeType: 'added',
        selector: path,
        description: `New ${tag} appeared${text ? `: "${text.slice(0, 50)}"` : ''}`
      });
    }
  }
  
  // Find removed elements
  for (const path of beforePaths) {
    if (!afterPaths.has(path)) {
      const fingerprint = before.elements[path];
      const tag = fingerprint.match(/tag:(\w+)/)?.[1] || 'element';
      const text = fingerprint.match(/text:([^|]*)/)?.[1] || '';
      changedElements.push({
        changeType: 'removed',
        selector: path,
        description: `${tag} removed${text ? `: "${text.slice(0, 50)}"` : ''}`
      });
    }
  }
  
  // Find modified elements (same path, different fingerprint)
  for (const path of beforePaths) {
    if (afterPaths.has(path)) {
      const beforeFp = before.elements[path];
      const afterFp = after.elements[path];
      if (beforeFp !== afterFp) {
        const tag = afterFp.match(/tag:(\w+)/)?.[1] || 'element';
        
        // Parse fingerprints to find what changed
        const beforeParts = new Map(beforeFp.split('|').map(p => {
          const [key, ...val] = p.split(':');
          return [key, val.join(':')] as [string, string];
        }));
        const afterParts = new Map(afterFp.split('|').map(p => {
          const [key, ...val] = p.split(':');
          return [key, val.join(':')] as [string, string];
        }));
        
        const changes: string[] = [];
        for (const [key, val] of afterParts) {
          const beforeVal = beforeParts.get(key);
          if (beforeVal !== val) {
            if (key === 'text') {
              changes.push(`text: "${beforeVal?.slice(0, 30) || ''}" → "${val.slice(0, 30)}"`);
            } else if (key === 'disabled' || key === 'aria-disabled') {
              changes.push(val === 'true' ? 'became disabled' : 'became enabled');
            } else if (key === 'aria-invalid') {
              changes.push(val === 'true' ? 'became invalid' : 'became valid');
            } else if (key === 'aria-expanded') {
              changes.push(val === 'true' ? 'expanded' : 'collapsed');
            } else if (key === 'aria-checked' || key === 'checked') {
              changes.push(val === 'true' ? 'checked' : 'unchecked');
            } else if (key === 'visible') {
              changes.push(val === 'true' ? 'became visible' : 'became hidden');
            } else if (key !== 'pos') { // Ignore minor position changes
              changes.push(`${key} changed`);
            }
          }
        }
        
        if (changes.length > 0) {
          changedElements.push({
            changeType: 'modified',
            selector: path,
            description: `${tag} ${changes.join(', ')}`
          });
        }
      }
    }
  }
  
  const addedCount = changedElements.filter(e => e.changeType === 'added').length;
  const removedCount = changedElements.filter(e => e.changeType === 'removed').length;
  const modifiedCount = changedElements.filter(e => e.changeType === 'modified').length;
  const hasChange = changedElements.length > 0;
  
  // Build summary
  const summaryParts: string[] = [];
  if (addedCount > 0) summaryParts.push(`${addedCount} added`);
  if (removedCount > 0) summaryParts.push(`${removedCount} removed`);
  if (modifiedCount > 0) summaryParts.push(`${modifiedCount} modified`);
  const summary = hasChange 
    ? `DOM changed: ${summaryParts.join(', ')}`
    : 'No DOM changes detected';
  
  // Build change descriptions (for backward compatibility)
  const changeDescriptions = changedElements.slice(0, 10).map(e => e.description);
  
  return {
    hasSignificantChange: hasChange,
    changes: {
      hasChange,
      addedCount,
      removedCount,
      modifiedCount,
      changedElements,
      summary
    },
    changeDescriptions
  };
}
