import { Eko, LLMs, StreamCallbackMessage, HumanInteractTool, config as ekoConfig, clearProgress, logStatus, setDebugModeEnabled, isDebugModeEnabled, getCompressTokensThresholdForModel, getLabelStyle } from "@eko-ai/eko";
import { IMcpClient } from "@eko-ai/eko/types";
import { StreamCallback, HumanCallback } from "@eko-ai/eko/types";
import { BrowserAgent } from "@eko-ai/eko-extension";
import { logger, measurePerformance } from "../utils/logger";
import { getDefaultLlmModel } from "../utils/default-model";
import { BUILD_INFO, getBuildInfoForLogs } from "../utils/build-info";
import { ExecutionTracer } from "../utils/execution-tracer";
import { getCurrentPageUrl } from "../utils/browser-utils";
import { McpListToolParam, McpListToolResult, McpCallToolParam, ToolResult } from "@eko-ai/eko/types";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpToolClient, ToolExecutor, BrowserToolExecutor, createMcpToolClient, createMcpToolClientFromUrl } from "./mcp_tool_client";
import { 
  requestConfirm, 
  requestInput, 
  requestSelect, 
  requestHelp,
  cancelAllPendingInteractions 
} from "./human_interaction";
import {
  formatInstructionsForPrompt,
  getCurrentTabUrl,
  type InstructionInfo,
} from "../utils/instruction-loader";
import {
  MultiAgentOrchestrator,
  createMultiAgentOrchestrator,
  type MultiAgentConfig,
  type InstructionConfig
} from "./multi-agent";
import { cdpManager } from "./cdp-manager";
import { createSnapshotSaver, type ISnapshotSaver } from "./snapshot-saver";
import { buildExperienceUsePrompt } from "../prompts/experience-use";
import { buildExperienceMetaPrompt } from "../prompts/experience-meta";

const DEFAULT_SDF_API_KEY = "websape-dev-key";

/** Timeout for cleanup operations (CDP, uploads, traces). Prevents hanging forever. */
const CLEANUP_TIMEOUT_MS = 30_000;

/**
 * Wrap a promise with a timeout. Resolves/rejects with the original result if it
 * finishes in time, otherwise rejects with a timeout error.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// Get feature toggles from storage
interface FeatureToggles {
  useInstructions: boolean;
  instructionsVersion: string;
  useExperience: boolean;
  experienceVersion?: string;
  toolsVersion?: string;
}

async function getFeatureToggles(): Promise<FeatureToggles> {
  const result = await chrome.storage.sync.get(["useInstructions", "instructionsVersion", "useExperience", "experienceVersion", "toolsVersion"]);
  return {
    useInstructions: result.useInstructions ?? false,
    instructionsVersion: result.instructionsVersion ?? '',
    useExperience: false,
    experienceVersion: 'none',
    toolsVersion: '',
  };
}

// Standalone stub: experience selection is not available in standalone version
async function selectExperiencesFromServer(options: {
  serverEndpoint?: string;
  taskPrompt: string;
  experienceVersion?: string;
  maxRead?: number;
  maxInject?: number;
  timeoutMs?: number;
}): Promise<{ experiences: any[]; readCount: number; selectedCount: number; error?: string }> {
  // Standalone: Load bundled experiences from outlook.json
  try {
    const experienceUrl = chrome.runtime.getURL('experiences/outlook.json');
    const response = await fetch(experienceUrl);
    const data = await response.json();

    // Return all experiences from the bundled file
    const experiences = data.experiences || [];
    return {
      experiences,
      readCount: experiences.length,
      selectedCount: Math.min(3, experiences.length)  // Select up to 3 for injection
    };
  } catch (error) {
    logger.error('EXPERIENCE_LOAD', 'Failed to load bundled experiences', { error: String(error) });
    return { experiences: [], readCount: 0, selectedCount: 0, error: String(error) };
  }
}

// Standalone stub: get server endpoint is not applicable
async function getServerEndpoint(): Promise<string> {
  // Standalone version doesn't use a server endpoint
  return '';
}

// Normalize experience version string (handle 'none', empty, undefined)
function normalizeExperienceVersion(version?: string): string {
  if (!version || version === '' || version === 'none') return 'none';
  return version;
}

// Interface for agent mode configuration from storage
interface AgentModeConfig {
  mode: "single" | "multi";
  multiAgentConfig?: MultiAgentConfig;
}

// Get agent mode configuration from storage
async function getAgentModeConfig(): Promise<AgentModeConfig> {
  const result = await chrome.storage.sync.get(["agentModeConfig"]);
  return result.agentModeConfig || {
    mode: "single",
    multiAgentConfig: {
      maxSubTaskSteps: 10,
      maxSubTasks: 5,
      maxIterations: 10,
      maxHistorySummaries: 5,
    },
  };
}

// Get MCP API key from storage
async function getMcpApiKey(): Promise<string | undefined> {
  const result = await chrome.storage.sync.get(["mcpApiKey"]);
  return result.mcpApiKey;
}

// Current active tracer (for abort handling)
let currentTracer: ExecutionTracer | null = null;
// Current prompt (for abort handling run config upload)
let currentPrompt: string | null = null;
// Current original session ID (timestamp-based, for tracking in task_status.json)
let currentOriginalSessionId: string | null = null;
// Current multi-agent orchestrator (for abort handling)
let currentMultiAgentOrchestrator: MultiAgentOrchestrator | null = null;
// Current session ID (full path for snapshot uploads)
let currentSessionId: string | null = null;
// Current snapshot context (resolverTaskId/dataset/taskId/serverUrl) for upload
let currentSnapshotContext: { resolverTaskId?: string; dataset?: string; taskId?: string; serverUrl?: string } | null = null;
// Flag to track if workflow has already completed (prevents abort from overwriting status)
let workflowCompleted: boolean = false;
// Last abort reason set by the stop handler (so .catch() can use the real reason)
let lastAbortReason: string | null = null;
// Current correlation ID from the sidebar for matching stop/cleanup_progress messages
let currentCorrelationId: string | null = null;

/**
 * Check if the current workflow has already completed.
 * This prevents the stop handler from overwriting the task status after completion.
 */
export function isWorkflowCompleted(): boolean {
  return workflowCompleted;
}

/**
 * Mark the workflow as completed. Called when workflow finishes (success or failure).
 */
function markWorkflowCompleted(): void {
  workflowCompleted = true;
}

/**
 * Reset the workflow completed flag. Called at the start of a new workflow.
 */
function resetWorkflowCompleted(): void {
  workflowCompleted = false;
  lastAbortReason = null;
}

/**
 * Set the last abort reason (called by the stop handler before eko.abortTask()).
 * The .catch() handler reads this to use the real reason instead of a generic message.
 */
export function setLastAbortReason(reason: string): void {
  lastAbortReason = reason;
}

/**
 * Get and clear the last abort reason.
 */
function consumeLastAbortReason(): string {
  const reason = lastAbortReason;
  lastAbortReason = null;
  return reason || 'User manually cancelled';
}

/**
 * Check if a resolved (non-rejected) workflow result indicates an abort.
 * Used in the .then() path where the eko/multi-agent workflow caught an AbortError
 * internally and returned { success: false } instead of re-throwing.
 *
 * @param pendingAbortReason - The lastAbortReason captured before cleanup
 * @param result - The result string from the workflow response
 */
function isAbortResult(pendingAbortReason: string | null | undefined, result?: string): boolean {
  // lastAbortReason is always set before triggering abort (timeout or user stop)
  if (pendingAbortReason) return true;
  // Fallback: check the result string for abort indicators
  if (typeof result === 'string') {
    return result.includes('AbortError') ||
           result.includes('Operation was interrupted') ||
           result.includes('aborted by user');
  }
  return false;
}

// ── Snapshot Persistence ─────────────────────────────────────────────────────

/** Current local output directory for client loop mode (null when not in use) */
let currentLocalOutputDir: string | null = null;

/**
 * Clean up the current tracer on abort.
 * Trace upload has been removed — this just resets the reference.
 */
export async function flushCurrentTracer(): Promise<void> {
  if (currentTracer) {
    logger.info("TRACER_FLUSH", "Cleaning up tracer on abort");
    currentTracer.endSession('aborted');
    currentTracer = null;
  }
}

// ── Shared workflow result saving ────────────────────────────────────────────

interface WorkflowSaveContext {
  saver: ISnapshotSaver;
  taskStatus: Record<string, unknown>;
  success: boolean;
  status: string;
  error?: string;
  sessionId?: string;
  correlationId?: string;
}

/**
 * Save all workflow results (task_status.json + accumulated snapshots + _done.json)
 * through the abstract saver. Used by all 4 completion/error handlers.
 */
async function saveWorkflowResults(ctx: WorkflowSaveContext): Promise<void> {
  chrome.runtime.sendMessage({ type: "cleanup_progress", phase: "saving_results", correlationId: ctx.correlationId });
  const savedFiles: string[] = [];
  try {
    // Save task_status.json and accumulated snapshots concurrently
    const [, saveResult] = await Promise.all([
      ctx.saver.saveTaskStatus(ctx.taskStatus),
      ctx.saver.saveAccumulatedSnapshots(),
    ]);
    savedFiles.push('task_status.json');

    if (saveResult.saved > 0) {
      printLog(`💾 Saved ${saveResult.saved} snapshots`, "info");
    }
    if (saveResult.failed > 0) {
      printLog(`⚠️ ${saveResult.failed} snapshots failed to save`, "warning");
    }
    savedFiles.push(...saveResult.savedFilenames);

    await ctx.saver.writeDoneSignal({
      success: ctx.success,
      status: ctx.status,
      error: ctx.error,
      sessionId: ctx.sessionId,
      fileCount: savedFiles.length,
      files: savedFiles,
    });
    printLog(`✅ Save complete: ${savedFiles.length} files`, "info");
  } catch (err) {
    printLog(`⚠️ Save error: ${err}`, "warning");
    try {
      await ctx.saver.writeDoneSignal({
        success: false,
        status: 'failed',
        error: `Save error: ${err}`,
        sessionId: ctx.sessionId,
        fileCount: savedFiles.length,
        files: savedFiles,
      });
    } catch (doneErr) {
      console.error(`[Save] Fallback _done.json write also failed: ${doneErr}`);
    }
  }
}

