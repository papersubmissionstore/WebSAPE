/**
 * Page State Detection Utilities
 * 
 * Shared logic for detecting page state changes (URL navigation, tab changes, DOM changes)
 * after browser operations like click_element and input_text.
 */

import { sleep } from "../../common/utils";
import { DomState, DomChanges, detectDomChanges } from "./dom_ckpt";

/**
 * Page state change result type
 */
export interface PageStateChange {
  type: 'none' | 'new_tab_opened' | 'tab_closed' | 'tab_switched' | 'capture_timeout';
  details: string;
  beforeUrl?: string;
  afterUrl?: string;
  beforeTabCount?: number;
  afterTabCount?: number;
  beforeTabId?: number;
  afterTabId?: number;
  newTabId?: number;
  closedTabId?: number;
  currentTabId?: number;
  /** DOM changes per tab (tabId -> DomChanges) */
  domChanges: Record<number, DomChanges>;
}

/**
 * State before an operation
 */
export interface BeforeState {
  currentPage: { url: string; title?: string; tabId?: number };
  allTabs: Array<{ tabId: number; url: string; title: string }>;
}

/**
 * Configuration for page state polling
 */
export interface PollingConfig {
  maxWaitTime?: number;  // Maximum time to wait in ms (default: 5000)
  pollInterval?: number; // Interval between polls in ms (default: 200)
  postNavigationDelay?: number; // Delay after navigation detected (default: 500)
}

const DEFAULT_POLLING_CONFIG: Required<PollingConfig> = {
  maxWaitTime: 5000,
  pollInterval: 200,
  postNavigationDelay: 500,
};

/**
 * Result from polling for page state changes
 */
export interface PollResult {
  navigationDetected: boolean;
  newTabDetected: boolean;
  tabClosedDetected: boolean;
  tabSwitchDetected: boolean;
  afterUrl: string;
  afterTabCount: number;
  afterTabId?: number;
  afterState: BeforeState | null;
}

/**
 * Poll for URL or tab changes after an operation.
 * 
 * @param beforeState - State captured before the operation
 * @param getCurrentPage - Function to get current page info
 * @param getAllTabs - Function to get all tabs
 * @param logPrefix - Prefix for log messages (e.g., '[click_element]' or '[input_text]')
 * @param config - Polling configuration
 * @returns PollResult with detection flags and final state
 */
