/**
 * Browser utility functions for Chrome extension
 */

/**
 * Get the current active tab's URL.
 * Tries the active tab in the current window first, then falls back to the last focused window.
 * @returns The current page URL, or undefined if unavailable
 */
export async function getCurrentPageUrl(): Promise<string | undefined> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length > 0 && tabs[0].url) {
      return tabs[0].url;
    }
    // Fallback: try last focused window
    const window = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (window?.id) {
      const windowTabs = await chrome.tabs.query({ windowId: window.id, active: true });
      if (windowTabs.length > 0 && windowTabs[0].url) {
        return windowTabs[0].url;
      }
    }
  } catch (e) {
    // Ignore errors, URL is optional
  }
  return undefined;
}