/**
 * Abort the current multi-agent orchestrator.
 * Called from index.ts when user clicks stop.
 */
export function abortMultiAgentOrchestrator(reason?: string): void {
  if (currentMultiAgentOrchestrator) {
    logger.info("MULTI_AGENT_ABORT", "Aborting multi-agent orchestrator", { reason });
    // Send stop message to UI panel
    chrome.runtime.sendMessage({
      type: "log",
      log: `⏹️ [Multi-Agent] Stopping orchestration: ${reason || 'User manually cancelled'}`,
      level: "warning",
    });
    currentMultiAgentOrchestrator.abort(reason || 'User manually cancelled');
    currentMultiAgentOrchestrator = null;
  }
}

class MyMCPClient implements IMcpClient {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private _isConnected: boolean = false;
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private createNewClient(): void {
    // Always create fresh instances to avoid transport reuse issues
    this.transport = new StreamableHTTPClientTransport(new URL(this.baseUrl));
    this.client = new Client({
      name: "eko-proxy-client",
      version: "1.0.0"
    }, {
      capabilities: {}
    });
    this._isConnected = false;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this._isConnected && this.client && this.transport) {
      return; // Already connected, don't try to connect again
    }
    
    try {
      // Create new client and transport if not exists or connection failed
      if (!this.client || !this.transport) {
        this.createNewClient();
      }
      
      await this.client!.connect(this.transport!);
      this._isConnected = true;
    } catch (error) {
      this._isConnected = false;
      // Reset client and transport on connection failure
      this.client = null;
      this.transport = null;
      throw error;
    }
  }

  async listTools(param: McpListToolParam, signal?: AbortSignal): Promise<McpListToolResult> {
    if (!this._isConnected) {
      await this.connect(signal);
    }
    
    if (!this.client) {
      throw new Error('MCP client not initialized');
    }
    
    const result = await this.client.listTools();
    
    // Convert MCP SDK response to expected format
    return result.tools?.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as any
    })) || [];
  }

  async callTool(param: McpCallToolParam, signal?: AbortSignal): Promise<ToolResult> {
    if (!this._isConnected) {
      await this.connect(signal);
    }
    
    if (!this.client) {
      throw new Error('MCP client not initialized');
    }
    const result = await this.client.callTool({
      name: param.name,
      arguments: param.arguments || {}
    });
    
    // Convert MCP SDK response to expected ToolResult format
    let content: ToolResult['content'];
    
    if (result && typeof result === 'object' && 'content' in result) {
      const resultContent = (result as any).content;
      if (Array.isArray(resultContent)) {
        content = resultContent.map((item: any) => {
          if (item && typeof item === 'object') {
            if (item.type === 'text') {
              return { type: "text", text: item.text || "" };
            } else if (item.type === 'image') {
              return { 
                type: "image", 
                data: item.data || "", 
                mimeType: item.mimeType 
              };
            }
          }
          // Fallback to text if unknown type
          return { type: "text", text: JSON.stringify(item) };
        }) as ToolResult['content'];
      } else {
        content = [{ type: "text", text: JSON.stringify(resultContent) }];
      }
    } else {
      content = [{ type: "text", text: "No content returned" }];
    }
    
    const isError = result && typeof result === 'object' && 'isError' in result 
      ? Boolean((result as any).isError) 
      : false;
    
    return {
      content,
      isError,
      extInfo: param.extInfo ? { ...param.extInfo } : undefined
    };
  }

  isConnected(): boolean {
    return this._isConnected;
  }

  async close(): Promise<void> {
    if (this._isConnected && this.client) {
      await this.client.close();
      this._isConnected = false;
    }
    // Reset client and transport
    this.client = null;
    this.transport = null;
  }
}

export async function getLLMConfig(name: string = "llmConfig"): Promise<any> {
  let result = await chrome.storage.sync.get([name]);
  return result[name];
}

/**
 * Task execution mode
 */
export type TaskKind = 'quick_trial';

/**
 * Options for task execution
 * 
 * Snapshot path structure: {resolverTaskId}/{dataset}/{taskId}/
 * Example: task_abc12345/cua/query_a1b2c3d4/
 */
export interface TaskOptions {
  /** Task execution mode */
  taskKind: TaskKind;
  /** Resolver task ID (folder name), e.g., "task_abc12345" */
  resolverTaskId: string;
  /** Dataset name from job config, e.g., "webarena", "cua", "custom" */
  dataset: string;
  /** Task/entry identifier (query_hash), e.g., "query_a1b2c3d4" */
  taskId: string;
  /** Correlation ID from the sidebar for matching stop/cleanup_progress messages back to the correct entry */
  correlationId?: string;
  /**
   * Per-entry execution timeout in milliseconds.
   * When set, the background starts a self-contained timer that directly aborts
   * the eko workflow when it fires. No sidebar involvement is needed for timeout
   * control — the abort triggers the .catch() handler which uploads all results
   * and sends the final "stop" message.
   * When 0 or undefined, no timeout is applied.
   */
  timeoutMs?: number;
  /**
   * Local output directory name (relative to Downloads) for the client loop.
   * When set, the extension saves snapshots, progress.json, task_status.json,
   * and _done.json to this folder via chrome.downloads in addition to the
   * normal server upload.
   */
  localOutputDir?: string;
}