export async function pollForPageStateChanges(
  beforeState: BeforeState,
  getCurrentPage: () => Promise<{ url: string; title?: string; tabId?: number }>,
  getAllTabs: () => Promise<Array<{ tabId: number; url: string; title: string }>>,
  logPrefix: string,
  config: PollingConfig = {}
): Promise<PollResult> {
  const { maxWaitTime, pollInterval, postNavigationDelay } = { ...DEFAULT_POLLING_CONFIG, ...config };
  
  const beforeUrl = beforeState.currentPage.url;
  const beforeTabCount = beforeState.allTabs.length;
  const beforeTabId = beforeState.currentPage.tabId;
  
  let navigationDetected = false;
  let newTabDetected = false;
  let tabClosedDetected = false;
  let tabSwitchDetected = false;
  let afterUrl = beforeUrl;
  let afterTabCount = beforeTabCount;
  let afterTabId = beforeTabId;
  let afterState: BeforeState | null = null;
  
  // First, do an immediate check
  try {
    const [currentPage, allTabs] = await Promise.all([
      getCurrentPage(),
      getAllTabs()
    ]);
    afterState = { currentPage, allTabs };
    afterUrl = currentPage.url;
    afterTabCount = allTabs.length;
    afterTabId = currentPage.tabId;
    
    console.log(`${logPrefix} Immediate check - beforeUrl:`, beforeUrl, 'currentUrl:', afterUrl, 'beforeTabs:', beforeTabCount, 'afterTabs:', afterTabCount);
    
    if (beforeUrl !== afterUrl) {
      navigationDetected = true;
      console.log(`${logPrefix} Navigation already completed`);
    } else if (afterTabCount > beforeTabCount) {
      newTabDetected = true;
      console.log(`${logPrefix} New tab opened`);
    } else if (afterTabCount < beforeTabCount) {
      tabClosedDetected = true;
      console.log(`${logPrefix} Tab closed`);
    } else if (beforeTabId !== afterTabId) {
      tabSwitchDetected = true;
      console.log(`${logPrefix} Tab switched`);
    }
  } catch (e) {
    console.log(`${logPrefix} Error getting current page:`, e);
  }
  
  // If no immediate change detected, poll for changes
  if (!navigationDetected && !newTabDetected && !tabClosedDetected && !tabSwitchDetected) {
    console.log(`${logPrefix} No immediate change detected, polling for URL/tab changes...`);
    const startTime = Date.now();
    let pollCount = 0;
    
    while (Date.now() - startTime < maxWaitTime) {
      await sleep(pollInterval);
      pollCount++;
      
      try {
        const [currentPage, allTabs] = await Promise.all([
          getCurrentPage(),
          getAllTabs()
        ]);
        afterState = { currentPage, allTabs };
        afterUrl = currentPage.url;
        afterTabCount = allTabs.length;
        afterTabId = currentPage.tabId;
        
        console.log(`${logPrefix} Poll #${pollCount}: current URL = ${afterUrl}, tabs = ${afterTabCount}`);
        
        if (beforeUrl !== afterUrl) {
          navigationDetected = true;
          console.log(`${logPrefix} Navigation detected: URL changed from`, beforeUrl, 'to', afterUrl);
          // Wait a bit more for page to fully load after URL change
          await sleep(postNavigationDelay);
          // Get the final state after page load
          const [finalPage, finalTabs] = await Promise.all([
            getCurrentPage(),
            getAllTabs()
          ]);
          afterState = { currentPage: finalPage, allTabs: finalTabs };
          afterUrl = finalPage.url;
          afterTabCount = finalTabs.length;
          afterTabId = finalPage.tabId;
          break;
        } else if (afterTabCount > beforeTabCount) {
          newTabDetected = true;
          console.log(`${logPrefix} New tab detected during polling`);
          break;
        } else if (afterTabCount < beforeTabCount) {
          tabClosedDetected = true;
          console.log(`${logPrefix} Tab closed detected during polling`);
          break;
        } else if (beforeTabId !== afterTabId) {
          tabSwitchDetected = true;
          console.log(`${logPrefix} Tab switch detected during polling`);
          break;
        }
      } catch (e) {
        // Page might be in transition, continue polling
        console.log(`${logPrefix} Poll #${pollCount}: Page in transition, continuing to poll...`, e);
      }
    }
    
    console.log(`${logPrefix} Polling finished after ${pollCount} polls. navigation=${navigationDetected}, newTab=${newTabDetected}, tabClosed=${tabClosedDetected}, tabSwitch=${tabSwitchDetected}`);
  }
  
  return {
    navigationDetected,
    newTabDetected,
    tabClosedDetected,
    tabSwitchDetected,
    afterUrl,
    afterTabCount,
    afterTabId,
    afterState,
  };
}

/**
 * Build a PageStateChange object based on detection results.
 * 
 * @param pollResult - Result from pollForPageStateChanges
 * @param beforeState - State before the operation
 * @param beforeDomState - DOM state before the operation, per tab (tabId -> DomState)
 * @param afterDomState - DOM state after the operation, per tab (tabId -> DomState)
 * @returns PageStateChange object
 */
