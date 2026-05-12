// @ts-nocheck
export function run_build_dom_tree() {
  var computedStyleCache = new WeakMap();

  /**
   * Gets the cached computed style for an element.
   */
  function getCachedComputedStyle(element) {
    if (!element) return null;
    if (computedStyleCache.has(element)) {
      return computedStyleCache.get(element);
    }
    try {
      const style = window.getComputedStyle(element);
      if (style) {
        computedStyleCache.set(element, style);
      }
      return style;
    } catch (e) {
      return null;
    }
  }

  /**
   * Get clickable elements on the page
   *
   * @param {*} markHighlightElements Is mark highlighted
   * @param {*} includeAttributes [attr_names...]
   * @param {*} includeNonIndexedElements Whether to include non-indexed text elements (default: true)
   * @returns { element_str, client_rect, selector_map, area_map }
   */
  function get_clickable_elements(markHighlightElements = true, includeAttributes, includeNonIndexedElements = true, viewportExpansion = null) {
    window.clickable_elements = {};
    computedStyleCache = new WeakMap();
    document.querySelectorAll("[eko-user-highlight-id]").forEach(ele => ele.removeAttribute("eko-user-highlight-id"));
    if (typeof window.__eko_clearDeferredPills === 'function') window.__eko_clearDeferredPills();
    let page_tree = build_dom_tree(markHighlightElements, viewportExpansion);
    let element_tree = parse_node(page_tree);
    let element_str = clickable_elements_to_string(element_tree, includeAttributes, includeNonIndexedElements);
    // Cluster-legend pass: place all dense-cluster pills (deferred during
    // the per-element styling loop) into a gutter region with leader lines.
    if (markHighlightElements && typeof window.__eko_finalizeDeferredLabels === 'function') {
      try { window.__eko_finalizeDeferredLabels(); } catch (_e) { /* best-effort */ }
    }
    let client_rect = {
      width: window.innerWidth || document.documentElement.clientWidth,
      height: window.innerHeight || document.documentElement.clientHeight,
    }
    if (markHighlightElements) {
      let selector_map = {};
      // selector_map = create_selector_map(element_tree);
      return { element_str, client_rect, selector_map };
    } else {
      let area_map = create_area_map(element_tree);
      return { element_str, client_rect, area_map };
    }
  }

  function get_highlight_element(highlightIndex) {
    let element = document.querySelector(`[eko-user-highlight-id="eko-highlight-${highlightIndex}"]`);
    return element || window.clickable_elements[highlightIndex];
  }

  /**
   * Resolve an element by a BrowserSelector.
   * Supports numeric index or object with semantic properties:
   * index, id, name, ariaLabel, title, text, textContains, placeholder, tag, type, role, class
   * 
   * @param {number|object} selector - Numeric index or selector object
   * @returns {Element} The matched element
   * @throws {Error} If no element matches the selector, with detailed error message
   */
  function resolve_element_by_selector(selector) {
    const VALID_PROPS = ['index', 'id', 'name', 'ariaLabel', 'title', 'text', 'textContains', 'placeholder', 'tag', 'type', 'role', 'class', 'value'];
    const selectorDesc = JSON.stringify(selector);
    
    // === VALIDATION ===
    if (selector === null || selector === undefined) {
      throw new Error(`Element resolution failed: Selector is ${selector}. You must provide a valid selector (numeric index or object with properties: ${VALID_PROPS.join(', ')}).`);
    }
    
    if (typeof selector !== 'number' && typeof selector !== 'object') {
      throw new Error(`Element resolution failed: Invalid selector type. Expected number or object, got ${typeof selector}. Selector value: ${selectorDesc}`);
    }
    
    if (Array.isArray(selector)) {
      throw new Error(`Element resolution failed: Selector cannot be an array. Expected number or object. Received: ${selectorDesc}`);
    }
    
    // For object selectors, check it has at least one valid property
    if (typeof selector === 'object') {
      const hasValidProp = VALID_PROPS.some(prop => selector[prop] !== undefined);
      if (!hasValidProp) {
        throw new Error(`Element resolution failed: Selector object is empty or has no valid properties. You must provide at least one of: ${VALID_PROPS.join(', ')}. Received: ${selectorDesc}`);
      }
    }
    
    // === RESOLUTION ===
    let element = null;
    let candidates = [];
    
    // Normalize selector to object form
    const sel = typeof selector === 'number' ? { index: selector } : selector;
    const hasOnlyIndex = sel.index !== undefined && VALID_PROPS.filter(p => p !== 'index').every(p => sel[p] === undefined);
    
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
    const interactableCheck = validate_element_interactable(element, selectorDesc);
    if (!interactableCheck.ok) {
      // If element is disconnected (zombie node from framework re-render), try cheap re-resolve
      // from the live DOM using CSS attribute selectors instead of failing immediately.
      if (!element.isConnected && typeof sel === 'object') {
        console.log('[resolve_element_by_selector] Element disconnected, attempting quick re-resolve from live DOM for:', selectorDesc);
        const reResolved = quick_re_resolve_from_dom(sel);
        if (reResolved) {
          const reCheck = validate_element_interactable(reResolved, selectorDesc);
          if (reCheck.ok) {
            console.log('[resolve_element_by_selector] Quick re-resolve succeeded for disconnected element');
            return { element: reResolved, canonicalSelector: null };
          }
          console.warn('[resolve_element_by_selector] Quick re-resolve found element but it failed validation:', reCheck.error);
        } else {
          console.warn('[resolve_element_by_selector] Quick re-resolve found no matching element in live DOM');
        }
      }
      throw new Error(interactableCheck.error);
    }
    
    console.log('[resolve_element_by_selector] Resolved element:', element, 'for selector:', selector);
    return { element, canonicalSelector: null };
  }
  
  /**
   * Cheap re-resolve: when a cached element is disconnected (zombie node from React re-render),
   * try to find the equivalent element in the live DOM using CSS attribute selectors.
   * This avoids the cost of rebuilding the full pseudo DOM tree.
   */
  function quick_re_resolve_from_dom(sel) {
    const parts = [];

    // Build a CSS selector from known semantic properties
    if (sel.tag) parts.push(sel.tag);
    if (sel.id) parts.push(`#${CSS.escape(sel.id)}`);
    if (sel.ariaLabel) parts.push(`[aria-label="${CSS.escape(sel.ariaLabel)}"]`);
    if (sel.role) parts.push(`[role="${CSS.escape(sel.role)}"]`);
    if (sel.name) parts.push(`[name="${CSS.escape(sel.name)}"]`);
    if (sel.placeholder) parts.push(`[placeholder="${CSS.escape(sel.placeholder)}"]`);
    if (sel.title) parts.push(`[title="${CSS.escape(sel.title)}"]`);
    if (sel.type) parts.push(`[type="${CSS.escape(sel.type)}"]`);
    if (sel.value) parts.push(`[value="${CSS.escape(sel.value)}"]`);

    const cssSelector = parts.join('');
    if (!cssSelector) return null;

    try {
      const candidates = document.querySelectorAll(cssSelector);
      if (candidates.length === 0) return null;
      if (candidates.length === 1) return candidates[0];

      // Multiple matches - filter by text content if available
      if (sel.text) {
        for (const el of candidates) {
          if ((el.textContent || '').trim() === sel.text) return el;
        }
      }
      if (sel.textContains) {
        for (const el of candidates) {
          if ((el.textContent || '').includes(sel.textContains)) return el;
        }
      }

      // If class is specified, narrow down further
      if (sel.class) {
        for (const el of candidates) {
          if (el.classList.contains(sel.class)) return el;
        }
      }

      // Return first connected, visible candidate as best-effort
      for (const el of candidates) {
        if (el.isConnected) return el;
      }
      return null;
    } catch (e) {
      console.warn('[quick_re_resolve_from_dom] CSS query failed:', e);
      return null;
    }
  }

  /**
   * Validate that an element is actually interactable (visible, enabled, not covered)
   */
  function validate_element_interactable(element, selectorDesc) {
    // Check if element is still in the DOM (use isConnected to support Shadow DOM)
    if (!element.isConnected) {
      return { 
        ok: false, 
        error: `Element resolution failed: Element found but is no longer in the DOM. Selector: ${selectorDesc}. Try calling current_page to refresh the element list.`
      };
    }
    
    // Check if element is visible (not display:none or visibility:hidden)
    const style = window.getComputedStyle(element);
    if (style.display === 'none') {
      return { 
        ok: false, 
        error: `Element resolution failed: Element found but has display:none. Selector: ${selectorDesc}. The element may be hidden. Try a different selector or wait for the element to become visible.`
      };
    }
    if (style.visibility === 'hidden') {
      return { 
        ok: false, 
        error: `Element resolution failed: Element found but has visibility:hidden. Selector: ${selectorDesc}. The element may be hidden. Try a different selector or wait for the element to become visible.`
      };
    }
    
    // Check if pointer-events is none (element won't receive clicks)
    if (style.pointerEvents === 'none') {
      return { 
        ok: false, 
        error: `Element resolution failed: Element found but has pointer-events:none. Selector: ${selectorDesc}. The element cannot receive clicks. This may indicate the page is still loading or the element is decorative.`
      };
    }
    
    // NOTE: No separate ancestor walk for pointer-events is needed here.
    // CSS pointer-events is an inherited property, so the element's own
    // computed pointerEvents (checked above) already reflects the effective
    // value through the full ancestor chain.  For example, Bootstrap 4
    // modals use .modal-dialog { pointer-events: none } to let backdrop
    // clicks through, then .modal-content { pointer-events: auto } to
    // re-enable interaction.  A button inside .modal-content correctly
    // inherits pointer-events: auto, and the check above passes.
    // A previous ancestor walk here caused false positives by finding
    // pointer-events:none on a distant ancestor (.modal-dialog) even
    // when a closer ancestor (.modal-content) had already overridden it.
    
    // Check if element has zero dimensions
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      return { 
        ok: false, 
        error: `Element resolution failed: Element found but has zero dimensions (width=0, height=0). Selector: ${selectorDesc}. The element may not be rendered yet. Try waiting or scrolling.`
      };
    }
    
    // Check if element is disabled
    if (element.disabled === true || element.getAttribute('aria-disabled') === 'true') {
      return { 
        ok: false, 
        error: `Element resolution failed: Element found but is disabled. Selector: ${selectorDesc}. Wait for the element to become enabled before interacting.`
      };
    }
    
    // Check opacity - very low opacity might indicate loading/transition state
    const opacity = parseFloat(style.opacity);
    if (opacity < 0.1) {
      return { 
        ok: false, 
        error: `Element resolution failed: Element found but has very low opacity (${opacity}). Selector: ${selectorDesc}. The element may be fading in or in a transition state. Try waiting for animation to complete.`
      };
    }
    
    // Check if element or ancestors are in the middle of a CSS animation/transition
    // that might affect interactability
    const isAnimating = style.animationName !== 'none' || style.transition !== 'none' && style.transition !== 'all 0s ease 0s';
    if (isAnimating) {
      console.warn(`[resolve_element_by_selector] Element may be animating. animationName: ${style.animationName}, transition: ${style.transition}`);
    }
    
    // Check if element is in viewport (warn but don't fail - clicking will scroll)
    const inViewport = rect.top < window.innerHeight && rect.bottom > 0 && 
                       rect.left < window.innerWidth && rect.right > 0;
    if (!inViewport) {
      console.warn(`[resolve_element_by_selector] Element is outside viewport. Will need to scroll. Rect:`, rect);
    }
    
    // Check if element is covered by another element at its center point
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    
    // Only check if the center point is in the viewport
    if (centerX >= 0 && centerX <= window.innerWidth && centerY >= 0 && centerY <= window.innerHeight) {
      const topElement = document.elementFromPoint(centerX, centerY);
      if (topElement && topElement !== element && !element.contains(topElement) && !topElement.contains(element)) {
        // Check if the covering element is part of the same clickable structure
        let isSameClickTarget = false;
        let current = topElement;
        while (current && current !== document.body) {
          if (current === element) {
            isSameClickTarget = true;
            break;
          }
          current = current.parentElement;
        }
        
        if (!isSameClickTarget) {
          const coveringTag = topElement.tagName.toLowerCase();
          // Use getAttribute('class') instead of className to handle SVG elements
          // (SVG elements return SVGAnimatedString for className, not a plain string)
          const coveringClass = topElement.getAttribute('class') || '';
          const coveringId = topElement.id || '';
          const coveringStyle = window.getComputedStyle(topElement);
          
          // Check if the covering element is a known loading/overlay pattern
          const isLoadingOverlay = 
            coveringClass.toLowerCase().includes('loading') ||
            coveringClass.toLowerCase().includes('spinner') ||
            coveringClass.toLowerCase().includes('overlay') ||
            coveringClass.toLowerCase().includes('modal') ||
            coveringClass.toLowerCase().includes('backdrop') ||
            coveringId.toLowerCase().includes('loading') ||
            coveringStyle.position === 'fixed' ||
            coveringStyle.position === 'absolute';
          
          // ── action-landing watchdog hook ────────────────────────────
          // If the watchdog is installed (see action_landing_watchdog.ts),
          // give it a chance to rescue this action via scrollIntoView and
          // re-test before we hard-fail. Original behaviour is preserved
          // when the watchdog isn't installed (upstream-merge friendly).
          try {
            const watchdog = (window as any).__ekoActionLandingWatchdog;
            if (typeof watchdog === 'function') {
              const wdRes = watchdog(element, { actionKind: 'resolve' });
              if (wdRes && wdRes.rescued) {
                // Watchdog scrolled+rechecked successfully — proceed.
              } else {
                return {
                  ok: false,
                  error: (wdRes && wdRes.error) ||
                    `Element resolution failed: Element found but is covered by another element at its center point. Selector: ${selectorDesc}. Covering element: <${coveringTag}${coveringId ? ' id="' + coveringId + '"' : ''} class="${coveringClass}">. ${isLoadingOverlay ? 'This appears to be a loading overlay or modal.' : ''} The element may be behind a modal, overlay, or loading spinner. Try closing the overlay or waiting for it to disappear.`
                };
              }
            } else {
              return {
                ok: false,
                error: `Element resolution failed: Element found but is covered by another element at its center point. Selector: ${selectorDesc}. Covering element: <${coveringTag}${coveringId ? ' id="' + coveringId + '"' : ''} class="${coveringClass}">. ${isLoadingOverlay ? 'This appears to be a loading overlay or modal.' : ''} The element may be behind a modal, overlay, or loading spinner. Try closing the overlay or waiting for it to disappear.`
              };
            }
          } catch (_e) {
            return {
              ok: false,
              error: `Element resolution failed: Element found but is covered by another element at its center point. Selector: ${selectorDesc}. Covering element: <${coveringTag}${coveringId ? ' id="' + coveringId + '"' : ''} class="${coveringClass}">. ${isLoadingOverlay ? 'This appears to be a loading overlay or modal.' : ''} The element may be behind a modal, overlay, or loading spinner. Try closing the overlay or waiting for it to disappear.`
            };
          }
        }
      }
    }
    
    // Log element state for debugging
    console.log(`[validate_element_interactable] Element passed all checks:`, {
      selector: selectorDesc,
      tagName: element.tagName.toLowerCase(),
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      opacity,
      pointerEvents: style.pointerEvents,
      inViewport,
      disabled: element.disabled,
      ariaDisabled: element.getAttribute('aria-disabled')
    });
    
    return { ok: true };
  }
  
  /**
   * Find element by semantic selector properties (id, name, ariaLabel, etc.)
   * Only searches within indexed elements (those in pseudo DOM) to prevent
   * matching non-interactive elements with similar names.
   * Throws an error if multiple elements match the selector (ambiguous).
   */
  function find_element_by_semantic_selector(sel, candidates) {
    // Only search within indexed elements (those in pseudo DOM)
    const clickableElements = (window as any).clickable_elements || {};
    const indexedElements = Object.keys(clickableElements).map(key => ({
      index: parseInt(key, 10),
      element: clickableElements[key]
    })).filter(item => item.element);
    
    // Collect ALL matching elements to detect ambiguous selectors
    const matches = [];
    
    for (const { element: el, index } of indexedElements) {
      const result = match_element(el, sel);
      
      if (result.matches) {
        matches.push({ el, index });
      } else {
        // Track near-misses (failed on only 1 criterion when multiple were specified)
        const specifiedProps = Object.keys(sel).filter(k => sel[k] !== undefined && k !== 'index').length;
        if (result.failReasons.length === 1 && specifiedProps > 1) {
          candidates.push({ el, index, failReasons: result.failReasons });
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
        `Ambiguous selector: ${JSON.stringify(sel)} matched ${matches.length} elements ` +
        `at indices [${matches.map(m => m.index).join(', ')}]. ` +
        `Refine the selector with additional discriminators (e.g. ariaLabel, id, more specific text) ` +
        `or use the numeric index of the intended element.`
      );
    }

    // If multiple matches, pick the most interactive/clickable element
    if (matches.length > 1) {
      console.log('[find_element_by_semantic_selector] Multiple matches found:', matches.length, '- selecting most interactive element');
      
      // Score each element based on interactivity (higher = more interactive)
      const scored = matches.map(m => {
        const el = m.el;
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role');
        let score = 0;
        
        // Highly interactive tags
        if (tag === 'a') score += 100;  // Links are very clickable
        if (tag === 'button') score += 95;
        if (tag === 'input') score += 90;
        if (tag === 'select') score += 85;
        if (tag === 'textarea') score += 80;
        
        // Interactive ARIA roles
        const interactiveRoles = ['button', 'link', 'tab', 'menuitem', 'option', 'checkbox', 'radio', 'switch', 'slider'];
        if (role && interactiveRoles.includes(role)) score += 70;
        
        // Less interactive but still clickable
        if (tag === 'label') score += 40;
        if (tag === 'li') score += 30;
        
        // Prefer elements with shorter text (more specific, less likely to be a container)
        const textLen = (el.textContent || '').trim().length;
        if (textLen > 0 && textLen < 100) score += 20;
        if (textLen > 100) score -= 10;  // Penalize long text (likely a container)
        
        // Prefer smaller elements (less likely to be a wrapper)
        const rect = el.getBoundingClientRect();
        const area = rect.width * rect.height;
        if (area < 10000) score += 15;  // Small element bonus
        if (area > 50000) score -= 15;  // Large element penalty
        
        return { ...m, score };
      });
      
      // Sort by score descending and pick the best
      scored.sort((a, b) => b.score - a.score);
      console.log('[find_element_by_semantic_selector] Scored matches:', scored.map(s => `[${s.index}] ${s.el.tagName.toLowerCase()} score=${s.score}`).join(', '));
      console.log('[find_element_by_semantic_selector] Selected:', scored[0].el.tagName.toLowerCase(), 'at index', scored[0].index);
      
      return scored[0].el;
    }
    
    return matches.length === 1 ? matches[0].el : null;
  }
  
  /**
   * Check if an element matches the given selector
   */
  function match_element(el, sel) {
    const failReasons = [];
    
    const checks = [
      { prop: 'id', getValue: () => el.id, compare: (a, b) => a === b },
      { prop: 'name', getValue: () => el.name, compare: (a, b) => a === b },
      { prop: 'ariaLabel', getValue: () => el.getAttribute('aria-label'), compare: (a, b) => a === b },
      { prop: 'title', getValue: () => el.getAttribute('title'), compare: (a, b) => a === b },
      { prop: 'text', getValue: () => (el.textContent?.trim() || '').replace(/\s+/g, ' '), compare: (a, b) => a === b.replace(/\s+/g, ' ') },
      { prop: 'textContains', getValue: () => (el.textContent?.trim() || '').replace(/\s+/g, ' '), compare: (actual, expected) => actual.includes(expected.replace(/\s+/g, ' ')) },
      { prop: 'placeholder', getValue: () => el.placeholder, compare: (a, b) => a === b },
      { prop: 'tag', getValue: () => el.tagName.toLowerCase(), compare: (a, b) => a === b.toLowerCase() },
      { prop: 'type', getValue: () => el.type, compare: (a, b) => a === b },
      { prop: 'role', getValue: () => el.getAttribute('role'), compare: (a, b) => a === b },
      // Use getAttribute('class') instead of className to handle SVG elements
      // (SVG elements return SVGAnimatedString for className, not a plain string)
      { prop: 'class', getValue: () => (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).sort().join(' '), 
        compare: (actual, expected) => actual === expected.split(/\s+/).filter(Boolean).sort().join(' ') },
      { prop: 'value', getValue: () => el.value || el.getAttribute('value'), compare: (a, b) => a === b },
    ];
    
    for (const check of checks) {
      if (sel[check.prop] === undefined) continue;
      
      const actual = check.getValue();
      const expected = sel[check.prop];
      
      if (!check.compare(actual, expected)) {
        const displayActual = check.prop === 'text' || check.prop === 'textContains' 
          ? `${(actual || '').substring(0, 50)}${(actual || '').length > 50 ? '...' : ''}`
          : (actual || '(none)');
        failReasons.push(`${check.prop}: expected "${expected}", got "${displayActual}"`);
        return { matches: false, failReasons };
      }
    }
    
    return { matches: true, failReasons: [] };
  }
  
  /**
   * Build a detailed error message for resolution failure
   */
  function build_resolution_error(sel, selectorDesc, candidates) {
    let errorMsg = `Element resolution failed: No element matches selector ${selectorDesc}.\n\n`;
    
    // Hint for title vs aria-label confusion
    if (sel.title !== undefined && sel.ariaLabel === undefined) {
      errorMsg += `HINT: You used 'title' but the element might have 'aria-label' instead.\n`;
      errorMsg += `  - If you see aria-label="..." use {ariaLabel: "..."}\n`;
      errorMsg += `  - If you see title="..." use {title: "..."}\n\n`;
    }
    
    // Show similar elements for aria-label
    if (sel.ariaLabel !== undefined) {
      const similar = find_similar_elements('[aria-label]', 'aria-label', sel.ariaLabel);
      if (similar.length > 0) {
        errorMsg += 'Similar elements with aria-label found:\n';
        similar.forEach(s => { errorMsg += `  - ${s}\n`; });
        errorMsg += '\n';
      }
    }
    
    // Show similar elements for title
    if (sel.title !== undefined) {
      const similar = find_similar_elements('[title]', 'title', sel.title);
      if (similar.length > 0) {
        errorMsg += 'Similar elements with title found:\n';
        similar.forEach(s => { errorMsg += `  - ${s}\n`; });
        errorMsg += '\n';
      }
    }
    
    // Show near-miss candidates
    if (candidates.length > 0) {
      errorMsg += 'Near-miss elements (matched most criteria but failed on one):\n';
      candidates.slice(0, 3).forEach(c => {
        const indexInfo = c.index !== undefined ? `[${c.index}] ` : '';
        errorMsg += `  - ${indexInfo}<${c.el.tagName.toLowerCase()}> failed: ${c.failReasons.join(', ')}\n`;
      });
      errorMsg += '\n';
    }
    
    // Check if the DOM might be stale (most cached elements are disconnected after page navigation)
    const clickableElements = (window as any).clickable_elements || {};
    const cachedKeys = Object.keys(clickableElements);
    const totalCached = cachedKeys.length;
    const disconnectedCount = cachedKeys.filter(k => clickableElements[k] && !clickableElements[k].isConnected).length;
    if (totalCached > 0 && disconnectedCount / totalCached > 0.5) {
      errorMsg += `WARNING: ${disconnectedCount}/${totalCached} cached elements are disconnected from the DOM. ` +
        'The page likely navigated since the last DOM scan. Call current_page to refresh the element list before retrying.\n\n';
    }

    errorMsg += 'Note: Semantic search only matches indexed elements in the pseudo DOM. Try using index as a fallback, or call current_page to refresh the element list.';
    return errorMsg;
  }
  
  /**
   * Find elements with similar attribute values for error hints
   */
  function find_similar_elements(cssSelector, attrName, searchValue) {
    if (!searchValue || searchValue.length < 3) return [];
    
    const searchPrefix = searchValue.substring(0, Math.min(10, searchValue.length));
    return Array.from(document.querySelectorAll(cssSelector))
      .filter(el => {
        const val = el.getAttribute(attrName) || '';
        return val.includes(searchPrefix) || searchValue.includes(val.substring(0, 10));
      })
      .slice(0, 3)
      .map(el => `<${el.tagName.toLowerCase()} ${attrName}="${el.getAttribute(attrName)}" role="${el.getAttribute('role') || '(none)'}">`);
  }

  function remove_highlight() {
    let highlight = document.getElementById('eko-highlight-container');
    if (highlight) {
      highlight.remove();
    }
    // Also clear noocclude leader-line SVG (drawn in a separate overlay).
    let leaders = document.getElementById('__eko_leader_svg');
    if (leaders) leaders.remove();
    computedStyleCache = new WeakMap();
  }

  function clickable_elements_to_string(element_tree, includeAttributes, includeNonIndexedElements = true) {
    if (!includeAttributes) {
      includeAttributes = [
        'id',
        'title',
        'type',
        'name',
        'role',
        'class',
        'src',
        'href',
        'aria-label',
        'placeholder',
        'value',
        'alt',
        'aria-expanded',
      ];
    }

    function get_all_text_till_next_clickable_element(element_node) {
      let text_parts = [];
      function collect_text(node) {
        if (node.tagName && node != element_node && node.highlightIndex != null) {
          return;
        }
        if (!node.tagName && node.text) {
          text_parts.push(node.text);
        } else if (node.tagName) {
          for (let i = 0; i < node.children.length; i++) {
            collect_text(node.children[i]);
          }
        }
      }
      collect_text(element_node);
      return text_parts.join('\n').trim().replace(/\n+/g, ' ');
    }

    function has_parent_with_highlight_index(node) {
      let current = node.parent;
      while (current) {
        if (current.highlightIndex != null) {
          return true;
        }
        current = current.parent;
      }
      return false;
    }

    let formatted_text = [];
    function process_node(node, depth) {
      if (node.text == null) {
        if (node.highlightIndex != null) {
          let attributes_str = '';
          if (includeAttributes) {
            for (let i = 0; i < includeAttributes.length; i++) {
              let key = includeAttributes[i];
              let value = node.attributes[key];
              if (key == "class" && value && value.length > 30) {
                let classList = value.split(" ").slice(0, 3);
                value = classList.join(" ");
              } else if ((key == "src" || key == "href") && value && value.length > 200) {
                continue;
              } else if ((key == "src" || key == "href") && value && value.startsWith("/")) {
                value = window.location.origin + value;
              }
              if (key && value) {
                attributes_str += ` ${key}="${value}"`;
              }
            }
            attributes_str = attributes_str.replace(/\n+/g, ' ');
          }
          let text = get_all_text_till_next_clickable_element(node);
          formatted_text.push(
            `[${node.highlightIndex}]:<${node.tagName}${attributes_str}>${text}</${node.tagName}>`
          );
        }
        for (let i = 0; i < node.children.length; i++) {
          let child = node.children[i];
          process_node(child, depth + 1);
        }
      } else if (includeNonIndexedElements && !has_parent_with_highlight_index(node)) {
        formatted_text.push(`[]:${node.text}`);
      }
    }
    process_node(element_tree, 0);
    return formatted_text.join('\n');
  }

  function create_selector_map(element_tree) {
    let selector_map = {};
    function process_node(node) {
      if (node.tagName) {
        if (node.highlightIndex != null) {
          selector_map[node.highlightIndex] = node;
        }
        for (let i = 0; i < node.children.length; i++) {
          process_node(node.children[i]);
        }
      }
    }
    process_node(element_tree);
    return selector_map;
  }

  function create_area_map(element_tree) {
    let area_map = {};
    // Pre-pass: collect every highlighted element so external hooks
    // (e.g. window.__eko_isRedundantLabel installed by
    // run_install_noocclude_label_hook) can spot redundant wrappers
    // whose inner control is already annotated. Logic intentionally
    // lives outside this file to keep the diff vs. upstream eko small.
    const highlightedElements = new Set();
    function collect_highlighted(node) {
      if (node.tagName && node.highlightIndex != null) {
        const el = window.clickable_elements[node.highlightIndex];
        if (el) highlightedElements.add(el);
      }
      if (node.children) {
        for (let i = 0; i < node.children.length; i++) collect_highlighted(node.children[i]);
      }
    }
    collect_highlighted(element_tree);
    const isRedundant = typeof window.__eko_isRedundantLabel === 'function'
      ? window.__eko_isRedundantLabel
      : null;

    function process_node(node) {
      if (node.tagName) {
        if (node.highlightIndex != null) {
          const element = window.clickable_elements[node.highlightIndex]
          const rect = get_element_real_bounding_rect(element);
          if (isRedundant && isRedundant(element, highlightedElements)) {
            rect.noDraw = true;
          }
          area_map[node.highlightIndex] = rect;
        }
        for (let i = 0; i < node.children.length; i++) {
          process_node(node.children[i]);
        }
      }
    }
    process_node(element_tree);
    return area_map;
  }

  function get_element_real_bounding_rect(element) {
    if (!element || !(element instanceof Element)) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }

    let rect = element.getBoundingClientRect();
    let x = rect.left;
    let y = rect.top;
    let width = rect.width;
    let height = rect.height;

    let win = element.ownerDocument.defaultView;
    let maxDepth = 10;
    let depth = 0;

    while (win && win !== win.parent && depth < maxDepth) {
      depth++;
      const frameElement = win.frameElement;
      if (!frameElement) {
        break;
      }

      const frameRect = frameElement.getBoundingClientRect();
      x += frameRect.left;
      y += frameRect.top;

      // Consider the border and padding of the iframe.
      const frameStyle = getCachedComputedStyle(frameElement);
      x += parseFloat(frameStyle.borderLeftWidth) || 0;
      y += parseFloat(frameStyle.borderTopWidth) || 0;
      x += parseFloat(frameStyle.paddingLeft) || 0;
      y += parseFloat(frameStyle.paddingTop) || 0;
      win = win.parent;
    }
    return { x, y, width, height };
  }

  function parse_node(node_data, parent) {
    if (!node_data) {
      return;
    }
    if (node_data.type == 'TEXT_NODE') {
      return {
        text: node_data.text || '',
        isVisible: node_data.isVisible || false,
        parent: parent,
      };
    }
    let element_node = {
      tagName: node_data.tagName,
      xpath: node_data.xpath,
      highlightIndex: node_data.highlightIndex,
      attributes: node_data.attributes || {},
      isVisible: node_data.isVisible || false,
      isInteractive: node_data.isInteractive || false,
      isTopElement: node_data.isTopElement || false,
      shadowRoot: node_data.shadowRoot || false,
      children: [],
      parent: parent,
    };
    if (node_data.children) {
      let children = [];
      for (let i = 0; i < node_data.children.length; i++) {
        let child = node_data.children[i];
        if (child) {
          let child_node = parse_node(child, element_node);
          if (child_node) {
            children.push(child_node);
          }
        }
      }
      element_node.children = children;
    }
    return element_node;
  }

  function build_dom_tree(markHighlightElements, viewportExpansion = null) {
    let highlightIndex = 0; // Reset highlight index
    let duplicates = new Set();

    function highlightElement(element, index, parentIframe = null) {
      // Create or get highlight container
      let container = document.getElementById('eko-highlight-container');
      if (!container) {
        container = document.createElement('div');
        container.id = 'eko-highlight-container';
        container.style.position = 'fixed';
        container.style.pointerEvents = 'none';
        container.style.top = '0';
        container.style.left = '0';
        container.style.width = '100%';
        container.style.height = '100%';
        container.style.zIndex = '2147483647'; // Maximum z-index value
        document.documentElement.appendChild(container);
      }

      // Generate a color based on the index
      const colors = [
        '#FF0000',
        '#00FF00',
        '#0000FF',
        '#FFA500',
        '#800080',
        '#008080',
        '#FF69B4',
        '#4B0082',
        '#FF4500',
        '#2E8B57',
        '#DC143C',
        '#4682B4',
      ];
      const colorIndex = index % colors.length;
      const baseColor = colors[colorIndex];
      const backgroundColor = `${baseColor}1A`; // 10% opacity version of the color

      // Create highlight overlay
      const overlay = document.createElement('div');
      overlay.style.position = 'absolute';
      overlay.style.pointerEvents = 'none';
      overlay.style.boxSizing = 'border-box';

      // Hook: if an external overlay styler is installed, delegate to it;
      // otherwise fall through to the default (legacy) overlay styling.
      const externalOverlayStyler = (window as any).__eko_styleHighlightOverlay;
      if (typeof externalOverlayStyler === 'function') {
        externalOverlayStyler(overlay, baseColor);
      } else {
        overlay.style.border = `2px solid ${baseColor}`;
      }

      // Position overlay based on element
      const rect = element.getBoundingClientRect();
      let top = rect.top;
      let left = rect.left;

      if (typeof externalOverlayStyler !== 'function' &&
          (rect.width < window.innerWidth / 2 || rect.height < window.innerHeight / 2)) {
        overlay.style.backgroundColor = backgroundColor;
      }

      // Adjust position if element is inside an iframe
      if (parentIframe) {
        const iframeRect = parentIframe.getBoundingClientRect();
        top += iframeRect.top;
        left += iframeRect.left;
      }

      overlay.style.top = `${top}px`;
      overlay.style.left = `${left}px`;
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;

      // Create label
      const label = document.createElement('div');
      label.className = 'eko-highlight-label';
      label.style.position = 'absolute';
      label.style.padding = '1px 4px';
      label.style.borderRadius = '4px';
      label.style.fontSize = `${Math.min(12, Math.max(8, rect.height / 2))}px`; // Responsive font size

      // Hook: if an external label styler is installed, delegate to it;
      // otherwise fall through to the default (legacy) label styling.
      const externalStyler = (window as any).__eko_styleHighlightLabel;
      if (typeof externalStyler === 'function') {
        label.textContent = index;
        externalStyler(label, element, baseColor, top, left, rect, parentIframe);
      } else {
        label.style.background = baseColor;
        label.style.color = 'white';
        label.textContent = index;

        // Calculate label position
        const labelWidth = 20; // Approximate width
        const labelHeight = 16; // Approximate height

        // Default position (top-right corner inside the box)
        let labelTop = top + 2;
        let labelLeft = left + rect.width - labelWidth - 2;

        // Adjust if box is too small
        if (rect.width < labelWidth + 4 || rect.height < labelHeight + 4) {
          // Position outside the box if it's too small
          labelTop = top - labelHeight - 2;
          labelLeft = left + rect.width - labelWidth;
        }

        // Ensure label stays within viewport
        if (labelTop < 0) labelTop = top + 2;
        if (labelLeft < 0) labelLeft = left + 2;
        if (labelLeft + labelWidth > window.innerWidth) {
          labelLeft = left + rect.width - labelWidth - 2;
        }

        label.style.top = `${labelTop}px`;
        label.style.left = `${labelLeft}px`;
      }

      // Add to container
      container.appendChild(overlay);
      container.appendChild(label);

      // Store reference for cleanup
      element.setAttribute('eko-user-highlight-id', `eko-highlight-${index}`);

      return index + 1;
    }

    // Helper function to generate XPath as a tree
    function getXPathTree(element, stopAtBoundary = true) {
      const segments = [];
      let currentElement = element;

      while (currentElement && currentElement.nodeType === Node.ELEMENT_NODE) {
        // Stop if we hit a shadow root or iframe
        if (
          stopAtBoundary &&
          (currentElement.parentNode instanceof ShadowRoot ||
            currentElement.parentNode instanceof HTMLIFrameElement)
        ) {
          break;
        }

        let index = 0;
        let sibling = currentElement.previousSibling;
        while (sibling) {
          if (
            sibling.nodeType === Node.ELEMENT_NODE &&
            sibling.nodeName === currentElement.nodeName
          ) {
            index++;
          }
          sibling = sibling.previousSibling;
        }

        const tagName = currentElement.nodeName.toLowerCase();
        const xpathIndex = index > 0 ? `[${index + 1}]` : '';
        segments.unshift(`${tagName}${xpathIndex}`);

        currentElement = currentElement.parentNode;
      }

      return segments.join('/');
    }

    // Helper function to check if element is accepted
    function isElementAccepted(element) {
      const leafElementDenyList = new Set(['svg', 'script', 'style', 'link', 'meta', 'noscript', 'template']);
      return !leafElementDenyList.has(element.tagName.toLowerCase());
    }

    // Helper function to check if element is interactive
    function isInteractiveElement(element) {
      if (!element || element.nodeType !== Node.ELEMENT_NODE) {
        return false;
      }
      // Base interactive elements and roles
      const interactiveElements = new Set([
        'a',
        'button',
        'details',
        'embed',
        'input',
        'label',
        'menu',
        'menuitem',
        'object',
        'select',
        'textarea',
        'summary',
        'option',
        'optgroup',
        'fieldset',
        'legend',
      ]);

      const interactiveRoles = new Set([
        'button',
        'menu',
        'menuitem',
        'menubar',
        'link',
        'checkbox',
        'radio',
        'slider',
        'tab',
        'tabpanel',
        'textbox',
        'combobox',
        'grid',
        'listbox',
        'listitem',
        'option',
        'progressbar',
        'scrollbar',
        'searchbox',
        'switch',
        'tree',
        'treeitem',
        'spinbutton',
        'tooltip',
        'a-button-inner',
        'a-dropdown-button',
        'click',
        'menuitemcheckbox',
        'menuitemradio',
        'a-button-text',
        'button-text',
        'button-icon',
        'button-icon-only',
        'button-text-icon-only',
        'dropdown',
        'combobox',
      ]);

      const tagName = element.tagName.toLowerCase();
      const role = element.getAttribute('role');
      const ariaRole = element.getAttribute('aria-role');
      const tabIndex = element.getAttribute('tabindex');

      // Basic role/attribute checks
      const hasInteractiveRole =
        interactiveElements.has(tagName) ||
        interactiveRoles.has(role) ||
        interactiveRoles.has(ariaRole) ||
        (tabIndex !== null && tabIndex !== '-1') ||
        element.getAttribute('data-action') === 'a-dropdown-select' ||
        element.getAttribute('data-action') === 'a-dropdown-button' ||
        element.getAttribute('contenteditable') === 'true';

      if (hasInteractiveRole) return true;

      // const eventTypes = [
      //   'click',
      //   'mousedown',
      //   'mouseup',
      //   'touchstart',
      //   'touchend',
      //   'keydown',
      //   'keyup',
      //   'focus',
      //   'blur',
      // ];

      const clickEventTypes = [
        'click',
        'mousedown',
        'mouseup',
        'touchstart',
        'touchend',
      ];

      // Filter elements that have no real event listeners at all
      if (window.getEventListeners) {
        const listeners = window.getEventListeners(element);
        const hasRealClickListeners = clickEventTypes.some((type) => listeners[type]?.length > 0);
        if (!hasRealClickListeners) {
          return false;
        }
      }

      // Check for event listeners
      const hasClickHandler =
        element.onclick !== null ||
        element.getAttribute('onclick') !== null ||
        element.hasAttribute('ng-click') ||
        element.hasAttribute('@click') ||
        element.hasAttribute('v-on:click');

      // Helper function to safely get event listeners
      function getElementEventListeners(el) {
        // List of common event types to check
        const listeners = {};

        for (const type of clickEventTypes) {
          const handler = el[`on${type}`];
          if (handler) {
            listeners[type] = [
              {
                listener: handler,
                useCapture: false,
              },
            ];
          }
        }

        return listeners;
      }

      // Check for click-related events on the element itself
      const listeners = getElementEventListeners(element);
      const hasClickListeners = clickEventTypes.some((type) => listeners[type]?.length > 0);

      // Check for ARIA properties that suggest interactivity
      const hasAriaProps =
        element.hasAttribute('aria-expanded') ||
        element.hasAttribute('aria-pressed') ||
        element.hasAttribute('aria-selected') ||
        element.hasAttribute('aria-checked');

      // Check if element is draggable
      const isDraggable = element.draggable || element.getAttribute('draggable') === 'true';

      if (hasAriaProps || hasClickHandler || hasClickListeners || isDraggable) {
        return true;
      }

      // Check if element has click-like styling
      let hasClickStyling = element.style.cursor === 'pointer' || getCachedComputedStyle(element).cursor === 'pointer';
      if (hasClickStyling) {
        let count = 0;
        let current = element.parentElement;
        while (current && current !== document.documentElement) {
          hasClickStyling = current.style.cursor === 'pointer' || getCachedComputedStyle(current).cursor === 'pointer';
          if (hasClickStyling) return false;
          current = current.parentElement;
          if (++count > 10) break;
        }
        return true;
      }

      return false;
    }

    // Helper function to check if element exists
    function isElementExist(element) {
      const style = getCachedComputedStyle(element);
      return (
        style?.visibility !== 'hidden' &&
        style?.display !== 'none'
      );
    }

    // Helper function to check if element is visible
    function isElementVisible(element) {
      if (element.offsetWidth === 0 && element.offsetHeight === 0) {
        return false;
      }
      return isElementExist(element);
    }

    // Helper function to check if element is the top element at its position
    function isTopElement(element) {
      // eko-patch hook: when an external override is installed (e.g. multi-probe
      // implementation in is_top_element_multi_probe.ts), delegate to it.
      // Keeping this hook minimal preserves easy upstream syncs.
      try {
        const override = (window as any).__ekoIsTopElementOverride;
        if (typeof override === "function") {
          return override(element);
        }
      } catch (e) { /* fall through to default */ }

      // Find the correct document context and root element
      let doc = element.ownerDocument;

      // If we're in an iframe, elements are considered top by default
      if (doc !== window.document) {
        return true;
      }

      // For shadow DOM, we need to check within its own root context
      const shadowRoot = element.getRootNode();
      if (shadowRoot instanceof ShadowRoot) {
        const rect = element.getBoundingClientRect();
        const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };

        try {
          // Use shadow root's elementFromPoint to check within shadow DOM context
          const topEl = shadowRoot.elementFromPoint(point.x, point.y);
          if (!topEl) return false;

          // Check if the element or any of its parents match our target element
          let count = 0;
          let current = topEl;
          while (current && current !== shadowRoot) {
            if (current === element) return true;
            current = current.parentElement;
            if (++count > 15) break;
          }
          return false;
        } catch (e) {
          return true; // If we can't determine, consider it visible
        }
      }

      // Regular DOM elements
      const rect = element.getBoundingClientRect();
      const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };

      try {
        const topEl = document.elementFromPoint(point.x, point.y);
        if (!topEl) return false;

        let count = 0;
        let current = topEl;
        while (current && current !== document.documentElement) {
          if (current === element) return true;
          current = current.parentElement;
          if (++count > 15) break;
        }
        return false;
      } catch (e) {
        return true;
      }
    }

    // Helper function to check if element's bounding rect is within the expanded viewport
    // (viewport ± viewportExpansion pixels). Returns true if viewportExpansion is null (disabled).
    function isInExpandedViewport(rect) {
      if (viewportExpansion === null || viewportExpansion === undefined) {
        return true; // No expansion filtering, defer to isTopElement
      }
      const vpWidth = window.innerWidth || document.documentElement.clientWidth;
      const vpHeight = window.innerHeight || document.documentElement.clientHeight;
      return (
        rect.right > -viewportExpansion &&
        rect.left < vpWidth + viewportExpansion &&
        rect.bottom > -viewportExpansion &&
        rect.top < vpHeight + viewportExpansion
      );
    }

    // Helper function to check if element is strictly within the current viewport
    function isStrictlyInViewport(rect) {
      const vpWidth = window.innerWidth || document.documentElement.clientWidth;
      const vpHeight = window.innerHeight || document.documentElement.clientHeight;
      return (
        rect.right > 0 &&
        rect.left < vpWidth &&
        rect.bottom > 0 &&
        rect.top < vpHeight
      );
    }

    // Helper function to check if text node is visible
    function isTextNodeVisible(textNode) {
      const range = document.createRange();
      range.selectNodeContents(textNode);
      const rect = range.getBoundingClientRect();

      if (rect.width === 0 || rect.height === 0) return false;

      // When viewportExpansion is set, use expanded viewport check for text nodes too
      if (viewportExpansion !== null && viewportExpansion !== undefined) {
        return (
          isInExpandedViewport(rect) &&
          textNode.parentElement?.checkVisibility({
            checkOpacity: true,
            checkVisibilityCSS: true,
          })
        );
      }

      // Default eko behavior: strict viewport check
      return (
        rect.top >= 0 &&
        rect.top <= window.innerHeight &&
        textNode.parentElement?.checkVisibility({
          checkOpacity: true,
          checkVisibilityCSS: true,
        })
      );
    }

    // Function to traverse the DOM and create nested JSON
    function buildDomTree(node, parentIframe = null) {
      if (!node || duplicates.has(node)) {
        return null;
      }
      duplicates.add(node);

      // Special case for text nodes
      if (node.nodeType === Node.TEXT_NODE) {
        const textContent = node.textContent.trim();
        if (textContent && isTextNodeVisible(node)) {
          return {
            type: 'TEXT_NODE',
            text: textContent,
            isVisible: true,
          };
        }
        return null;
      }

      // Check if element is accepted
      if (node.nodeType === Node.ELEMENT_NODE && !isElementAccepted(node)) {
        return null;
      }

      const nodeData = {
        tagName: node.tagName ? node.tagName.toLowerCase() : null,
        attributes: {},
        xpath: node.nodeType === Node.ELEMENT_NODE ? getXPathTree(node, true) : null,
        children: [],
      };

      // Copy all attributes if the node is an element
      if (node.nodeType === Node.ELEMENT_NODE && node.attributes) {
        // Use getAttributeNames() instead of directly iterating attributes
        const attributeNames = node.getAttributeNames?.() || [];
        for (const name of attributeNames) {
          nodeData.attributes[name] = node.getAttribute(name);
        }
      }

      if (node.nodeType === Node.ELEMENT_NODE) {
        const isInteractive = isInteractiveElement(node);
        const isVisible = isElementVisible(node);
        const isTop = isTopElement(node);

        nodeData.isInteractive = isInteractive;
        nodeData.isVisible = isVisible;
        nodeData.isTopElement = isTop;

        // For Shadow DOM elements, use more lenient criteria
        const isInShadowDOM = node.getRootNode() instanceof ShadowRoot;

        let shouldHighlight;
        if (viewportExpansion !== null && viewportExpansion !== undefined) {
          // Browser-use style: use expanded viewport. For elements outside the strict
          // viewport but within the expansion zone, skip the isTopElement check since
          // elementFromPoint() cannot test off-screen coordinates.
          const rect = node.getBoundingClientRect();
          const inExpandedVP = isInExpandedViewport(rect);
          const inStrictVP = isStrictlyInViewport(rect);
          if (inStrictVP) {
            // In viewport: require all checks (same as default eko behavior)
            shouldHighlight = isInteractive && isVisible && (isTop || isInShadowDOM);
          } else {
            // In expanded zone but outside viewport: skip isTopElement (can't use elementFromPoint)
            shouldHighlight = isInteractive && isVisible && inExpandedVP;
          }
        } else {
          // Default eko behavior: strict viewport via elementFromPoint
          shouldHighlight = isInteractive && isVisible && (isTop || isInShadowDOM);
        }

        // Highlight if element meets all criteria and highlighting is enabled
        if (shouldHighlight) {
          nodeData.highlightIndex = highlightIndex++;
          window.clickable_elements[nodeData.highlightIndex] = node;
          if (markHighlightElements) {
            highlightElement(node, nodeData.highlightIndex, parentIframe);
          }
        }
      }

      // Only add iframeContext if we're inside an iframe
      // if (parentIframe) {
      //     nodeData.iframeContext = `iframe[src="${parentIframe.src || ''}"]`;
      // }

      // Only add shadowRoot field if it exists
      if (node.shadowRoot) {
        nodeData.shadowRoot = true;
      }

      // Handle shadow DOM
      if (node.shadowRoot) {
        const shadowChildren = Array.from(node.shadowRoot.children).map((child) =>
          buildDomTree(child, parentIframe)
        ).filter(child => child !== null);
        nodeData.children.push(...shadowChildren);
      }

      // Handle iframes
      if (node.tagName === 'IFRAME') {
        try {
          const iframeDoc = node.contentDocument || node.contentWindow.document;
          if (iframeDoc) {
            const iframeChildren = Array.from(iframeDoc.body.childNodes).map((child) =>
              buildDomTree(child, node)
            ).filter(child => child !== null);
            nodeData.children.push(...iframeChildren);
          }
        } catch (e) {
          console.warn('Unable to access iframe:', node);
        }
      } else {
        if (isElementExist(node)) {
          // Use childNodes instead of children to include text nodes
          const children = Array.from(node.childNodes).map((child) =>
            buildDomTree(child, parentIframe)
          ).filter(child => child !== null);
          nodeData.children.push(...children);
        }
      }

      return nodeData;
    }
    return buildDomTree(document.body);
  }

  window.get_clickable_elements = get_clickable_elements;
  window.get_highlight_element = get_highlight_element;
  window.resolve_element_by_selector = resolve_element_by_selector;
  window.remove_highlight = remove_highlight;
}