export async function main(prompt: string, options: TaskOptions): Promise<Eko> {
  const { taskKind, resolverTaskId, dataset, taskId, correlationId, timeoutMs, localOutputDir } = options;

  // Store local output dir for client loop mode
  currentLocalOutputDir = localOutputDir || null;

  // Store correlation ID for message matching
  currentCorrelationId = correlationId || null;

  // Force-enable debug mode when localOutputDir is set (scraper / client loop
  // mode) — snapshot accumulation must be active BEFORE eko.run() starts so
  // screenshots and DOM are captured for local download.
  // In quick trial mode, debug mode is controlled by the sidebar UI toggle.
  if (localOutputDir) {
    setDebugModeEnabled(true);
  }

  // Store prompt for abort handling
  currentPrompt = prompt;
  
  // ── Self-keep-alive for the MV3 service worker ────────────────────────────
  // Chrome can kill the background service worker after ~30s of inactivity.
  // The sidebar connects a keep-alive port, but as a backup we also poke
  // chrome.storage every 20s to reset the inactivity timer from the
  // background side. Cleared in the final .then() alongside entryTimeoutTimer.
  const swKeepAliveTimer = setInterval(() => {
    chrome.storage.local.get(['_swKeepAlive'], () => {
      // The callback itself is an "event" that resets Chrome's idle timer
    });
  }, 20_000);
  
  // Reset workflow completed flag for new workflow
  resetWorkflowCompleted();
  
  // Start a new logging session
  const baseSessionId = logger.startSession(prompt);
  
  // Build session ID with folder hierarchy: {resolverTaskId}/{dataset}/{taskId}
  // Example: task_abc12345/cua/query_a1b2c3d4
  const taskSessionId = `task${baseSessionId}`;
  const originalSessionId = taskSessionId;
  currentOriginalSessionId = originalSessionId;
  
  // Compose session ID for logging: {resolverTaskId}/{dataset}/{taskId}
  const sessionId = `${resolverTaskId}/${dataset}/${taskId}`;
  
  // Store session ID for abort handling (snapshot uploads)
  currentSessionId = sessionId;
  
  // Update logger's session ID to the prefixed version so all subsequent calls use the correct folder name
  logger.updateCurrentSessionId(sessionId);
  logger.info("WORKFLOW_INIT", `Started new session: ${sessionId} (${taskKind}) - Retrieving LLM configuration`, {
    resolverTaskId,
    dataset,
    taskId,
    originalSessionId,
  });

  // Get MCP configuration from storage first (needed for skill MCP)
  const featureToggles = await getFeatureToggles();
  
  // Get server endpoint directly from storage (unified URL for all services)
  const snapshotServerUrl = await getServerEndpoint();
  logger.info("WEBSAPE_SERVER", "Using server from config", {
    serverEndpoint: snapshotServerUrl,
  });

  // If no instruction version selected, disable instructions entirely
  if (featureToggles.useInstructions && !featureToggles.instructionsVersion) {
    featureToggles.useInstructions = false;
    console.log("[WEBSAPE DEBUG] No instruction version configured, disabling instructions");
  }

  // Match instruction behavior: if experience toggle is on but no concrete version
  // is configured, disable experience for this run.
  const normalizedConfiguredExperienceVersion = normalizeExperienceVersion(featureToggles.experienceVersion);
  if (featureToggles.useExperience && (!normalizedConfiguredExperienceVersion || normalizedConfiguredExperienceVersion === 'none')) {
    featureToggles.useExperience = false;
    console.log("[WEBSAPE DEBUG] No experience version configured, disabling experience");
  }
  const experienceVersion = featureToggles.useExperience
    ? normalizedConfiguredExperienceVersion
    : 'none';

  // Store snapshot context for upload calls (now that we have serverUrl)
  currentSnapshotContext = { resolverTaskId, dataset, taskId, serverUrl: snapshotServerUrl };

  // =========================================================================
  // LLM Configuration (EARLY - needed for query analysis)
  // Load LLM config first so we can use it to analyze the query
  // =========================================================================
  let config = await getLLMConfig();
  
  // Provide default config if none exists (first-time users)
  // Default to anthropic (Claude) - user provides their own API key.
  // For standalone mode, no server dependency.
  if (!config) {
    const modelName = await getDefaultLlmModel();
    config = {
      llm: "anthropic",
      modelName,
      apiKey: "",
      apiType: "chat-completion",
      options: { baseURL: "https://api.anthropic.com/v1" }
    };
    // Save the default config so it persists
    await chrome.storage.sync.set({ llmConfig: config });
  }
  
  // For standalone: API key is required for all providers
  // Users must provide their own API key (Claude, OpenAI, etc.)
  if (!config.apiKey) {
    logger.error("CONFIG_ERROR", "Missing API key configuration");
    logger.endSession('failed', undefined, 'Missing API key configuration');
    printLog("Please configure your API key in Settings (click the ⚙ gear icon).", "error");
    chrome.storage.local.set({ running: false });
    markWorkflowCompleted();
    clearInterval(swKeepAliveTimer);
    chrome.runtime.sendMessage({ type: "stop", correlationId, success: false, status: 'failed' });
    return;
  }

  // =========================================================================
  // Website Instructions Loading (Uses LLM to analyze query)
  // Only if useInstructions is enabled in settings
  // =========================================================================
  console.log("[WEBSAPE DEBUG] ========== INSTRUCTION LOADING START ==========");
  
  let instructionInfo: InstructionInfo | null = null;
  let enhancedPrompt = prompt;
  // Store instruction status to log AFTER clearProgress() to avoid being cleared
  let instructionStatusMessage: string | null = null;
  
  // Skip instruction loading if disabled in settings
  if (!featureToggles.useInstructions) {
    console.log("[WEBSAPE DEBUG] Instructions disabled in settings, skipping");
    instructionStatusMessage = `instruction_skipped reason=disabled_in_settings`;
    printLog(`ℹ️ Instructions loading disabled in settings`, "info");
  } else {
    try {
      // Standalone mode: no automatic domain detection
      // Users include domain/URL in their task prompt
      printLog(`ℹ️ Instructions: include website URL in your task prompt for best results`, "info");
      instructionStatusMessage = `instruction_skipped reason=standalone_mode`;
    } catch (error) {
      logger.warning("INSTRUCTION_ERROR", "Error in instruction handling", {
        error: String(error),
      });
      instructionStatusMessage = `instruction_error error=${String(error).substring(0, 50)}`;
    }
  }

  console.log("[WEBSAPE DEBUG] ========== INSTRUCTION LOADING END ==========");

  // Clear progress tracker for new session
  clearProgress();
  
  // Log instruction status AFTER clearProgress() so it persists in progress.json
  if (instructionStatusMessage) {
    logStatus(instructionStatusMessage);
    console.log("[WEBSAPE DEBUG] Logged instruction status after clearProgress:", instructionStatusMessage);
  }
  
  logger.info("SNAPSHOT_CONFIG", "Configured snapshot upload", {
    sessionId,
    serverUrl: snapshotServerUrl,
  });

  // Create execution tracer for collecting tool calls
  const tracer = new ExecutionTracer(
    sessionId,
    prompt,
    snapshotServerUrl
  );
  // Store reference for abort handling
  currentTracer = tracer;
  logger.info("TRACER_INIT", "Execution tracer initialized", { sessionId });

  // Token tracking for the entire workflow
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalTokens = 0;
  let totalCachedInputTokens = 0;
  let totalCacheCreationInputTokens = 0;
  let llmCallCount = 0;
  let hasEstimatedTokens = false;
  const llmCallDetails: Array<{
    callIndex: number;
    agentName: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cachedInputTokens?: number;
    cacheCreationInputTokens?: number;
    durationMs?: number;
    isEstimated: boolean;
  }> = [];

  // E2E latency tracking: capture the wall-clock start time before eko.run()
  const workflowStartedAt = Date.now();
  const workflowStartedAtIso = new Date(workflowStartedAt).toISOString();

  // LLM config was already loaded above for query analysis
  // Now we can use it for the tracer and Eko setup

  const useResponsesApi = config.apiType === "responses-api";
  
  // Set LLM config in tracer
  tracer.setLLMConfig(config.llm, config.modelName);

  // For standalone mode, use the provider as-is (no private mapping)
  const llmProvider = config.llm;

  logger.info("LLM_CONFIG", "LLM configuration loaded", {
    provider: config.llm,
    model: config.modelName,
    baseURL: config.options?.baseURL || "default",
    apiType: config.apiType,
  });

  // For standalone: no special auth headers needed (user provides API key directly)
  let llmHeaders: Record<string, string> = {};

  const llms: LLMs = {
    default: {
      provider: llmProvider as any,
      model: config.modelName,
      apiKey: config.apiKey || "proxy-managed",
      config: {
        baseURL: config.options.baseURL,
        useResponsesApi,
        headers: Object.keys(llmHeaders).length > 0 ? llmHeaders : undefined,
      },
    },
  };

  // Read disableHumanInteract setting (used by callbacks and agent construction)
  const disableHumanInteractResult = await chrome.storage.sync.get(["disableHumanInteract"]);
  const disableHumanInteract = disableHumanInteractResult.disableHumanInteract ?? (ekoConfig as any).disableHumanInteract ?? false;
  if (disableHumanInteract) {
    logger.info("CONFIG", "human_interact is DISABLED — callbacks will return defaults");
  }

  let callback: StreamCallback & HumanCallback = {
    // Expose validation failure methods from tracer to agent framework
    // This allows base.ts to check for validation failures before executing tools
    getValidationFailures: (toolId: string) => {
      return tracer.getEkoTracer().getValidationFailures(toolId);
    },
    formatValidationFailures: (failures: any, toolId: string) => {
      return tracer.getEkoTracer().formatValidationFailures(failures, toolId);
    },
    
    onMessage: async (message: StreamCallbackMessage) => {
      const streamDone = (message as any).streamDone;
      
      // Process message through tracer for trace collection
      tracer.processMessage(message);
      
      // Only log to extension logger when stream is done
      if (streamDone) {
        logger.debug("STREAM_MESSAGE", `Received message type: ${message.type}`, {
          messageType: message.type,
          streamDone: streamDone,
        });
      }

      if (message.type == "workflow") {
        // Only log to extension logger and send structured log when stream is done
        if (streamDone) {
          logger.logAgentPlanning(message.workflow.xml, {
            streamDone: streamDone,
          });
          // Send structured plan log to UI
          logger.logPlan(message.workflow.xml);
        }
        // Still print the raw plan for legacy log view
        printLog("Plan\n" + message.workflow.xml, "info", !(message as any).streamDone);
      } else if (message.type == "text") {
        // Only log to extension logger when stream is done
        if (streamDone) {
          logger.debug("LLM_TEXT_RESPONSE", "Text response received", {
            textLength: message.text.length,
            textPreview: message.text.substring(0, 100),
            streamDone: streamDone,
          });
          // Check if this looks like reasoning/thinking and log it
          const text = message.text.trim();
          if (text.length > 0) {
            // Log as reasoning if it's substantive text
            // Pass agentPrefix from multi-agent mode if available
            const agentPrefix = (message as any).agentPrefix;
            logger.logReasoning(text, agentPrefix);
          }
        }
        printLog(message.text, "info", !(message as any).streamDone);
      } else if (message.type == "tool_streaming") {
        // Skip logging for intermediate streaming messages - only log final tool_use
        printLog(`${message.agentName} > ${message.toolName}\n${message.paramsText}`, "info", true);
      } else if (message.type == "tool_use") {
        logger.logToolCall(message.agentName, message.toolName, message.params);
        // Send structured tool call log to UI with param sources and validation from tracer
        const ekoTracer = tracer.getEkoTracer();
        const paramSources = ekoTracer.getParameterSources(message.toolId);
        const validationFailures = ekoTracer.getValidationFailures(message.toolId);
        const paramSourceValidation = validationFailures && validationFailures.length > 0 
          ? { failures: validationFailures }
          : undefined;
        // Pass agentPrefix from multi-agent mode if available
        const agentPrefix = (message as any).agentPrefix;
        logger.logStructuredToolCall(
          message.agentName, 
          message.toolName, 
          message.toolId,
          message.params,
          paramSources,
          paramSourceValidation,
          agentPrefix
        );
        
        // Update plan steps based on task_snapshot doneIds
        if (message.toolName === "task_snapshot" && message.params?.doneIds) {
          const doneIds = message.params.doneIds as number[];
          logger.updatePlanStepsFromDoneIds(doneIds);
        }
        
        printLog(
          `${message.agentName} > ${message.toolName}\n${JSON.stringify(
            message.params
          )}`
        );
      } else if (message.type == "tool_result") {
        // Log tool results to help debug human interaction issues
        const resultFull = JSON.stringify(message.toolResult);
        const resultPreview = resultFull.substring(0, 200);
        // Extract pageStateChange from nested content[0].text structure
        let pageStateChange: { type?: string; details?: string } | undefined;
        try {
          const toolResultAny = message.toolResult as any;
          if (toolResultAny?.content?.[0]?.text) {
            const innerResult = JSON.parse(toolResultAny.content[0].text);
            if (innerResult?.pageStateChange) {
              pageStateChange = innerResult.pageStateChange;
            }
          }
        } catch (e) {
          // Failed to parse, ignore
        }
        // Extract action-landing-watchdog events from the TOP-LEVEL of the
        // toolResult wrapper (set by browser_labels.ts onAfterToolExecute when
        // `actionLandingWatchdog` is enabled). These never reach the LLM —
        // they're attached on the wrapper, not inside content[0].text — and
        // are persisted in progress.json for replay/analysis.
        const actionLandingEvents = (message.toolResult as any)?.actionLandingEvents as
          | Array<Record<string, any>>
          | undefined;
        logger.info("TOOL_RESULT", `Tool result for ${message.toolName}`, {
          toolName: message.toolName,
          resultPreview,
          pageStateChange,
          actionLandingEventCount: actionLandingEvents?.length ?? 0,
        });
        // Send structured tool result log to UI - use full result for debug portal
        // Pass agentPrefix from multi-agent mode if available
        const agentPrefixResult = (message as any).agentPrefix;
        logger.logStructuredToolResult(
          message.agentName || "Agent",
          message.toolName,
          resultFull,
          pageStateChange,
          agentPrefixResult,
          actionLandingEvents
        );
        printLog(`${message.agentName} < ${message.toolName} result: ${resultPreview}`, "info");
      } else if (message.type == "finish") {
        // Track token usage from LLM call completion
        const usage = (message as any).usage;
        if (usage) {
          const inputTokens = usage.promptTokens || 0;
          const outputTokens = usage.completionTokens || 0;
          const callTotalTokens = usage.totalTokens || (inputTokens + outputTokens);
          const cachedInputTokens = usage.cachedInputTokens || 0;
          const cacheCreationInputTokens = usage.cacheCreationInputTokens || 0;

          totalInputTokens += inputTokens;
          totalOutputTokens += outputTokens;
          totalTokens += callTotalTokens;
          totalCachedInputTokens += cachedInputTokens;
          totalCacheCreationInputTokens += cacheCreationInputTokens;
          llmCallCount++;
          if (usage.isEstimated) hasEstimatedTokens = true;
          llmCallDetails.push({
            callIndex: llmCallCount,
            agentName: message.agentName || "Agent",
            inputTokens,
            outputTokens,
            totalTokens: callTotalTokens,
            cachedInputTokens: cachedInputTokens || undefined,
            cacheCreationInputTokens: cacheCreationInputTokens || undefined,
            durationMs: usage.durationMs,
            isEstimated: usage.isEstimated || false,
          });

          // Update tracer with token usage
          tracer.updateTokenUsage(totalInputTokens, totalOutputTokens, totalTokens, llmCallCount);

          logger.debug("LLM_TOKENS", `LLM call #${llmCallCount} tokens`, {
            inputTokens,
            outputTokens,
            callTotalTokens,
            cachedInputTokens,
            cacheCreationInputTokens,
            isEstimated: usage.isEstimated || false,
            runningTotalInput: totalInputTokens,
            runningTotalOutput: totalOutputTokens,
            runningTotal: totalTokens,
          });
        }
      }
    },
    onHumanConfirm: async (context, prompt) => {
      if (disableHumanInteract) {
        logger.info("HUMAN_CONFIRM", "Auto-confirming (human_interact disabled)", { prompt });
        printLog(`🤖 [AUTO-CONFIRM] ${prompt} → true (human_interact disabled)`, "info");
        return true;
      }
      logger.info("HUMAN_CONFIRM", "User confirmation requested", {
        prompt,
        context,
      });
      printLog(`🙋 [CONFIRM REQUIRED] ${prompt}`, "info");
      try {
        const result = await doConfirm(prompt, context);
        logger.info("HUMAN_CONFIRM", `User responded: ${result ? "confirmed" : "denied"}`);
        printLog(`✅ User confirmed: ${result ? "Yes" : "No"}`, "info");
        return result;
      } catch (error) {
        logger.error("HUMAN_CONFIRM", `Error getting confirmation: ${error}`);
        printLog(`❌ Error getting confirmation: ${error}`, "error");
        return false;
      }
    },
    onHumanInput: async (context, prompt) => {
      if (disableHumanInteract) {
        logger.info("HUMAN_INPUT", "Auto-skipping input (human_interact disabled)", { prompt });
        printLog(`🤖 [AUTO-SKIP] ${prompt} → "" (human_interact disabled)`, "info");
        return "";
      }
      logger.info("HUMAN_INPUT", "User input requested", {
        prompt,
        context,
      });
      printLog(`🙋 [INPUT REQUIRED] ${prompt}`, "info");
      try {
        // For login-related inputs, show a simpler confirm dialog since user will log in manually
        if (prompt.toLowerCase().includes("login") || prompt.toLowerCase().includes("sign in") || prompt.toLowerCase().includes("password")) {
          printLog(`⏳ Please log in manually in the browser, then click OK in the dialog...`, "info");
          const confirmed = await doConfirm(`🔐 LOGIN REQUIRED\n\n${prompt}\n\nPlease log in manually in the browser.\nClick OK when done, or Cancel to skip.`, context);
          logger.info("HUMAN_INPUT", `User login action: ${confirmed ? "completed" : "skipped"}`);
          printLog(`✅ User login: ${confirmed ? "completed" : "skipped"}`, "info");
          return confirmed ? "User has logged in manually" : "User skipped login";
        }
        
        const result = await doPrompt(prompt, context);
        logger.info("HUMAN_INPUT", `User provided input: ${result ? result.substring(0, 50) : "(cancelled)"}`);
        printLog(`✅ User input received`, "info");
        return result || "";
      } catch (error) {
        logger.error("HUMAN_INPUT", `Error getting user input: ${error}`);
        printLog(`❌ Error getting input: ${error}`, "error");
        return "";
      }
    },
    onHumanSelect: async (context, prompt, options, multiple) => {
      if (disableHumanInteract) {
        logger.info("HUMAN_SELECT", "Auto-skipping selection (human_interact disabled)", { prompt, options });
        printLog(`🤖 [AUTO-SKIP] ${prompt} → [] (human_interact disabled)`, "info");
        return [];
      }
      logger.info("HUMAN_SELECT", "User selection requested", {
        prompt,
        options,
        multiple,
        context,
      });
      printLog(`🙋 [SELECT REQUIRED] ${prompt}\nOptions: ${options.join(", ")}`, "info");
      try {
        const result = await doSelect(prompt, options, multiple, context);
        logger.info("HUMAN_SELECT", `User selected: ${JSON.stringify(result)}`);
        printLog(`✅ User selected: ${JSON.stringify(result)}`, "info");
        return result;
      } catch (error) {
        logger.error("HUMAN_SELECT", `Error getting selection: ${error}`);
        printLog(`❌ Error getting selection: ${error}`, "error");
        return [];
      }
    },
    onHumanHelp: async (context, helpType, prompt) => {
      if (disableHumanInteract) {
        logger.info("HUMAN_HELP", "Auto-skipping help (human_interact disabled)", { helpType, prompt });
        // Still record in tracer for observability
        tracer.recordHumanHelp(helpType, prompt, context);
        printLog(`🤖 [AUTO-SKIP] ${helpType}: ${prompt} → false (human_interact disabled)`, "info");
        return false;
      }
      logger.info("HUMAN_HELP", "User assistance requested", {
        helpType,
        prompt,
        context,
      });
      
      // Record human help request in tracer (important for login flows)
      tracer.recordHumanHelp(helpType, prompt, context);
      
      printLog(`🙋 [${helpType.toUpperCase()}] ${prompt}`, "info");
      try {
        const result = await doHumanHelp(helpType, prompt, context);
        logger.info("HUMAN_HELP", `User resolved: ${result ? "yes" : "no"}`);
        printLog(`✅ User resolved: ${result ? "Yes" : "No"}`, "info");
        return result;
      } catch (error) {
        logger.error("HUMAN_HELP", `Error getting help: ${error}`);
        printLog(`❌ Error getting help: ${error}`, "error");
        return false;
      }
    },
  };

  // Log callback setup to verify all handlers are present
  logger.info("CALLBACK_SETUP", "Setting up callbacks", {
    hasOnMessage: typeof callback.onMessage === 'function',
    hasOnHumanConfirm: typeof callback.onHumanConfirm === 'function',
    hasOnHumanInput: typeof callback.onHumanInput === 'function',
    hasOnHumanSelect: typeof callback.onHumanSelect === 'function',
    hasOnHumanHelp: typeof callback.onHumanHelp === 'function',
    disableHumanInteract,
  });

  // Server endpoint already loaded at start of main()
  logger.info("SERVER_CONFIG", "Server configuration", {
    serverEndpoint: snapshotServerUrl,
    useInstructions: featureToggles.useInstructions,
    toolsVersion: featureToggles.toolsVersion,
  });

  // Standalone version: MCP Tool connection not available (no server)
  let toolClient: McpToolClient | undefined = undefined;
  logger.info("MCP_TOOL_CONNECT", "Tools not available in standalone mode");

  // Build agent tools: optionally exclude HumanInteractTool
  const extraTools: any[] = [];
  if (!disableHumanInteract) {
    const humanInteractTool = new HumanInteractTool();
    extraTools.push(humanInteractTool);
    logger.info("AGENT_INIT", "Initializing browser agent with HumanInteractTool");
  } else {
    logger.info("AGENT_INIT", "Initializing browser agent WITHOUT HumanInteractTool (disabled by config)");
  }

  // Use MCP tool client if available for additional tools
  const effectiveMcp = toolClient;
  let agents = [new BrowserAgent(undefined, extraTools, effectiveMcp)];
  
  logger.info("EKO_INIT", "Creating Eko instance", {
    hasToolClient: !!toolClient,
    effectiveMcpType: toolClient ? "tool" : "none"
  });
  let eko = new Eko({ llms, agents, callback });

  logger.info("EKO_RUN", "Starting Eko workflow execution");

  // Standalone: Load bundled experiences if enabled
  let selectedExperiences: any[] = [];
  let selectedExperienceReadCount = 0;
  let selectedExperienceSelectedCount = 0;

  if (featureToggles.useExperience) {
    try {
      const experienceData = await selectExperiencesFromServer({
        taskPrompt: prompt,
        experienceVersion: experienceVersion,
      });
      selectedExperiences = experienceData.experiences;
      selectedExperienceReadCount = experienceData.readCount;
      selectedExperienceSelectedCount = experienceData.selectedCount;
      logStatus(`experience_selected enabled=true read=${selectedExperienceReadCount} selected=${selectedExperienceSelectedCount} items=${selectedExperiences.length}`);
    } catch (error) {
      logger.error('EXPERIENCE_INIT', 'Failed to load experiences', { error: String(error) });
      logStatus('experience_selected enabled=true read=0 selected=0 items=0 error=failed');
    }
  } else {
    logStatus('experience_selected disabled=true read=0 selected=0 items=[]');
  }

  // Standalone: Build experience meta prompt with universal error recovery strategies
  const agentModeConfigEarly = await getAgentModeConfig();
  const useMultiAgentEarly = agentModeConfigEarly.mode === "multi";
  let experienceMetaPromptForMultiAgent = buildExperienceMetaPrompt();

  const ekoContextParams: Record<string, any> = {};

  // IMPORTANT: Capture sessionId before eko.run() to avoid race conditions
  // If a new task starts before this one's .then()/.catch() handlers complete,
  // logger.getCurrentSessionId() would return the NEW session's ID, causing
  // task_status to be uploaded to the wrong folder.
  const capturedSessionId = sessionId;
  // Also capture the original timestamp-based session ID for tracking in task_status.json
  const capturedOriginalSessionId = originalSessionId;
  // Capture snapshot context (resolverTaskId/dataset/taskId/serverUrl) for uploads
  const capturedSnapshotContext = { resolverTaskId, dataset, taskId, serverUrl: snapshotServerUrl };
  // Capture correlationId so the .then()/.catch() handlers include it in all
  // outgoing messages, allowing the sidebar to match responses to the correct entry
  const capturedCorrelationId = correlationId;
  
  // Log if we're using enhanced prompt with instructions
  if (instructionInfo?.found) {
    logger.info("EKO_PROMPT", "Running with website navigation instructions", {
      originalPromptLength: prompt.length,
      enhancedPromptLength: enhancedPrompt.length,
      instructionDomain: instructionInfo.matchedDomain,
    });
  }

  // Get agent mode configuration (already loaded earlier as agentModeConfigEarly)
  const agentModeConfig = agentModeConfigEarly;
  const useMultiAgent = useMultiAgentEarly;
  
  // Visible logging for agent mode - IMPORTANT: This should always appear
  console.log("🔧 [AGENT_MODE_CONFIG]", JSON.stringify(agentModeConfig, null, 2));
  printLog("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━", "info");
  printLog(`🔧 Agent Mode: ${agentModeConfig.mode.toUpperCase()} (useMultiAgent=${useMultiAgent})`, "info");
  printLog("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━", "info");
  
  logger.info("AGENT_MODE", `Using ${useMultiAgent ? 'multi-agent' : 'single-agent'} mode`, {
    mode: agentModeConfig.mode,
    multiAgentConfig: useMultiAgent ? agentModeConfig.multiAgentConfig : undefined,
  });

  // Reset workflow completed flag at the start of a new workflow
  resetWorkflowCompleted();

  // ── Create snapshot saver ────────────────────────────────────────────────
  // Scraper mode (localOutputDir set): always saves locally via chrome.downloads.
  // Quick trial mode: uploads to server only when debug mode is enabled.
  const debugEnabled = isDebugModeEnabled();
  console.log(`[Main] Creating snapshot saver: localOutputDir=${currentLocalOutputDir || '(not set)'}, debugMode=${debugEnabled}`);
  const saver = createSnapshotSaver(
    currentLocalOutputDir,
    snapshotServerUrl,
    taskId,
    resolverTaskId,
    dataset,
    debugEnabled,
  );
  console.log(`[Main] Saver created: ${saver ? saver.constructor.name : 'null (no persistence)'}`);

  // ── Write _prepare_done.json — signals that setup is complete ────────────
  // The resolver client watches for this file and resets its Phase 1 deadline
  // from this point forward, ensuring the full user-specified timeout applies
  // to actual agent work rather than including setup time.
  try {
    await saver?.writePrepareDoneSignal();
  } catch (e) {
    console.warn(`[Main] Failed to write _prepare_done.json: ${e}`);
  }

  // ── Self-contained timeout timer ──────────────────────────────────────────
  // The background owns the timeout so the sidebar doesn't need complex
  // message-based safety timeouts. When the timer fires it directly aborts
  // the eko/multi-agent workflow. The normal .catch() → .then() cleanup
  // path then handles uploads and sends the final "stop" message.
  //
  // The timer uses the FULL user-specified timeoutMs (no adjustment).
  // Setup time is NOT subtracted because the resolver client resets its own
  // Phase 1 deadline when it sees _prepare_done.json, so both timers are
  // now aligned.
  let entryTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  if (timeoutMs && timeoutMs > 0) {
    const timeoutMinutes = Math.round(timeoutMs / 60000);
    entryTimeoutTimer = setTimeout(async () => {
      // Only fire if the workflow hasn't already completed
      if (workflowCompleted) return;
      const reason = `Background timeout after ${timeoutMinutes} minutes`;
      lastAbortReason = reason;
      logger.info("WORKFLOW_TIMEOUT", reason, { timeoutMs });

      // Write _agent_done.json IMMEDIATELY from the timer — before waiting
      // for eko to abort and .catch() to fire.  This gives the resolver client
      // the earliest possible signal that the agent is done.
      try {
        await saver?.writeAgentDoneSignal('timeout');
      } catch (e) {
        console.warn(`[Main] Timer: failed to write _agent_done.json: ${e}`);
      }

      // Cancel pending human interactions
      cancelAllPendingInteractions().catch(() => {});
      // Abort multi-agent orchestrator if active
      if (currentMultiAgentOrchestrator) {
        currentMultiAgentOrchestrator.abort(reason);
      }
      // Abort all eko tasks
      try {
        eko.getAllTaskId().forEach((id: string) => {
          eko.abortTask(id);
        });
      } catch (err) {
        logger.warning("WORKFLOW_TIMEOUT", "Error during eko.abortTask()", { error: String(err) });
      }
    }, timeoutMs);
    logger.info("WORKFLOW_TIMEOUT", `Background timeout timer set`, { timeoutMs, timeoutMinutes });
  }

  // Multi-agent or single-agent execution
  if (useMultiAgent) {
    // Multi-Agent Mode: Use hierarchical orchestration
    const instructionConfig: InstructionConfig | undefined = featureToggles.useInstructions
      ? { serverUrl: snapshotServerUrl, version: featureToggles.instructionsVersion || undefined }
      : undefined;

    // Per-child experience selector: fetches relevant experiences for each
    // sub-task. This ensures the experience injected into a child agent is the
    // most relevant one for that sub-task, not just the user's overall prompt.
    // The orchestrator caches results by (domain, subTaskId) and falls back to
    // `parentExperiences` on error, timeout, or empty result.
    // Uses the same defaults as the parent-level selection (timeoutMs=60s,
    // maxRead=2000, maxInject=3); in practice there are rarely more than ~3
    // children per task, so the cumulative latency is bounded.
    const experienceSelectorForOrchestrator = featureToggles.useExperience
      ? async (taskPrompt: string) => {
          const r = await selectExperiencesFromServer({
            serverEndpoint: snapshotServerUrl,
            taskPrompt,
            experienceVersion,
          });
          return {
            experiences: r.experiences,
            readCount: r.readCount,
            selectedCount: r.selectedCount,
            error: r.error,
          };
        }
      : undefined;

    const multiAgentOrchestrator = createMultiAgentOrchestrator(
      llms,
      agents,
      callback,
      tracer,
      agentModeConfig.multiAgentConfig,
      instructionConfig,
      experienceMetaPromptForMultiAgent,
      featureToggles.useExperience ? selectedExperiences : [],
      experienceSelectorForOrchestrator,
    );
    
    // Store globally for abort handling
    currentMultiAgentOrchestrator = multiAgentOrchestrator;

    printLog("🔀 Running in Multi-Agent Mode", "info");
    logger.info("MULTI_AGENT_START", "Starting multi-agent orchestration");

    multiAgentOrchestrator
      .run(enhancedPrompt, ekoContextParams)
      .then(async (res) => {
        // Write _agent_done.json IMMEDIATELY — tells the resolver client that
        // the agent's main work is finished. Cleanup (snapshots, uploads,
        // _done.json) follows and may take minutes.
        {
          const pendingReason = lastAbortReason;
          const wasTimeoutEarly = !res.success && pendingReason?.toLowerCase().includes('timeout');
          const wasAbortEarly = !res.success && !wasTimeoutEarly && isAbortResult(pendingReason, res.result);
          const earlyStatus = res.success ? 'completed' : (wasTimeoutEarly ? 'timeout' : (wasAbortEarly ? 'aborted' : 'failed'));
          try { await saver?.writeAgentDoneSignal(earlyStatus); } catch (e) {
            console.warn(`[Main] Failed to write _agent_done.json: ${e}`);
          }
        }

        // Log total token usage for the workflow to UI
        logger.logTokenUsage(totalInputTokens, totalOutputTokens, totalTokens, llmCallCount);
        printLog(`📊 Token Usage: ${totalInputTokens.toLocaleString()} input + ${totalOutputTokens.toLocaleString()} output = ${totalTokens.toLocaleString()} total (${llmCallCount} LLM calls)`, "info");
        
        // Signal sidebar that cleanup is in progress (resets its safety timeout)
        chrome.runtime.sendMessage({ type: "cleanup_progress", phase: "success_handler_start", correlationId: capturedCorrelationId });
        
        const completedSessionId = capturedSessionId;
        const finalPageUrl = await getCurrentPageUrl();
        
        const pendingAbortReasonForLog = lastAbortReason;
        const wasTimeoutForLog = !res.success && pendingAbortReasonForLog?.toLowerCase().includes('timeout');
        const wasAbortForLog = !res.success && !wasTimeoutForLog && isAbortResult(pendingAbortReasonForLog, res.result);
        const statusForLog = res.success ? 'completed' : (wasTimeoutForLog ? 'timeout' : (wasAbortForLog ? 'aborted' : 'failed'));
        
        // ── Save all results (task_status + snapshots + _done.json) ─────────
        // NOTE: When adding a new config field, make sure to include it in all
        // taskStatus objects below (there are multiple: success, error, single-agent, multi-agent)
        // so it gets logged in task_status.json for every run.
        if (saver) {
          const taskStatus: Record<string, any> = {
            mode: ekoConfig.mode,
            markImageMode: ekoConfig.markImageMode,
            treeBuildMode: ekoConfig.treeBuildMode,
            includeNonIndexedElements: ekoConfig.includeNonIndexedElements,
            maxA11yElements: ekoConfig.maxA11yElements,
            viewportExpansion: ekoConfig.viewportExpansion,
            multiProbeIsTopElement: ekoConfig.multiProbeIsTopElement ?? false,
            actionLandingWatchdog: ekoConfig.actionLandingWatchdog ?? false,
            labelStyle: getLabelStyle(),
            serverUrl: snapshotServerUrl,
            instructions: featureToggles.useInstructions ? featureToggles.instructionsVersion : 'none',
            experience: featureToggles.useExperience ? experienceVersion : 'none',
            tools: featureToggles.toolsVersion || 'none',
            timestamp: new Date().toISOString(),
            extensionVersion: chrome.runtime.getManifest?.()?.version,
            buildInfo: BUILD_INFO,
            query: prompt,
            originalSessionId: capturedOriginalSessionId,
            finalPageUrl,
            status: statusForLog,
            agentMode: 'multi',
            agentType: 'websape-extension',
            llmName: config.modelName,
            compressTokensThreshold: getCompressTokensThresholdForModel(config.modelName),
            dynamicCompressThreshold: (ekoConfig as any).dynamicCompressThreshold ?? false,
            dynamicPlan: (ekoConfig as any).dynamicPlan ?? false,
            compressTriggerMessageCount: ekoConfig.compressThreshold,
            reason: res.success ? undefined : ((wasTimeoutForLog || wasAbortForLog) ? (pendingAbortReasonForLog || res.result) : res.result),
            startedAt: workflowStartedAtIso,
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - workflowStartedAt,
            tokenUsage: {
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
              totalTokens: totalTokens,
              cachedInputTokens: totalCachedInputTokens || undefined,
              cacheCreationInputTokens: totalCacheCreationInputTokens || undefined,
              llmCallCount: llmCallCount,
              isEstimated: hasEstimatedTokens,
              llmCalls: llmCallDetails,
            },
          };
          const consoleLogs = logger.getRunConsoleLogs();
          if (consoleLogs.length > 0) taskStatus.consoleLogs = consoleLogs;
          await saveWorkflowResults({
            saver,
            taskStatus,
            success: res.success,
            status: statusForLog,
            error: res.success ? undefined : res.result,
            sessionId: completedSessionId,
            correlationId: capturedCorrelationId,
          });
        }

        logger.endSession(statusForLog as any, res.result);
        logger.logWorkflowEnd(res.success, res.result);
        logger.logStatus(res.result, res.success ? "success" : (wasAbortForLog ? "warning" : "error"));
        if (res.result && typeof res.result === 'string' && res.result.trim()) {
          logger.logTextResponse(res.result);
        }
        printLog(res.result, res.success ? "success" : (wasAbortForLog ? "warning" : "error"));
        
        tracer.endSession(statusForLog as any);
        
        // Clear the multi-agent orchestrator reference
        currentMultiAgentOrchestrator = null;
        
        return { sessionId: completedSessionId, success: res.success, status: statusForLog };
      })
      .catch(async (error) => {
        // Write _agent_done.json IMMEDIATELY on error/abort path too
        {
          const errorStr0 = error?.toString() || '';
          const isAbort0 = errorStr0.includes('AbortError') || errorStr0.includes('Operation was interrupted');
          const reason0 = isAbort0 ? (lastAbortReason || 'aborted') : errorStr0;
          const isTimeout0 = reason0.toLowerCase().includes('timeout');
          const earlyStatus = isTimeout0 ? 'timeout' : (isAbort0 ? 'aborted' : 'failed');
          try { await saver?.writeAgentDoneSignal(earlyStatus); } catch (e) {
            console.warn(`[Main] Failed to write _agent_done.json (error path): ${e}`);
          }
        }

        logger.logTokenUsage(totalInputTokens, totalOutputTokens, totalTokens, llmCallCount);
        printLog(`📊 Token Usage: ${totalInputTokens.toLocaleString()} input + ${totalOutputTokens.toLocaleString()} output = ${totalTokens.toLocaleString()} total (${llmCallCount} LLM calls)`, "info");
        
        // Signal sidebar that cleanup is in progress (resets its safety timeout)
        chrome.runtime.sendMessage({ type: "cleanup_progress", phase: "error_handler_start", correlationId: capturedCorrelationId });
        
        const failedSessionId = capturedSessionId;
        const errorStr = error?.toString() || '';
        const isAbortError = errorStr.includes('AbortError') || errorStr.includes('Operation was interrupted');
        
        const abortReason = isAbortError ? consumeLastAbortReason() : errorStr;
        const finalPageUrl = await getCurrentPageUrl();
        
        const displayError = isAbortError ? abortReason : error;
        const logError = isAbortError ? abortReason : error;
        
        logger.endSession(isAbortError ? 'aborted' : 'failed', undefined, logError);
        logger.logWorkflowEnd(false, undefined, logError);
        logger.logStatus(isAbortError ? `⏹️ ${abortReason}` : `Error: ${errorStr}`, isAbortError ? "warning" : "error");
        
        if (!isAbortError) {
          logger.error("WORKFLOW_ERROR", "Multi-agent workflow execution failed", {
            error: errorStr,
            stack: error.stack,
          });
        } else {
          logger.info("WORKFLOW_ABORT", `Multi-agent workflow was aborted: ${abortReason}`);
        }
        printLog(displayError, isAbortError ? "warning" : "error");
        
        tracer.endSession('failed');
        
        // Clear the multi-agent orchestrator reference
        currentMultiAgentOrchestrator = null;
        
        const isTimeoutError = abortReason.toLowerCase().includes('timeout');
        const status = isTimeoutError ? 'timeout' : (isAbortError ? 'aborted' : 'failed');

        // ── Save all results on error ──────────────────────────────────────
        if (saver) {
          const taskStatus: Record<string, any> = {
            mode: ekoConfig.mode,
            markImageMode: ekoConfig.markImageMode,
            treeBuildMode: ekoConfig.treeBuildMode,
            viewportExpansion: ekoConfig.viewportExpansion,
            multiProbeIsTopElement: ekoConfig.multiProbeIsTopElement ?? false,
            actionLandingWatchdog: ekoConfig.actionLandingWatchdog ?? false,
            labelStyle: getLabelStyle(),
            timestamp: new Date().toISOString(),
            extensionVersion: chrome.runtime.getManifest?.()?.version,
            buildInfo: BUILD_INFO,
            query: prompt,
            finalPageUrl,
            status,
            agentMode: 'multi',
            agentType: 'websape-extension',
            llmName: config.modelName,
            compressTokensThreshold: getCompressTokensThresholdForModel(config.modelName),
            dynamicCompressThreshold: (ekoConfig as any).dynamicCompressThreshold ?? false,
            dynamicPlan: (ekoConfig as any).dynamicPlan ?? false,
            compressTriggerMessageCount: ekoConfig.compressThreshold,
            reason: abortReason || errorStr,
            startedAt: workflowStartedAtIso,
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - workflowStartedAt,
            tokenUsage: {
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
              totalTokens: totalTokens,
              cachedInputTokens: totalCachedInputTokens || undefined,
              cacheCreationInputTokens: totalCacheCreationInputTokens || undefined,
              llmCallCount: llmCallCount,
              isEstimated: hasEstimatedTokens,
              llmCalls: llmCallDetails,
            },
          };
          const consoleLogs = logger.getRunConsoleLogs();
          if (consoleLogs.length > 0) taskStatus.consoleLogs = consoleLogs;
          await saveWorkflowResults({
            saver,
            taskStatus,
            success: false,
            status,
            error: abortReason || errorStr,
            sessionId: failedSessionId,
            correlationId: capturedCorrelationId,
          });
        }

        return { sessionId: failedSessionId, success: false, status };
      })
      .then(async (result) => {
        logger.info("WORKFLOW_CLEANUP", "Cleaning up multi-agent workflow resources");
        chrome.runtime.sendMessage({ type: "cleanup_progress", phase: "cdp_cleanup", correlationId: capturedCorrelationId });
        try {
          try {
            await withTimeout(
              Promise.all([
                BrowserAgent.cleanupCDPSessions(),
                cdpManager.detachAll(),
              ]),
              CLEANUP_TIMEOUT_MS,
              'cleanupCDPSessions'
            );
          } catch (e) {
            logger.warning("WORKFLOW_CLEANUP", "Failed to cleanup CDP sessions", { error: String(e) });
          }
          currentTracer = null;
        } finally {
          // CRITICAL: markWorkflowCompleted and stop message MUST always fire.
          // If they don't, the sidebar never receives "stop", the processEntry timeout
          // fires, and the task gets incorrectly marked as timed out.
          if (entryTimeoutTimer) clearTimeout(entryTimeoutTimer);
          clearInterval(swKeepAliveTimer);
          markWorkflowCompleted();
          chrome.storage.local.set({ running: false });
          // No snapshot URL available in standalone mode (no server)
          const snapshotUrl: string | undefined = undefined;
          chrome.runtime.sendMessage({
            type: "stop",
            correlationId: capturedCorrelationId,
            sessionId: result.sessionId,
            success: result.success,
            status: result.status,
            snapshotUrl,
          });
        }
      });
  } else {
    // Single-Agent Mode: Traditional Eko execution
    // Log meta experience separately before running
    logger.info("META_EXPERIENCE", "Injecting universal error recovery strategies", {
      lessonCount: 1,
      firstLesson: "Retry with alternative strategy after 3 consecutive failures",
    });

    // Inject meta experience prompt for error recovery strategies
    const singleAgentPrompt = enhancedPrompt + "\n\n" + experienceMetaPromptForMultiAgent;

    eko
      // Use final prompt (instructions + meta experience + user prompt)
      .run(singleAgentPrompt, undefined, ekoContextParams)
      .then(async (res) => {
        // Write _agent_done.json IMMEDIATELY — tells the resolver client that
        // the agent's main work is finished. Cleanup (snapshots, uploads,
        // _done.json) follows and may take minutes.
        {
          const pendingReason = lastAbortReason;
          const wasTimeoutEarly = !res.success && pendingReason?.toLowerCase().includes('timeout');
          const wasAbortEarly = !res.success && !wasTimeoutEarly && isAbortResult(pendingReason, res.result);
          const earlyStatus = res.success ? 'completed' : (wasTimeoutEarly ? 'timeout' : (wasAbortEarly ? 'aborted' : 'failed'));
          try { await saver?.writeAgentDoneSignal(earlyStatus); } catch (e) {
            console.warn(`[Main] Failed to write _agent_done.json: ${e}`);
          }
        }

        // Log total token usage for the workflow to UI
        logger.logTokenUsage(totalInputTokens, totalOutputTokens, totalTokens, llmCallCount);
        printLog(`📊 Token Usage: ${totalInputTokens.toLocaleString()} input + ${totalOutputTokens.toLocaleString()} output = ${totalTokens.toLocaleString()} total (${llmCallCount} LLM calls)`, "info");
        
        // Signal sidebar that cleanup is in progress (resets its safety timeout)
        chrome.runtime.sendMessage({ type: "cleanup_progress", phase: "success_handler_start", correlationId: capturedCorrelationId });
        
        const completedSessionId = capturedSessionId;
        const finalPageUrl = await getCurrentPageUrl();
        
        const pendingAbortReasonForLog = lastAbortReason;
        const wasTimeoutForLog = !res.success && pendingAbortReasonForLog?.toLowerCase().includes('timeout');
        const wasAbortForLog = !res.success && !wasTimeoutForLog && isAbortResult(pendingAbortReasonForLog, res.result);
        const statusForLog = res.success ? 'completed' : (wasTimeoutForLog ? 'timeout' : (wasAbortForLog ? 'aborted' : 'failed'));
        
        // ── Save all results (task_status + snapshots + _done.json) ─────────
        if (saver) {
          const taskStatus: Record<string, any> = {
            mode: ekoConfig.mode,
            markImageMode: ekoConfig.markImageMode,
            treeBuildMode: ekoConfig.treeBuildMode,
            includeNonIndexedElements: ekoConfig.includeNonIndexedElements,
            maxA11yElements: ekoConfig.maxA11yElements,
            viewportExpansion: ekoConfig.viewportExpansion,
            multiProbeIsTopElement: ekoConfig.multiProbeIsTopElement ?? false,
            actionLandingWatchdog: ekoConfig.actionLandingWatchdog ?? false,
            labelStyle: getLabelStyle(),
            serverUrl: snapshotServerUrl,
            instructions: featureToggles.useInstructions ? featureToggles.instructionsVersion : 'none',
            experience: featureToggles.useExperience ? experienceVersion : 'none',
            tools: featureToggles.toolsVersion || 'none',
            timestamp: new Date().toISOString(),
            extensionVersion: chrome.runtime.getManifest?.()?.version,
            buildInfo: BUILD_INFO,
            query: prompt,
            originalSessionId: capturedOriginalSessionId,
            finalPageUrl,
            status: statusForLog,
            agentType: 'websape-extension',
            llmName: config.modelName,
            compressTokensThreshold: getCompressTokensThresholdForModel(config.modelName),
            dynamicCompressThreshold: (ekoConfig as any).dynamicCompressThreshold ?? false,
            dynamicPlan: (ekoConfig as any).dynamicPlan ?? false,
            compressTriggerMessageCount: ekoConfig.compressThreshold,
            reason: res.success ? undefined : ((wasTimeoutForLog || wasAbortForLog) ? (pendingAbortReasonForLog || res.result) : res.result),
            startedAt: workflowStartedAtIso,
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - workflowStartedAt,
            tokenUsage: {
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
              totalTokens: totalTokens,
              cachedInputTokens: totalCachedInputTokens || undefined,
              cacheCreationInputTokens: totalCacheCreationInputTokens || undefined,
              llmCallCount: llmCallCount,
              isEstimated: hasEstimatedTokens,
              llmCalls: llmCallDetails,
            },
          };
          const consoleLogs = logger.getRunConsoleLogs();
          if (consoleLogs.length > 0) taskStatus.consoleLogs = consoleLogs;
          await saveWorkflowResults({
            saver,
            taskStatus,
            success: res.success,
            status: statusForLog,
            error: res.success ? undefined : res.result,
            sessionId: completedSessionId,
            correlationId: capturedCorrelationId,
          });
        }

        logger.endSession(statusForLog as any, res.result);
        logger.logWorkflowEnd(res.success, res.result);
        logger.logStatus(res.result, res.success ? "success" : (wasAbortForLog || wasTimeoutForLog ? "warning" : "error"));
        if (res.result && typeof res.result === 'string' && res.result.trim()) {
          logger.logTextResponse(res.result);
        }
        printLog(res.result, res.success ? "success" : (wasAbortForLog ? "warning" : "error"));
      
      // End trace session
      tracer.endSession(statusForLog as any);
      
      // Return session ID and status for cleanup block
      return { sessionId: completedSessionId, success: res.success, status: statusForLog };
    })
    .catch(async (error) => {
      // Write _agent_done.json IMMEDIATELY on error/abort path too
      {
        const errorStr0 = error?.toString() || '';
        const isAbort0 = errorStr0.includes('AbortError') || errorStr0.includes('Operation was interrupted');
        const reason0 = isAbort0 ? (lastAbortReason || 'aborted') : errorStr0;
        const isTimeout0 = reason0.toLowerCase().includes('timeout');
        const earlyStatus = isTimeout0 ? 'timeout' : (isAbort0 ? 'aborted' : 'failed');
        try { await saver?.writeAgentDoneSignal(earlyStatus); } catch (e) {
          console.warn(`[Main] Failed to write _agent_done.json (error path): ${e}`);
        }
      }

      // Log total token usage even on error to UI
      logger.logTokenUsage(totalInputTokens, totalOutputTokens, totalTokens, llmCallCount);
      printLog(`📊 Token Usage: ${totalInputTokens.toLocaleString()} input + ${totalOutputTokens.toLocaleString()} output = ${totalTokens.toLocaleString()} total (${llmCallCount} LLM calls)`, "info");
      
      chrome.runtime.sendMessage({ type: "cleanup_progress", phase: "error_handler_start", correlationId: capturedCorrelationId });
      
      const failedSessionId = capturedSessionId;
      const errorStr = error?.toString() || '';
      const isAbortError = errorStr.includes('AbortError') || errorStr.includes('Operation was interrupted');
      const abortReason = isAbortError ? consumeLastAbortReason() : errorStr;
      const finalPageUrl = await getCurrentPageUrl();
      
      const displayError = isAbortError ? abortReason : error;
      const logError = isAbortError ? abortReason : error;
      
      logger.endSession(isAbortError ? 'aborted' : 'failed', undefined, logError);
      logger.logWorkflowEnd(false, undefined, logError);
      logger.logStatus(isAbortError ? `⏹️ ${abortReason}` : `Error: ${errorStr}`, isAbortError ? "warning" : "error");
      
      if (!isAbortError) {
        logger.error("WORKFLOW_ERROR", "Workflow execution failed", {
          error: errorStr,
          stack: error.stack,
        });
      } else {
        logger.info("WORKFLOW_ABORT", `Workflow was aborted: ${abortReason}`);
      }
      printLog(displayError, isAbortError ? "warning" : "error");
      
      tracer.endSession('failed');
      
      const isTimeoutError = abortReason.toLowerCase().includes('timeout');
      const status = isTimeoutError ? 'timeout' : (isAbortError ? 'aborted' : 'failed');
      
      // ── Save all results on error ──────────────────────────────────────
      if (saver) {
        const taskStatus: Record<string, any> = {
          mode: ekoConfig.mode,
          markImageMode: ekoConfig.markImageMode,
          treeBuildMode: ekoConfig.treeBuildMode,
          viewportExpansion: ekoConfig.viewportExpansion,
          multiProbeIsTopElement: ekoConfig.multiProbeIsTopElement ?? false,
          actionLandingWatchdog: ekoConfig.actionLandingWatchdog ?? false,
          labelStyle: getLabelStyle(),
          timestamp: new Date().toISOString(),
          extensionVersion: chrome.runtime.getManifest?.()?.version,
          buildInfo: BUILD_INFO,
          query: prompt,
          finalPageUrl,
          status,
          agentType: 'websape-extension',
          llmName: config.modelName,
          compressTokensThreshold: getCompressTokensThresholdForModel(config.modelName),
          dynamicCompressThreshold: ekoConfig.dynamicCompressThreshold ?? false,
          dynamicPlan: (ekoConfig as any).dynamicPlan ?? false,
          compressTriggerMessageCount: ekoConfig.compressThreshold,
          reason: abortReason || errorStr,
          startedAt: workflowStartedAtIso,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - workflowStartedAt,
          tokenUsage: {
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            totalTokens: totalTokens,
            cachedInputTokens: totalCachedInputTokens || undefined,
            cacheCreationInputTokens: totalCacheCreationInputTokens || undefined,
            llmCallCount: llmCallCount,
            isEstimated: hasEstimatedTokens,
            llmCalls: llmCallDetails,
          },
        };
        const consoleLogs = logger.getRunConsoleLogs();
        if (consoleLogs.length > 0) taskStatus.consoleLogs = consoleLogs;
        await saveWorkflowResults({
          saver,
          taskStatus,
          success: false,
          status,
          error: abortReason || errorStr,
          sessionId: failedSessionId,
          correlationId: capturedCorrelationId,
        });
      }

      return { sessionId: failedSessionId, success: false, status };
    })
    .then(async (result) => {
      logger.info("WORKFLOW_CLEANUP", "Cleaning up workflow resources");
      chrome.runtime.sendMessage({ type: "cleanup_progress", phase: "cdp_cleanup", correlationId: capturedCorrelationId });
      try {
        // Clean up CDP sessions to dismiss debugger banner
        try {
          await withTimeout(
            Promise.all([
              BrowserAgent.cleanupCDPSessions(),
              cdpManager.detachAll(),
            ]),
            CLEANUP_TIMEOUT_MS,
            'cleanupCDPSessions'
          );
        } catch (e) {
          logger.warning("WORKFLOW_CLEANUP", "Failed to cleanup CDP sessions", { error: String(e) });
        }
        // Clear current tracer reference
        currentTracer = null;
      } finally {
        // CRITICAL: markWorkflowCompleted and stop message MUST always fire.
        // If they don't, the sidebar never receives "stop", the processEntry timeout
        // fires, and the task gets incorrectly marked as "User manually cancelled".
        if (entryTimeoutTimer) clearTimeout(entryTimeoutTimer);
        clearInterval(swKeepAliveTimer);
        markWorkflowCompleted();
        chrome.storage.local.set({ running: false });
        // No snapshot URL in standalone mode
        const snapshotUrl: string | undefined = undefined;
        // Send stop with session ID and status
        chrome.runtime.sendMessage({
          type: "stop",
          correlationId: capturedCorrelationId,
          sessionId: result.sessionId,
          success: result.success,
          status: result.status,
          snapshotUrl,
        });
      }
    });
  }  // End of single-agent mode else block
  return eko;
}