export function buildPageStateChange(
  pollResult: PollResult,
  beforeState: BeforeState,
  beforeDomState: Record<number, DomState> | null,
  afterDomState: Record<number, DomState> | null
): PageStateChange {
  const {
    navigationDetected,
    newTabDetected,
    tabClosedDetected,
    tabSwitchDetected,
    afterUrl,
    afterTabCount,
    afterTabId,
    afterState,
  } = pollResult;
  
  const beforeUrl = beforeState.currentPage.url;
  const beforeTabCount = beforeState.allTabs.length;
  const beforeTabId = beforeState.currentPage.tabId;
  
  // Compute DOM changes upfront so we can include them in all change types
  let allDomChanges: Record<number, DomChanges> | undefined;
  if (beforeDomState && afterDomState) {
    // We have both before and after - compute actual diff
    const changes: Record<number, DomChanges> = {};
    
    // Check each tab that has both before and after states
    for (const tabIdStr of Object.keys(afterDomState)) {
      const tabId = parseInt(tabIdStr, 10);
      const beforeTabState = beforeDomState[tabId];
      const afterTabState = afterDomState[tabId];
      
      if (beforeTabState && afterTabState) {
        const domResult = detectDomChanges(beforeTabState, afterTabState);
        if (domResult.hasSignificantChange) {
          changes[tabId] = domResult.changes;
        }
      }
    }
    
    if (Object.keys(changes).length > 0) {
      allDomChanges = changes;
    }
  } else if (afterDomState && !beforeDomState) {
    // Only have after state (e.g., navigate_to, go_back, switch_tab)
    // Create synthetic domChanges representing current DOM state with changedElements
    const changes: Record<number, DomChanges> = {};
    
    for (const tabIdStr of Object.keys(afterDomState)) {
      const tabId = parseInt(tabIdStr, 10);
      const afterTabState = afterDomState[tabId];
      
      if (afterTabState) {
        // Build changedElements from the DOM state - treat all as "added"
        const changedElements: Array<{ changeType: 'added' | 'removed' | 'modified'; selector: string; description: string }> = [];
        const elementPaths = Object.keys(afterTabState.elements);
        
        for (const selector of elementPaths) {
          changedElements.push({
            changeType: 'added',
            selector,
            description: `Added: ${selector}`
          });
        }
        
        // Use actual element count (unique paths), not totalCount which may include duplicates
        changes[tabId] = {
          hasChange: true,
          addedCount: elementPaths.length,
          removedCount: 0,
          modifiedCount: 0,
          changedElements,
          summary: `Current page has ${afterTabState.totalCount} DOM elements.`
        };
      }
    }
    
    if (Object.keys(changes).length > 0) {
      allDomChanges = changes;
    }
  }
  
  if (newTabDetected && afterState) {
    // New tab(s) opened
    const newTabs = afterState.allTabs.filter(
      at => !beforeState.allTabs.some(bt => bt.tabId === at.tabId && bt.url === at.url)
    );
    const newTabId = newTabs.length > 0 ? newTabs[newTabs.length - 1].tabId : afterTabCount - 1;
    return {
      type: 'new_tab_opened',
      details: `New tab opened. Tab count: ${beforeTabCount} -> ${afterTabCount}`,
      beforeUrl,
      afterUrl,
      beforeTabCount,
      afterTabCount,
      newTabId,
      currentTabId: afterTabId,
      domChanges: allDomChanges || {}
    };
  }
  
  if (tabClosedDetected && afterState) {
    // Tab(s) closed
    const closedTabs = beforeState.allTabs.filter(
      bt => !afterState.allTabs.some(at => at.tabId === bt.tabId)
    );
    const closedTabId = closedTabs.length > 0 ? closedTabs[0].tabId : undefined;
    return {
      type: 'tab_closed',
      details: `Tab closed. Tab count: ${beforeTabCount} -> ${afterTabCount}`,
      beforeUrl,
      afterUrl,
      beforeTabCount,
      afterTabCount,
      closedTabId,
      currentTabId: afterTabId,
      domChanges: allDomChanges || {}
    };
  }
  
  if (tabSwitchDetected) {
    return {
      type: 'tab_switched',
      details: `Active tab switched from ${beforeTabId} to ${afterTabId}`,
      beforeUrl,
      afterUrl,
      beforeTabCount,
      afterTabCount,
      currentTabId: afterTabId,
      domChanges: allDomChanges || {}
    };
  }
  
  if (navigationDetected) {
    return {
      type: 'none',
      details: `URL changed. Check beforeUrl/afterUrl for details.`,
      beforeUrl,
      afterUrl,
      beforeTabCount,
      afterTabCount,
      currentTabId: afterTabId,
      domChanges: allDomChanges || {}
    };
  }
  
  // Check for DOM-only changes (no URL/tab changes)
  if (allDomChanges) {
    const allDescriptions: string[] = [];
    for (const [tabIdStr, changes] of Object.entries(allDomChanges)) {
      const tabId = parseInt(tabIdStr, 10);
      if (changes.changedElements) {
        allDescriptions.push(...changes.changedElements.map(e => `[Tab ${tabId}] ${e.description}`));
      }
    }
    return {
      type: 'none',
      details: `DOM changed: ${allDescriptions.slice(0, 10).join(', ') || 'Elements modified'}. Check domChanges field for details.`,
      beforeUrl,
      afterUrl,
      beforeTabCount,
      afterTabCount,
      currentTabId: afterTabId,
      domChanges: allDomChanges
    };
  }
  
  // No changes detected
  return {
    type: 'none',
    details: 'No page state change detected',
    beforeUrl,
    afterUrl,
    beforeTabCount,
    afterTabCount,
    currentTabId: afterTabId,
    domChanges: {}
  };
}

