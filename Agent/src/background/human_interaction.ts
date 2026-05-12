/**
 * Human Interaction Handler
 * 
 * This module manages human interaction requests from the agent and routes them
 * to the extension sidebar UI instead of blocking the website with window.confirm/prompt.
 * 
 * Note: Pending interactions are persisted to chrome.storage.local to survive
 * service worker restarts (Manifest V3). The resolve functions are stored in memory.
 */

export interface HumanInteractionRequest {
  id: string;
  type: 'confirm' | 'input' | 'select' | 'help';
  prompt: string;
  helpType?: 'request_login' | 'request_assistance';
  options?: string[];  // For select type
  multiple?: boolean;  // For select type
  timestamp: number;
}

export interface HumanInteractionResponse {
  id: string;
  confirmed?: boolean;  // For confirm/help types
  input?: string;       // For input type
  selections?: string[]; // For select type
  cancelled?: boolean;  // If user cancelled/dismissed
}

const STORAGE_KEY = 'pendingHumanInteractions';

// Store pending interactions with their resolve functions (in-memory)
const pendingInteractions: Map<string, {
  request: HumanInteractionRequest;
  resolve: (response: HumanInteractionResponse) => void;
}> = new Map();

// Store resolve functions separately for interactions restored from storage
const restoredResolvers: Map<string, (response: HumanInteractionResponse) => void> = new Map();

// Keep-alive interval to prevent service worker termination during user interaction
let keepAliveInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start keep-alive mechanism to prevent service worker from being terminated
 * while waiting for user interaction. Chrome terminates idle service workers after ~30s.
 */
function startKeepAlive(): void {
  if (keepAliveInterval) return; // Already running
  
  console.log('[HumanInteraction] Starting keep-alive to prevent SW termination');
  
  // Ping every 20 seconds to keep service worker alive
  keepAliveInterval = setInterval(() => {
    // Accessing chrome.storage keeps the service worker alive
    chrome.storage.local.get(['_keepAlive'], () => {
      console.log('[HumanInteraction] Keep-alive ping at', new Date().toISOString());
    });
  }, 20000);
}

/**
 * Stop keep-alive mechanism when no longer needed
 */
function stopKeepAlive(): void {
  if (keepAliveInterval) {
    console.log('[HumanInteraction] Stopping keep-alive');
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

/**
 * Update keep-alive state based on pending interactions
 */
function updateKeepAlive(): void {
  if (pendingInteractions.size > 0 || restoredResolvers.size > 0) {
    startKeepAlive();
  } else {
    stopKeepAlive();
  }
}

/**
 * Persist pending interaction requests to chrome.storage.local
 * This allows the sidebar to retrieve pending requests even after service worker restart
 */
async function persistPendingInteractions(): Promise<void> {
  const requests = Array.from(pendingInteractions.values()).map(p => p.request);
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: requests });
  } catch (err) {
    console.error('[HumanInteraction] Failed to persist pending interactions:', err);
  }
}

/**
 * Load pending interactions from storage (requests only, not resolvers)
 * Called on service worker startup to know what interactions are still pending
 */
async function loadPendingInteractionsFromStorage(): Promise<HumanInteractionRequest[]> {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEY]);
    return result[STORAGE_KEY] || [];
  } catch (err) {
    console.error('[HumanInteraction] Failed to load pending interactions:', err);
    return [];
  }
}

/**
 * Clear persisted pending interactions
 */
async function clearPersistedInteractions(): Promise<void> {
  try {
    await chrome.storage.local.remove(STORAGE_KEY);
  } catch (err) {
    console.error('[HumanInteraction] Failed to clear persisted interactions:', err);
  }
}

/**
 * Generate a unique ID for each interaction request
 */