// Helper function to get the correct tab ID from the agentContext (same logic as BrowserAgent)
async function getTabIdFromContext(agentContext: any): Promise<number | null> {
  try {
    // First try to get windowId from agentContext.variables (set by BrowserAgent during navigation)
    let windowId = agentContext?.variables?.get?.("windowId") as number | undefined;
    
    if (!windowId) {
      // Fallback: get last focused window
      let window = await chrome.windows.getLastFocused({
        windowTypes: ["normal"],
      });
      if (window) {
        windowId = window.id;
      }
    }
    
    if (windowId) {
      // Get the active tab in the correct window
      let tabs = (await chrome.tabs.query({
        windowId: windowId,
        active: true,
        windowType: "normal",
      })) as any[];
      
      if (tabs.length === 0) {
        // Fallback: get any tab in the window
        tabs = (await chrome.tabs.query({
          windowId: windowId,
          windowType: "normal",
        })) as any[];
      }
      
      if (tabs.length > 0) {
        const tabId = tabs[tabs.length - 1].id as number;
        logger.info("TAB_RESOLUTION", `Resolved tab from agentContext`, {
          windowId,
          tabId,
          tabUrl: tabs[tabs.length - 1].url,
        });
        return tabId;
      }
    }
    
    // Last resort: get currently active tab
    let tabs = (await chrome.tabs.query({
      active: true,
      windowType: "normal",
    })) as any[];
    
    if (tabs.length > 0) {
      logger.info("TAB_RESOLUTION", `Falling back to active tab (no agentContext windowId)`, {
        tabId: tabs[0].id,
        tabUrl: tabs[0].url,
      });
      return tabs[0].id;
    }
    
    return null;
  } catch (error) {
    logger.error("TAB_RESOLUTION", `Error getting tab from context: ${error}`);
    return null;
  }
}

