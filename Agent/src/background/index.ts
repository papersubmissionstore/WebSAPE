import { config, Eko, Log, setDebugModeEnabled, setLabelStyle } from "@eko-ai/eko";
import { BrowserAgent } from "@eko-ai/eko-extension";
import { main, flushCurrentTracer, abortMultiAgentOrchestrator, isWorkflowCompleted, setLastAbortReason } from "./main";
import { logger } from "../utils/logger";
import { ExtensionTransport } from "../utils/eko-logger-transport";
import { setupHumanInteractionListener, cancelAllPendingInteractions } from "./human_interaction";
import { cdpManager } from "./cdp-manager";

// ── Wire shared CDP manager into eko's BrowserAgent ──────────────────────────
// This ensures eko (a11y tree, CDP clicks) and pre-run handlers (cookie
// injection, dialog auto-dismiss) all share the same chrome.debugger session
// per tab, preventing "another debugger is already attached" conflicts.
BrowserAgent.setCdpProvider(async (tabId: number) => {
  const session = await cdpManager.acquire(tabId);
  return session;
});
logger.info("EXTENSION_INIT", "BrowserAgent CDP provider set to shared CdpManager");

// Set default tree build mode for fresh installs where chrome.storage has never
// been written to.
config.treeBuildMode = "eko-native";

// Load debug mode setting from storage (default to false)
// NOTE: When adding a new config field here, also add it to all taskStatus objects
// in main.ts so it gets logged in task_status.json for every run.
chrome.storage.sync.get(["debugModeEnabled", "logLLMContext", "disableHumanInteract", "dynamicCompressThreshold", "dynamicPlan", "compressTriggerMessageCount"], (result) => {
  const debugEnabled = result.debugModeEnabled ?? false;
  setDebugModeEnabled(debugEnabled);
  // Enable LLM context logging if requested
  config.logLLMContext = result.logLLMContext ?? false;
  // Disable human_interact tool if requested
  (config as any).disableHumanInteract = result.disableHumanInteract ?? false;
  // Enable dynamic compress threshold if requested
  (config as any).dynamicCompressThreshold = result.dynamicCompressThreshold ?? false;
  // Enable dynamic plan features if requested
  (config as any).dynamicPlan = result.dynamicPlan ?? false;
  // Message-count trigger for context compression (maps to eko-core's config.compressThreshold; only override if explicitly set)
  if (result.compressTriggerMessageCount !== undefined) config.compressThreshold = Number(result.compressTriggerMessageCount);
  logger.info("CONFIG_INIT", "Debug mode initialized", {
    enabled: debugEnabled,
    logLLMContext: config.logLLMContext,
    disableHumanInteract: (config as any).disableHumanInteract,
    dynamicCompressThreshold: (config as any).dynamicCompressThreshold,
    dynamicPlan: (config as any).dynamicPlan,
    compressTriggerMessageCount: config.compressThreshold,
  });
});

// Restore persisted mode/tree settings so they survive service-worker restarts.
// Without this the @eko-ai/eko config defaults (e.g. treeBuildMode: "eko-native")
// would silently override the user's sidebar selection.
//
// IMPORTANT: configReady is awaited by message handlers (get_current_config, run)
// so that the eko-native default is never leaked before storage finishes loading.
const configReady: Promise<void> = new Promise((resolve) => {
  chrome.storage.sync.get(
    ["treeBuildMode", "mode", "markImageMode", "includeNonIndexedElements", "maxA11yElements", "viewportExpansion", "multiProbeIsTopElement", "actionLandingWatchdog", "labelStyle"],
    (result) => {
      if (result.treeBuildMode)              config.treeBuildMode = result.treeBuildMode;
      if (result.mode)                       config.mode = result.mode;
      if (result.markImageMode)              config.markImageMode = result.markImageMode;
      if (result.includeNonIndexedElements !== undefined) config.includeNonIndexedElements = result.includeNonIndexedElements;
      if (result.maxA11yElements !== undefined)           config.maxA11yElements = result.maxA11yElements;
      if (result.viewportExpansion !== undefined)          config.viewportExpansion = result.viewportExpansion;
      if (result.multiProbeIsTopElement !== undefined)     config.multiProbeIsTopElement = !!result.multiProbeIsTopElement;
      if (result.actionLandingWatchdog !== undefined)      config.actionLandingWatchdog = !!result.actionLandingWatchdog;
      // Label style must be loaded before any task runs to avoid noocclude being ignored
      setLabelStyle(result.labelStyle ?? 'legacy');
      logger.info("CONFIG_INIT", "Restored persisted mode settings", {
        treeBuildMode: config.treeBuildMode,
        mode: config.mode,
        markImageMode: config.markImageMode,
        includeNonIndexedElements: config.includeNonIndexedElements,
        maxA11yElements: config.maxA11yElements,
        viewportExpansion: config.viewportExpansion,
        multiProbeIsTopElement: config.multiProbeIsTopElement,
        actionLandingWatchdog: config.actionLandingWatchdog,
        labelStyle: result.labelStyle ?? 'legacy',
      });
      resolve();
    }
  );
});