function generateId(): string {
  return `hi_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Send a human interaction request to the sidebar UI
 */
function sendInteractionToUI(request: HumanInteractionRequest): void {
  try {
    chrome.runtime.sendMessage({
      type: 'human_interaction_request',
      request,
    });
  } catch (err) {
    // Message may fail if no listeners, that's OK
    console.log('[HumanInteraction] Failed to send to UI (sidebar may not be open):', err);
  }
}

/**
 * Request user confirmation (Yes/No)
 */
export async function requestConfirm(prompt: string): Promise<boolean> {
  const id = generateId();
  const request: HumanInteractionRequest = {
    id,
    type: 'confirm',
    prompt,
    timestamp: Date.now(),
  };

  return new Promise((resolve) => {
    pendingInteractions.set(id, {
      request,
      resolve: (response) => resolve(response.confirmed ?? false),
    });
    persistPendingInteractions();
    updateKeepAlive(); // Start keep-alive to prevent SW termination
    sendInteractionToUI(request);
  });
}

/**
 * Request user text input
 */
export async function requestInput(prompt: string): Promise<string | null> {
  const id = generateId();
  const request: HumanInteractionRequest = {
    id,
    type: 'input',
    prompt,
    timestamp: Date.now(),
  };

  return new Promise((resolve) => {
    pendingInteractions.set(id, {
      request,
      resolve: (response) => resolve(response.cancelled ? null : (response.input ?? '')),
    });
    persistPendingInteractions();
    updateKeepAlive(); // Start keep-alive to prevent SW termination
    sendInteractionToUI(request);
  });
}

/**
 * Request user selection from options
 */
export async function requestSelect(prompt: string, options: string[], multiple?: boolean): Promise<string[]> {
  const id = generateId();
  const request: HumanInteractionRequest = {
    id,
    type: 'select',
    prompt,
    options,
    multiple,
    timestamp: Date.now(),
  };

  return new Promise((resolve) => {
    pendingInteractions.set(id, {
      request,
      resolve: (response) => resolve(response.selections ?? []),
    });
    persistPendingInteractions();
    updateKeepAlive(); // Start keep-alive to prevent SW termination
    sendInteractionToUI(request);
  });
}

/**
 * Request user help (login or other assistance)
 */
export async function requestHelp(
  helpType: 'request_login' | 'request_assistance',
  prompt: string
): Promise<boolean> {
  const id = generateId();
  const request: HumanInteractionRequest = {
    id,
    type: 'help',
    prompt,
    helpType,
    timestamp: Date.now(),
  };

  return new Promise((resolve) => {
    pendingInteractions.set(id, {
      request,
      resolve: (response) => resolve(response.confirmed ?? false),
    });
    persistPendingInteractions();
    updateKeepAlive(); // Start keep-alive to prevent SW termination
    sendInteractionToUI(request);
  });
}

/**
 * Handle response from the UI
 */
export async function handleInteractionResponse(response: HumanInteractionResponse): Promise<boolean> {
  // First check in-memory pending interactions
  const pending = pendingInteractions.get(response.id);
  if (pending) {
    console.log('[HumanInteraction] Found pending interaction in memory:', response.id);
    pending.resolve(response);
    pendingInteractions.delete(response.id);
    await persistPendingInteractions();
    updateKeepAlive(); // Stop keep-alive if no more pending interactions
    return true;
  }
  
  // Check restored resolvers (from before service worker restart)
  const restoredResolver = restoredResolvers.get(response.id);
  if (restoredResolver) {
    console.log('[HumanInteraction] Found restored resolver:', response.id);
    restoredResolver(response);
    restoredResolvers.delete(response.id);
    // Also remove from persisted storage
    const stored = await loadPendingInteractionsFromStorage();
    const remaining = stored.filter(r => r.id !== response.id);
    await chrome.storage.local.set({ [STORAGE_KEY]: remaining });
    updateKeepAlive(); // Stop keep-alive if no more pending interactions
    return true;
  }
  
  // Check if this interaction exists in storage (service worker might have restarted)
  const storedInteractions = await loadPendingInteractionsFromStorage();
  const storedInteraction = storedInteractions.find(r => r.id === response.id);
  if (storedInteraction) {
    console.log('[HumanInteraction] Found interaction in storage (service worker restarted), removing:', response.id);
    // Remove from storage - the original promise can't be resolved (workflow was lost)
    // but we should clean up and acknowledge the response
    const remaining = storedInteractions.filter(r => r.id !== response.id);
    await chrome.storage.local.set({ [STORAGE_KEY]: remaining });
    // Note: The original workflow that created this interaction is gone after SW restart
    // Return true to indicate we handled it (cleanup)
    return true;
  }
  
  console.warn('[HumanInteraction] Received response for unknown interaction:', response.id);
  return false;
}

/**
 * Get all pending interactions (for UI to display on load/reconnect)
 * Checks both in-memory and persisted storage
 */
export async function getPendingInteractionsAsync(): Promise<HumanInteractionRequest[]> {
  // Combine in-memory and persisted interactions
  const inMemory = Array.from(pendingInteractions.values()).map(p => p.request);
  const persisted = await loadPendingInteractionsFromStorage();
  
  // Dedupe by id, preferring in-memory
  const byId = new Map<string, HumanInteractionRequest>();
  for (const req of persisted) {
    byId.set(req.id, req);
  }
  for (const req of inMemory) {
    byId.set(req.id, req);
  }
  
  return Array.from(byId.values());
}

/**
 * Get all pending interactions (sync version for backward compatibility)
 */
export function getPendingInteractions(): HumanInteractionRequest[] {
  return Array.from(pendingInteractions.values()).map(p => p.request);
}

/**
 * Cancel all pending interactions (e.g., when agent stops)
 */
export async function cancelAllPendingInteractions(): Promise<void> {
  for (const [id, pending] of pendingInteractions) {
    pending.resolve({ id, cancelled: true });
  }
  pendingInteractions.clear();
  
  // Also clear restored resolvers
  for (const [id, resolver] of restoredResolvers) {
    resolver({ id, cancelled: true });
  }
  restoredResolvers.clear();
  
  // Clear persisted storage
  await clearPersistedInteractions();
  
  // Stop keep-alive since no more pending interactions
  stopKeepAlive();
}

/**
 * Set up message listener for UI responses
 * Call this from background/index.ts on extension startup
 */
export function setupHumanInteractionListener(): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'human_interaction_response') {
      // Handle async response
      handleInteractionResponse(message.response)
        .then(handled => {
          console.log('[HumanInteraction] Response handled:', handled, 'for id:', message.response?.id);
          sendResponse({ handled });
        })
        .catch(err => {
          console.error('[HumanInteraction] Error handling response:', err);
          sendResponse({ handled: false, error: err.message });
        });
      return true; // Keep channel open for async response
    }
    
    if (message.type === 'get_pending_interactions') {
      // Use async version to include persisted interactions
      getPendingInteractionsAsync()
        .then(interactions => {
          console.log('[HumanInteraction] Returning pending interactions:', interactions.length);
          sendResponse({ interactions });
        })
        .catch(err => {
          console.error('[HumanInteraction] Error getting pending interactions:', err);
          sendResponse({ interactions: getPendingInteractions() }); // Fallback to sync
        });
      return true; // Keep channel open for async response
    }
    
    return false;
  });
}