/**
 * Configuration for timeout-protected operations
 */
export interface CaptureConfig {
  timeout?: number;  // Timeout in milliseconds (default: 5000)
}

const DEFAULT_CAPTURE_TIMEOUT = 5000;

/**
 * Result from a timeout-protected capture operation
 */
export interface CaptureResult<T> {
  success: boolean;
  data: T | null;
  timedOut: boolean;
  error?: Error;
}

/**
 * Execute a capture operation with timeout protection.
 * 
 * This utility prevents operations from hanging forever when a dialog
 * (e.g., beforeunload "Leave site?" confirmation) blocks the page.
 * 
 * @param operation - The async operation to execute
 * @param config - Configuration with optional timeout
 * @returns CaptureResult with success/timeout status and data
 */
export async function captureWithTimeout<T>(
  operation: () => Promise<T>,
  config: CaptureConfig = {}
): Promise<CaptureResult<T>> {
  const timeout = config.timeout ?? DEFAULT_CAPTURE_TIMEOUT;
  
  try {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Capture timeout')), timeout)
    );
    
    const data = await Promise.race([operation(), timeoutPromise]);
    
    return {
      success: true,
      data,
      timedOut: false
    };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    const timedOut = error.message === 'Capture timeout';
    
    return {
      success: false,
      data: null,
      timedOut,
      error: timedOut ? undefined : error
    };
  }
}

/**
 * Capture page state (current page + all tabs) with timeout protection.
 * 
 * @param getCurrentPage - Function to get current page info
 * @param getAllTabs - Function to get all tabs
 * @param config - Configuration with optional timeout
 * @returns CaptureResult with BeforeState data
 */
export async function capturePageStateWithTimeout(
  getCurrentPage: () => Promise<{ url: string; title?: string; tabId?: number }>,
  getAllTabs: () => Promise<Array<{ tabId: number; url: string; title: string }>>,
  config: CaptureConfig = {}
): Promise<CaptureResult<BeforeState>> {
  return captureWithTimeout(async () => {
    const [currentPage, allTabs] = await Promise.all([
      getCurrentPage(),
      getAllTabs()
    ]);
    return { currentPage, allTabs };
  }, config);
}

/**
 * Build a PageStateChange for capture timeout scenario.
 * 
 * @param beforeState - State before the operation (if captured)
 * @param action - The action that triggered the timeout (e.g., 'go_back', 'switch_tab')
 * @returns PageStateChange with capture_timeout type
 */
export function buildCaptureTimeoutChange(
  beforeState: BeforeState | null,
  action: string
): PageStateChange {
  return {
    type: 'capture_timeout',
    details: `Timed out while capturing page state after ${action}. This may indicate a dialog is blocking the page (e.g., "Leave site?" confirmation), or the page is unresponsive. If a dialog is visible, dismiss it before proceeding.`,
    beforeUrl: beforeState?.currentPage.url,
    beforeTabId: beforeState?.currentPage.tabId,
    beforeTabCount: beforeState?.allTabs.length,
    domChanges: {}
  };
}

/**
 * Configuration for unified page state detection after an action
 */
export interface DetectPageStateChangeConfig {
  /** Skip polling and use simple before/after comparison (for actions like go_back, switch_tab) */
  skipPolling?: boolean;
  /** Delay before capturing state after action (default: 300ms) */
  postActionDelay?: number;
  /** Log prefix for debugging (e.g., '[click_element]') */
  logPrefix?: string;
  /** Polling configuration (only used if skipPolling is false) */
  pollingConfig?: PollingConfig;
  /** Capture timeout in ms (default: 5000) */
  captureTimeout?: number;
}

/**
 * Result from unified page state detection
 */
export interface DetectPageStateChangeResult {
  /** The page state change detected */
  pageStateChange: PageStateChange;
  /** State captured after the action (may be null if timed out) */
  afterState: BeforeState | null;
  /** DOM state captured after the action, per tab (tabId -> DomState) */
  afterDomState: Record<number, DomState> | null;
  /** Whether the capture operation timed out */
  captureTimedOut: boolean;
}