async function doConfirm(prompt: string, agentContext?: any): Promise<boolean> {
  try {
    logger.info("HUMAN_CONFIRM", "Requesting confirmation via extension UI", { prompt });
    printLog(`🙋 [CONFIRM REQUIRED] ${prompt}`, "info");
    
    // Use extension UI instead of website window.confirm
    const result = await requestConfirm(prompt);
    
    logger.info("HUMAN_CONFIRM", `User responded: ${result ? "confirmed" : "denied"}`);
    return result;
  } catch (error) {
    logger.error("HUMAN_CONFIRM", `doConfirm error: ${error}`);
    return false;
  }
}

async function doPrompt(prompt: string, agentContext?: any): Promise<string | null> {
  try {
    logger.info("HUMAN_INPUT", "Requesting input via extension UI", { prompt });
    printLog(`🙋 [INPUT REQUIRED] ${prompt}`, "info");
    
    // Use extension UI instead of website window.prompt
    const result = await requestInput(prompt);
    
    logger.info("HUMAN_INPUT", `User provided input: ${result ? result.substring(0, 50) : "(cancelled)"}`);
    return result;
  } catch (error) {
    logger.error("HUMAN_INPUT", `doPrompt error: ${error}`);
    throw error;
  }
}

async function doSelect(prompt: string, options: string[], multiple?: boolean, agentContext?: any): Promise<string[]> {
  try {
    logger.info("HUMAN_SELECT", "Requesting selection via extension UI", { prompt, options, multiple });
    printLog(`🙋 [SELECT REQUIRED] ${prompt}\nOptions: ${options.join(", ")}`, "info");
    
    // Use extension UI instead of website window.prompt
    const result = await requestSelect(prompt, options, multiple);
    
    logger.info("HUMAN_SELECT", `User selected: ${JSON.stringify(result)}`);
    return result;
  } catch (error) {
    logger.error("HUMAN_SELECT", `doSelect error: ${error}`);
    return [];
  }
}