var eko: Eko;

chrome.storage.local.set({ running: false });

// Initialize logger and load persisted logs
logger.loadPersistedLogs().then(() => {
  logger.info("EXTENSION_INIT", "WebSAPE extension initialized");
});

// Configure Eko's internal Log to send messages to the extension UI
Log.addTransport(new ExtensionTransport());
logger.info("EXTENSION_INIT", "Configured Eko Log transport to bridge to extension UI");

// Set up human interaction message listener
setupHumanInteractionListener();
logger.info("EXTENSION_INIT", "Human interaction listener initialized");

// Listen to messages from the browser extension
chrome.runtime.onMessage.addListener(function (
  request,
  sender,
  sendResponse
) {
  // Don't log "log" type messages to avoid recursive logging
  if (request.type !== "log" && request.type !== "stop") {
    logger.debug("MESSAGE_RECEIVED", `Message type: ${request.type}`, {
      requestType: request.type,
      sender: sender.id,
    });
  }

  // Handle synchronous responses first (these need sendResponse)
  if (request.type == "get_current_config") {
    // Wait for persisted config to load so we never return eko-native defaults
    configReady.then(() => {
      sendResponse({
        mode: config.mode,
        markImageMode: config.markImageMode,
        treeBuildMode: config.treeBuildMode,
        includeNonIndexedElements: config.includeNonIndexedElements,
      });
    });
    return true; // Keep channel open for async sendResponse
  } else if (request.type == "get_current_session_id") {
    // Return the current session ID from the logger
    const sessionId = logger.getCurrentSessionId();
    logger.debug("SESSION_ID_REQUEST", "Returning current session ID", { sessionId });
    sendResponse({
      sessionId: sessionId,
    });
    return false; // Synchronous response
  }

  // Handle async operations (no sendResponse needed)
  if (request.type == "run") {
    (async () => {
      try {
        // Ensure persisted config (treeBuildMode etc.) is loaded before
        // we read or fall back to config.* values.
        await configReady;

        // Fresh-read config from storage to catch any writes that
        // storage.onChanged may have missed (e.g. MV3 service worker was
        // sleeping when the resolver wrote to storage, or the onChanged
        // event hadn't dispatched yet).  This is the authoritative read.
        await new Promise<void>((resolve) => {
          chrome.storage.sync.get(
            ["treeBuildMode", "mode", "markImageMode", "includeNonIndexedElements", "maxA11yElements", "viewportExpansion", "multiProbeIsTopElement", "actionLandingWatchdog", "labelStyle", "dynamicCompressThreshold", "dynamicPlan", "compressTriggerMessageCount", "logLLMContext", "disableHumanInteract", "debugModeEnabled"],
            (result) => {
              if (result.treeBuildMode)              config.treeBuildMode = result.treeBuildMode;
              if (result.mode)                       config.mode = result.mode;
              if (result.markImageMode)              config.markImageMode = result.markImageMode;
              if (result.includeNonIndexedElements !== undefined) config.includeNonIndexedElements = result.includeNonIndexedElements;
              if (result.maxA11yElements !== undefined)           config.maxA11yElements = result.maxA11yElements;
              if (result.viewportExpansion !== undefined)          config.viewportExpansion = result.viewportExpansion;
              if (result.multiProbeIsTopElement !== undefined)     config.multiProbeIsTopElement = !!result.multiProbeIsTopElement;
              if (result.actionLandingWatchdog !== undefined)      config.actionLandingWatchdog = !!result.actionLandingWatchdog;
              if (result.labelStyle)                 setLabelStyle(result.labelStyle);
              if (result.dynamicCompressThreshold !== undefined) (config as any).dynamicCompressThreshold = result.dynamicCompressThreshold;
              if (result.dynamicPlan !== undefined)  (config as any).dynamicPlan = result.dynamicPlan;
              if (result.compressTriggerMessageCount !== undefined) config.compressThreshold = Number(result.compressTriggerMessageCount);
              if (result.logLLMContext !== undefined) config.logLLMContext = result.logLLMContext;
              if (result.disableHumanInteract !== undefined)     (config as any).disableHumanInteract = result.disableHumanInteract;
              if (result.debugModeEnabled !== undefined)         setDebugModeEnabled(result.debugModeEnabled);
              resolve();
            }
          );
        });

        const taskKind = request.taskKind || 'quick_trial';
        const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        const resolverTaskId = request.resolverTaskId || 'quick_trial';
        const dataset = request.dataset || 'custom';
        
        // For quick trial, generate taskId from timestamp + short hash of query
        // This makes snapshot folders identifiable by when and what query was run
        let taskId: string;
        if (request.taskId) {
          taskId = request.taskId;
        } else {
          // djb2 hash of the prompt, 8 hex chars
          let h = 5381;
          const p = request.prompt || '';
          for (let i = 0; i < p.length; i++) {
            h = ((h << 5) + h + p.charCodeAt(i)) & 0xFFFFFFFF;
          }
          const queryHash = (h >>> 0).toString(16).padStart(8, '0');
          taskId = `${timestamp}_${queryHash}`;
        }
        logger.info("WORKFLOW_REQUEST", "Starting workflow from user request", {
          prompt: request.prompt,
          taskKind,
          resolverTaskId,
          dataset,
          taskId,
          correlationId: request.correlationId,
        });

        // Config is now guaranteed to reflect the latest storage values.

        // Click the RUN button to execute the main function (workflow)
        chrome.runtime.sendMessage({ type: "log", log: "Run..." });
        chrome.runtime.sendMessage({ type: "log", log: `[Debug] localOutputDir=${request.localOutputDir || '(not set)'}` });
        // Run workflow with task options
        eko = await main(request.prompt, {
          taskKind,
          resolverTaskId,
          dataset,
          taskId,
          correlationId: request.correlationId,
          timeoutMs: request.timeoutMs,
          localOutputDir: request.localOutputDir,
        });
      } catch (e) {
        logger.error("WORKFLOW_EXCEPTION", "Unexpected error during workflow", {
          error: e.toString(),
          stack: e.stack,
        });
        console.error(e);
        chrome.runtime.sendMessage({
          type: "log",
          log: e + "",
          level: "error",
        });
      } finally {
      }
    })();
  } else if (request.type == "stop") {
    const reason = request.reason; // Optional reason for the stop
    // Determine the abort reason - use provided reason or default to user cancelled
    const abortReason = reason || 'User manually cancelled';
    
    // IMPORTANT: Capture the current prompt NOW before any async operations
    // This prevents race conditions where the next query overwrites currentPrompt
    // before the flush completes
    const promptToFlush = request.prompt; // Pass the prompt from the request if available
    
    // Only perform abort operations if the workflow hasn't already completed normally.
    // When isWorkflowCompleted() is true, the .then()/.catch() chain in main.ts already
    // uploaded task_status, snapshots, and traces — we must NOT overwrite them.
    if (!isWorkflowCompleted()) {
      // IMPORTANT: Abort multi-agent orchestrator FIRST (before flushing)
      // This stops the orchestration loop and any running child agents
      abortMultiAgentOrchestrator(abortReason);
      
      // Store the abort reason so the .catch() handler in main.ts can use the real
      // reason instead of always defaulting to "User manually cancelled"
      setLastAbortReason(abortReason);
      
      // NOTE: Do NOT flush task_status or accumulated snapshots here. The .catch() handler
      // in main.ts will upload them after the AbortError is logged to progress.json.
      // Flushing here would cause double uploads where the second overwrites the first.
      
      // Flush and send current trace to server
      flushCurrentTracer().catch(err => {
        console.error('[Background] Error flushing tracer:', err);
      });
      
      // Log and end session as aborted
      if (reason) {
        logger.info("WORKFLOW_ABORT", `Aborting workflow tasks: ${reason}`, { reason });
        logger.endSession('aborted', undefined, reason);
        chrome.runtime.sendMessage({ type: "log", log: `⏹️ Stopping: ${reason}`, level: "warning" });
      } else {
        logger.info("WORKFLOW_ABORT", "Aborting workflow tasks: User manually cancelled");
        logger.endSession('aborted', undefined, 'User manually cancelled');
      }
      // Cancel any pending human interactions (async but we don't need to wait)
      cancelAllPendingInteractions().catch(err => {
        console.error('[Background] Error cancelling pending interactions:', err);
      });
      if (eko) {
        try {
          eko.getAllTaskId().forEach(taskId => {
            logger.info("TASK_ABORT", `Aborting task: ${taskId}`, { reason });
            eko.abortTask(taskId);
            chrome.runtime.sendMessage({ type: "log", log: "Abort taskId: " + taskId });
          });
        } catch (err) {
          logger.warning("TASK_ABORT", "Error during eko.abortTask()", { error: String(err) });
        }
      } else {
        logger.warning("TASK_ABORT", "eko is not initialized, cannot abort tasks");
      }
      chrome.runtime.sendMessage({ type: "log", log: "Stop" });
    } else {
      logger.info("WORKFLOW_STOP", "Workflow already completed, skipping all abort operations");
    }
  }
});

(chrome as any).sidePanel && (chrome as any).sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