/**
 * Unified function to detect page state changes after any browser action.
 * 
 * This is the recommended way for all browser tools to detect state changes.
 * It handles:
 * - URL navigation detection
 * - New tab opened detection
 * - Tab closed detection
 * - Tab switch detection
 * - DOM change detection
 * - Capture timeout protection
 * 
 * @param beforeState - State captured before the action
 * @param beforeDomState - DOM state captured before the action, per tab (tabId -> DomState)
 * @param getCurrentPage - Function to get current page info
 * @param getAllTabs - Function to get all tabs
 * @param executeDomCapture - Function to capture DOM state (optional)
 * @param actionName - Name of the action for logging/error messages
 * @param config - Configuration options
 * @returns DetectPageStateChangeResult with pageStateChange and capture status
 */
export async function detectPageStateChange(
  beforeState: BeforeState | null,
  beforeDomState: Record<number, DomState> | null,
  getCurrentPage: () => Promise<{ url: string; title?: string; tabId?: number }>,
  getAllTabs: () => Promise<Array<{ tabId: number; url: string; title: string }>>,
  executeDomCapture: ((tabId: number) => Promise<DomState>) | null,
  actionName: string,
  config: DetectPageStateChangeConfig = {}
): Promise<DetectPageStateChangeResult> {
  const {
    skipPolling = false,
    postActionDelay = 300,
    logPrefix = `[${actionName}]`,
    pollingConfig = {},
    captureTimeout = 5000
  } = config;

  // Default result for when we don't have before state
  if (!beforeState) {
    console.log(`${logPrefix} beforeState is null, capturing after state for domChanges...`);
    // Try to capture current state
    const afterCapture = await capturePageStateWithTimeout(
      getCurrentPage,
      getAllTabs,
      { timeout: captureTimeout }
    );
    
    console.log(`${logPrefix} afterCapture result:`, {
      hasData: !!afterCapture.data,
      timedOut: afterCapture.timedOut,
      tabId: afterCapture.data?.currentPage?.tabId,
      hasExecuteDomCapture: !!executeDomCapture
    });
    
    // Capture DOM state if possible
    let afterDomStateForUnavailable: Record<number, DomState> | null = null;
    let domChangesForUnavailable: Record<number, DomChanges> | undefined;
    if (executeDomCapture && afterCapture.data) {
      try {
        // Use tabId if available. The extension should provide real tabId via chrome.tabs API.
        // Fallback to 0 only for base implementation (eko-nodejs) which doesn't have tabId.
        const currentTabId = afterCapture.data.currentPage.tabId ?? 0;
        console.log(`${logPrefix} Capturing DOM state for tab ${currentTabId}...`);
        const domState = await executeDomCapture(currentTabId);
        console.log(`${logPrefix} DOM state captured:`, {
          totalCount: domState?.totalCount,
          hasData: !!domState
        });
        afterDomStateForUnavailable = { [currentTabId]: domState };
        
        // When before state is not available, treat all current elements as "added"
        // Build changedElements from the DOM state
        const changedElements: Array<{ changeType: 'added' | 'removed' | 'modified'; selector: string; description: string }> = [];
        const elementPaths = Object.keys(domState.elements);
        
        for (const selector of elementPaths) {
          changedElements.push({
            changeType: 'added',
            selector,
            description: `Added: ${selector}`
          });
        }
        
        // Use actual element count (unique paths), not totalCount which may include duplicates
        const addedCount = elementPaths.length;
        domChangesForUnavailable = {
          [currentTabId]: {
            hasChange: true,
            addedCount,
            removedCount: 0,
            modifiedCount: 0,
            changedElements,
            summary: `New page loaded with ${addedCount} DOM elements.`
          }
        };
        console.log(`${logPrefix} domChangesForUnavailable created with ${changedElements.length} changedElements`);
      } catch (e) {
        console.log(`${logPrefix} Could not capture DOM state when before state unavailable:`, e);
      }
    }
    
    return {
      pageStateChange: {
        type: 'none',
        details: 'Could not compare state - before state was not captured. Check if beforeUrl is undefined.',
        afterUrl: afterCapture.data?.currentPage.url,
        afterTabId: afterCapture.data?.currentPage.tabId,
        afterTabCount: afterCapture.data?.allTabs.length,
        domChanges: domChangesForUnavailable || {}
      },
      afterState: afterCapture.data,
      afterDomState: afterDomStateForUnavailable,
      captureTimedOut: afterCapture.timedOut
    };
  }

  // Wait for action effects to settle
  await sleep(postActionDelay);

  let afterState: BeforeState | null = null;
  let afterDomState: Record<number, DomState> | null = null;
  let captureTimedOut = false;
  let pageStateChange: PageStateChange;

  if (skipPolling) {
    // Simple before/after comparison (for go_back, switch_tab, etc.)
    const afterCapture = await capturePageStateWithTimeout(
      getCurrentPage,
      getAllTabs,
      { timeout: captureTimeout }
    );
    
    captureTimedOut = afterCapture.timedOut;
    afterState = afterCapture.data;
    
    if (captureTimedOut) {
      pageStateChange = buildCaptureTimeoutChange(beforeState, actionName);
    } else if (afterState) {
      // Build poll result manually for buildPageStateChange compatibility
      const pollResult: PollResult = {
        navigationDetected: beforeState.currentPage.url !== afterState.currentPage.url,
        newTabDetected: afterState.allTabs.length > beforeState.allTabs.length,
        tabClosedDetected: afterState.allTabs.length < beforeState.allTabs.length,
        tabSwitchDetected: beforeState.currentPage.tabId !== afterState.currentPage.tabId && 
                          beforeState.currentPage.url === afterState.currentPage.url &&
                          afterState.allTabs.length === beforeState.allTabs.length,
        afterUrl: afterState.currentPage.url,
        afterTabCount: afterState.allTabs.length,
        afterTabId: afterState.currentPage.tabId,
        afterState
      };
      
      // Capture DOM state for diff detection
      if (executeDomCapture) {
        try {
          const hasTabChange = pollResult.newTabDetected || pollResult.tabClosedDetected || pollResult.tabSwitchDetected;
          
          if (hasTabChange) {
            // Tab changes detected - capture DOM for all relevant tabs
            const tabsToCapture = new Set<number>();
            
            // Add the previous active tab (if it still exists)
            const beforeTabId = beforeState.currentPage.tabId ?? 0;
            if (afterState.allTabs.some(t => t.tabId === beforeTabId)) {
              tabsToCapture.add(beforeTabId);
            }
            
            // Add the current active tab
            const afterTabId = afterState.currentPage.tabId ?? 0;
            tabsToCapture.add(afterTabId);
            
            // Add any new tabs
            if (pollResult.newTabDetected) {
              const newTabs = afterState.allTabs.filter(
                at => !beforeState.allTabs.some(bt => bt.tabId === at.tabId)
              );
              for (const newTab of newTabs) {
                tabsToCapture.add(newTab.tabId);
              }
            }
            
            // Capture DOM for all relevant tabs
            afterDomState = {};
            for (const tabId of tabsToCapture) {
              try {
                const domState = await executeDomCapture(tabId);
                afterDomState[tabId] = domState;
                console.log(`${logPrefix} After DOM state captured for tab ${tabId}`);
              } catch (e) {
                console.log(`${logPrefix} Could not capture after DOM state for tab ${tabId}:`, e);
              }
            }
          } else {
            // No tab changes - capture current tab DOM state
            // This includes both navigation and no-change cases
            const currentTabId = afterState.currentPage.tabId ?? 0;
            const domState = await executeDomCapture(currentTabId);
            afterDomState = { [currentTabId]: domState };
          }
        } catch (e) {
          console.log(`${logPrefix} Could not capture after DOM state:`, e);
        }
      }
      
      pageStateChange = buildPageStateChange(pollResult, beforeState, beforeDomState, afterDomState);
    } else {
      pageStateChange = {
        type: 'none',
        details: 'Could not capture state after action.',
        domChanges: {}
      };
    }
  } else {
    // Full polling approach (for click_element, input_text, etc.)
    const pollResult = await pollForPageStateChanges(
      beforeState,
      getCurrentPage,
      getAllTabs,
      logPrefix,
      pollingConfig
    );
    
    afterState = pollResult.afterState;
    
    // Capture DOM state after action
    if (executeDomCapture && afterState) {
      try {
        const hasTabChange = pollResult.newTabDetected || pollResult.tabClosedDetected || pollResult.tabSwitchDetected;
        
        if (hasTabChange) {
          // Tab changes detected - capture DOM for all relevant tabs
          const tabsToCapture = new Set<number>();
          
          // Add the previous active tab (if it still exists)
          const beforeTabId = beforeState.currentPage.tabId ?? 0;
          if (afterState.allTabs.some(t => t.tabId === beforeTabId)) {
            tabsToCapture.add(beforeTabId);
          }
          
          // Add the current active tab
          const afterTabId = pollResult.afterTabId ?? 0;
          tabsToCapture.add(afterTabId);
          
          // Add any new tabs
          if (pollResult.newTabDetected) {
            const newTabs = afterState.allTabs.filter(
              at => !beforeState.allTabs.some(bt => bt.tabId === at.tabId)
            );
            for (const newTab of newTabs) {
              tabsToCapture.add(newTab.tabId);
            }
          }
          
          // Capture DOM for all relevant tabs
          afterDomState = {};
          for (const tabId of tabsToCapture) {
            try {
              const domState = await executeDomCapture(tabId);
              afterDomState[tabId] = domState;
              console.log(`${logPrefix} After DOM state captured for tab ${tabId}`);
            } catch (e) {
              console.log(`${logPrefix} Could not capture after DOM state for tab ${tabId}:`, e);
            }
          }
        } else {
          // No tab changes - capture current tab DOM state
          // This includes both navigation and no-change cases
          const currentTabId = pollResult.afterTabId ?? 0;
          const domState = await executeDomCapture(currentTabId);
          afterDomState = { [currentTabId]: domState };
          console.log(`${logPrefix} After DOM state captured for tab ${currentTabId}`);
        }
      } catch (e) {
        console.log(`${logPrefix} Could not capture after DOM state:`, e);
      }
    }
    
    pageStateChange = buildPageStateChange(pollResult, beforeState, beforeDomState, afterDomState);
  }

  return {
    pageStateChange,
    afterState,
    afterDomState,
    captureTimedOut
  };
}