async function doHumanHelp(helpType: "request_login" | "request_assistance", prompt: string, agentContext?: any): Promise<boolean> {
  try {
    logger.info("HUMAN_HELP", `Requesting help via extension UI`, { helpType, prompt });
    printLog(`⏳ Waiting for user action in extension panel...`, "info");
    
    // Use extension UI instead of website window.confirm
    const result = await requestHelp(helpType, prompt);
    
    logger.info("HUMAN_HELP", `User responded: ${result ? "completed" : "skipped"}`);
    if (result) {
      printLog(`✅ User confirmed action completed`, "success");
    } else {
      printLog(`⏭️ User skipped the action`, "info");
    }
    
    return result;
  } catch (error) {
    logger.error("HUMAN_HELP", `doHumanHelp error: ${error}`);
    printLog(`❌ Error in doHumanHelp: ${error}`, "error");
    return false;
  }
}

function printLog(
  message: string,
  level?: "info" | "success" | "error" | "warning",
  stream?: boolean
) {
  // Convert message to string and filter out empty messages
  const logMessage = message + "";
  if (!logMessage || logMessage.trim() === "" || logMessage === "undefined" || logMessage === "null") {
    return; // Don't send empty or invalid log messages
  }
  
  chrome.runtime.sendMessage({
    type: "log",
    log: logMessage,
    level: level || "info",
    stream,
  });
}