/**
 * Standard browser tool result structure.
 * All browser tools should return results conforming to this interface.
 */
export interface BrowserToolResult {
  /** Whether the action was successful */
  success: boolean;
  /** The action that was performed */
  action: string;
  /** Page state change information (navigation, tab changes, DOM changes, etc.) */
  pageStateChange: PageStateChange;
  /** Interactive elements on the current page */
  interactive_elements: Array<any>;
  /** Number of elements captured */
  _elementCount?: number;
  /** Warning message if something went wrong but action still succeeded */
  _warning?: string;
  /** Allow additional tool-specific fields */
  [key: string]: any;
}

/**
 * Options for building a browser tool result
 */
export interface BuildResultOptions {
  /** The action name (e.g., 'navigate_to', 'click', 'go_back') */
  action: string;
  /** Page state change detected after the action */
  pageStateChange?: PageStateChange;
  /** Interactive elements captured from the page */
  interactive_elements: Array<any>;
  /** Whether the capture operation timed out */
  captureTimedOut?: boolean;
  /** Warning message */
  warning?: string;
  /** Additional fields to include in the result */
  extra?: Record<string, any>;
}

/**
 * Build a standardized browser tool result.
 * Ensures consistent structure across all browser tools.
 * 
 * @param options - Options for building the result
 * @returns Standardized BrowserToolResult
 */
export function buildBrowserToolResult(options: BuildResultOptions): BrowserToolResult {
  const {
    action,
    pageStateChange = { type: 'none', details: 'No page state change detected', domChanges: {} },
    interactive_elements,
    captureTimedOut = false,
    warning,
    extra = {}
  } = options;

  const result: BrowserToolResult = {
    success: true,
    action,
    pageStateChange,
    interactive_elements,
    _elementCount: interactive_elements.length,
    ...extra
  };

  // Add warning if present
  if (warning) {
    result._warning = warning;
  }

  // Add warning if elements are empty due to timeout or capture failure
  if (interactive_elements.length === 0 && captureTimedOut) {
    result._warning = warning || "Timed out while capturing page elements. A dialog may be blocking the page.";
  }

  return result;
}
