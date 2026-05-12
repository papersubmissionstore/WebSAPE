/**
 * Snapshot uploader module for accumulating screenshots and DOM content in memory.
 * This module accumulates debug snapshots during browser agent execution.
 * The extension is responsible for uploading accumulated snapshots to the server.
 * 
 * DEFERRED UPLOAD MODE:
 * - All snapshots (progress, screenshots, DOM) are stored in memory during execution
 * - Extension calls getAccumulatedSnapshots() to retrieve data for upload
 * - Extension handles the actual HTTP upload and file naming
 */

// Module-level debug mode flag (controlled by extension via setDebugModeEnabled)
let debugModeEnabled: boolean = true;

// Accumulated snapshots storage
let accumulatedSnapshots: AccumulatedSnapshot[] = [];

/**
 * Enable or disable debug mode for snapshot accumulation.
 * When enabled, screenshots and DOM are accumulated in memory.
 */
export function setDebugModeEnabled(enabled: boolean): void {
  debugModeEnabled = enabled;
  console.log(`[Snapshot Uploader] Debug mode ${enabled ? 'enabled' : 'disabled'}`);
}

/**
 * Check if debug mode is currently enabled.
 */
export function isDebugModeEnabled(): boolean {
  return debugModeEnabled;
}

export interface SnapshotUploadContext {
  stepNumber: string;
  toolCallId: string;
}

export interface ScreenshotData {
  imageBase64: string;
  imageType?: "image/jpeg" | "image/png";
}

/**
 * Accumulated snapshot file to be uploaded
 */
export interface AccumulatedSnapshot {
  filename: string;
  type: string;
  mimeType: string;
  data: string; // Base64 encoded
  /** Step number for custom file naming by extension */
  stepNumber?: string;
  /** Tool call ID for custom file naming by extension */
  toolCallId?: string;
}

/**
 * Error categories for categorized error logging
 */
export type ErrorCategory = 
  | 'abort'           // User manually cancelled / AbortError
  | 'api_error'       // AI_APICallError, Bad Request, etc.
  | 'screenshot'      // Failed to capture tab, image readback failed
  | 'frame_error'     // Frame with ID showing error page
  | 'element_error'   // Element resolution failed, pointer-events:none
  | 'network'         // Network errors, timeouts
  | 'unknown';        // Uncategorized errors

/**
 * Progress entry representing a tool call or result
 */
export interface ProgressEntry {
  id: string;
  timestamp: string;
  type: 'reasoning' | 'tool_call' | 'tool_result' | 'error' | 'status' | 'planning_result' | 'result_summary' | 'workflow_error' | 'sub_task_start' | 'sub_task_end' | 'parent_planning' | 'page_drift';
  parentPlanningData?: ParentPlanningData;  // Parent agent planning data
  agentName?: string;
  agentPrefix?: string;  // Multi-agent prefix like "[Child #1]" or "[Parent]"
  subTaskId?: string;    // Sub-task ID for multi-agent workflows
  subTaskDescription?: string;  // Human-readable sub-task description
  toolName?: string;
  toolId?: string;
  toolParams?: Record<string, any>;
  toolResult?: string;
  reasoning?: string;
  message?: string;
  isError?: boolean;
  planningResult?: string;  // The planning/workflow XML result
  resultSummary?: string;   // Final result summary from workflow execution
  success?: boolean;        // Whether the execution was successful (for result_summary)
  errorCategory?: ErrorCategory;  // Categorized error type
  errorMessage?: string;    // Full error message
  errorStack?: string;      // Error stack trace if available
  // Inference-time page drift: page changes between last tool completion and this tool's start
  inferenceTimePageDrift?: {
    hasDrift: boolean;
    timeSinceLastSnapshotMs: number;
    addedCount: number;
    removedCount: number;
    modifiedCount: number;
    summary: string;
    details: string[];  // Top change descriptions
  };
}

/**
 * Progress tracker for accumulating tool call progress
 * 
 * IMPORTANT: Session ID is captured at initialization/clear time to prevent race conditions.
 * When tasks timeout and new tasks start, the async handlers from the old task would
 * otherwise pick up the new task's session ID. By capturing the session ID when
 * clearProgress() is called (at task start), all entries for that task will be uploaded
 * to the correct session folder.
 * 
 * MULTI-AGENT SUPPORT: For multi-agent workflows, use createScopedProgressTracker() to
 * create isolated progress trackers for child agents. Each scoped tracker has its own
 * entries and session context, preventing mixing of progress between parent and children.
 */
class ProgressTracker {
  private entries: ProgressEntry[] = [];
  private entryCounter: number = 0;
  // Capture session ID at clear/init time to prevent race conditions with async handlers
  private capturedSessionId: string = '';
  private capturedServerUrl: string = '';
  // Optional scope identifier for multi-agent support
  private scopeId: string = '';
  // Whether this is a scoped (child) tracker that should not upload independently
  private isScoped: boolean = false;
  // Parent tracker reference for scoped trackers (to optionally forward entries)
  private parentTracker: ProgressTracker | null = null;
  
  constructor(scopeId?: string, parentTracker?: ProgressTracker) {
    if (scopeId) {
      this.scopeId = scopeId;
      this.isScoped = true;
      this.parentTracker = parentTracker || null;
    }
  }
  
  /**
   * Add a progress entry (no immediate upload - deferred)
   */
  addEntry(entry: Omit<ProgressEntry, 'id' | 'timestamp'>): void {
    const fullEntry: ProgressEntry = {
      ...entry,
      id: `${this.scopeId ? this.scopeId + '_' : ''}entry_${Date.now()}_${++this.entryCounter}`,
      timestamp: new Date().toISOString(),
    };
    this.entries.push(fullEntry);
    
  }
  
  /**
   * Clear all entries (for new session)
   */
  clear(): void {
    this.entries = [];
    this.entryCounter = 0;
    console.log('[Progress Tracker] Cleared');
  }
  
  /**
   * Set the scope ID for this tracker (used in multi-agent scenarios)
   */
  setScopeId(scopeId: string): void {
    this.scopeId = scopeId;
  }
  
  /**
   * Get the current scope ID
   */
  getScopeId(): string {
    return this.scopeId;
  }
  
  /**
   * Get all entries
   */
  getEntries(): ProgressEntry[] {
    return [...this.entries];
  }
  
  /**
   * Clear entries only (for memory release after upload)
   */
  clearEntries(): void {
    const count = this.entries.length;
    this.entries = [];
    console.log(`[Progress Tracker] Cleared ${count} entries from memory`);
  }
  
  /**
   * Get progress data as accumulated snapshot
   */
  getProgressSnapshot(): AccumulatedSnapshot | null {
    if (!debugModeEnabled || this.entries.length === 0) {
      return null;
    }
    
    const progressData = {
      scopeId: this.scopeId || undefined,
      timestamp: new Date().toISOString(),
      entries: this.entries,
      entryCount: this.entries.length,
    };
    
    const filename = this.scopeId ? `progress_${this.scopeId}.json` : 'progress.json';
    
    return {
      filename,
      type: 'progress',
      mimeType: 'application/json',
      data: btoa(unescape(encodeURIComponent(JSON.stringify(progressData, null, 2)))),
    };
  }
  
  /**
   * Merge entries from a scoped (child) tracker into this tracker
   * Used when child agent completes to consolidate progress
   */
  mergeFromScoped(scopedTracker: ProgressTracker): void {
    const scopedEntries = scopedTracker.getEntries();
    for (const entry of scopedEntries) {
      this.entries.push(entry);
    }
  }
}

// Singleton progress tracker instance (main tracker)
const progressTracker = new ProgressTracker();

// Map of scoped trackers for multi-agent support
const scopedTrackers = new Map<string, ProgressTracker>();

/**
 * Create a scoped progress tracker for multi-agent scenarios.
 * Each child agent can have its own isolated progress tracker.
 * @param scopeId Unique identifier for this scope (e.g., "child_1", "subtask_abc")
 * @returns A scoped ProgressTracker instance
 */
export function createScopedProgressTracker(scopeId: string): ProgressTracker {
  const scopedTracker = new ProgressTracker(scopeId, progressTracker);
  // Copy captured session info from main tracker
  scopedTracker.clear(); // This will capture current session info
  scopedTrackers.set(scopeId, scopedTracker);
  console.log('[Progress Tracker] Created scoped tracker:', scopeId);
  return scopedTracker;
}

/**
 * Get an existing scoped progress tracker
 */
export function getScopedProgressTracker(scopeId: string): ProgressTracker | undefined {
  return scopedTrackers.get(scopeId);
}

/**
 * Merge a scoped tracker's entries into the main tracker and clean up
 */
export function mergeScopedTracker(scopeId: string): void {
  const scopedTracker = scopedTrackers.get(scopeId);
  if (scopedTracker) {
    progressTracker.mergeFromScoped(scopedTracker);
    scopedTrackers.delete(scopeId);
    console.log('[Progress Tracker] Merged and removed scoped tracker:', scopeId);
  }
}

/**
 * Get the main (singleton) progress tracker
 */
export function getMainProgressTracker(): ProgressTracker {
  return progressTracker;
}

/**
 * Log reasoning/thinking from LLM
 */
export function logReasoning(reasoning: string): void {
  if (!reasoning || reasoning.trim() === '') return;
  progressTracker.addEntry({
    type: 'reasoning',
    reasoning,
  });
}

/**
 * Log a tool call with parameters
 */
export function logToolCall(
  agentName: string,
  toolName: string,
  toolId: string,
  params: Record<string, any>,
  agentPrefix?: string
): void {
  progressTracker.addEntry({
    type: 'tool_call',
    agentName,
    agentPrefix,
    toolName,
    toolId,
    toolParams: params,
  });
}

/**
 * Log a tool result
 */
export function logToolResult(
  agentName: string,
  toolName: string,
  toolId: string,
  result: string,
  isError: boolean = false,
  agentPrefix?: string
): void {
  progressTracker.addEntry({
    type: isError ? 'error' : 'tool_result',
    agentName,
    agentPrefix,
    toolName,
    toolId,
    toolResult: result, // Full result for debug portal
    isError,
  });
}

/**
 * Log a status message
 */
export function logStatus(message: string, agentPrefix?: string): void {
  progressTracker.addEntry({
    type: 'status',
    agentPrefix,
    message,
  });
}

/**
 * Log inference-time drift detected before tool execution.
 * Measures how much the page changed between the last tool's completion
 * and this tool's start (i.e., during LLM inference/thinking time).
 * Skipped for parallel tool calls since concurrent mutations make drift measurement meaningless.
 */
export function logInferenceTimePageDrift(
  agentName: string,
  toolName: string,
  toolId: string,
  drift: {
    hasDrift: boolean;
    timeSinceLastSnapshotMs: number;
    addedCount: number;
    removedCount: number;
    modifiedCount: number;
    summary: string;
    details: string[];
  },
  agentPrefix?: string
): void {
  progressTracker.addEntry({
    type: 'page_drift',
    agentName,
    agentPrefix,
    toolName,
    toolId,
    inferenceTimePageDrift: drift,
    message: drift.hasDrift ? drift.summary : 'No inference-time drift detected',
  });
}

/**
 * Log a sub-task start event (for multi-agent workflows)
 */
export function logSubTaskStart(
  subTaskId: string,
  description: string,
  agentPrefix: string,
  successCriteria?: string
): void {
  progressTracker.addEntry({
    type: 'sub_task_start',
    subTaskId,
    subTaskDescription: description,
    agentPrefix,
    message: successCriteria ? `Success criteria: ${successCriteria}` : undefined,
  });
}

/**
 * Data structure for parent agent planning
 */
export interface ParentPlanningData {
  iteration: number;
  maxIterations: number;
  subTasks: Array<{
    id: string;
    description: string;
    successCriteria?: string;
  }>;
}

/**
 * Log parent agent planning event (for multi-agent workflows)
 */
export function logParentPlanning(
  iteration: number,
  maxIterations: number,
  subTasks: Array<{ id: string; description: string; successCriteria?: string }>
): void {
  progressTracker.addEntry({
    type: 'parent_planning',
    agentPrefix: '[Parent]',
    parentPlanningData: {
      iteration,
      maxIterations,
      subTasks,
    },
    message: `Planning iteration ${iteration}/${maxIterations}: Decomposed into ${subTasks.length} sub-task(s)`,
  });
}

/**
 * Log a sub-task end event (for multi-agent workflows)
 */
export function logSubTaskEnd(
  subTaskId: string,
  agentPrefix: string,
  success: boolean,
  summary?: string
): void {
  progressTracker.addEntry({
    type: 'sub_task_end',
    subTaskId,
    agentPrefix,
    success,
    message: summary,
  });
}

/**
 * Categorize an error based on its message/type
 */
export function categorizeError(error: any): ErrorCategory {
  const errorStr = error?.toString() || '';
  const errorMessage = error?.message || errorStr;
  const errorName = error?.name || '';
  
  // Abort errors - user manually cancelled
  if (errorName === 'AbortError' || 
      errorMessage.includes('AbortError') || 
      errorMessage.includes('Operation was interrupted')) {
    return 'abort';
  }
  
  // API errors - AI service failures
  if (errorName === 'AI_APICallError' || 
      errorMessage.includes('AI_APICallError') ||
      errorMessage.includes('Bad Request') ||
      errorMessage.includes('API') ||
      errorMessage.includes('rate limit') ||
      errorMessage.includes('429') ||
      errorMessage.includes('500') ||
      errorMessage.includes('503')) {
    return 'api_error';
  }
  
  // Screenshot/capture errors
  if (errorMessage.includes('Failed to capture tab') ||
      errorMessage.includes('image readback failed') ||
      errorMessage.includes('captureVisibleTab') ||
      errorMessage.includes('screenshot')) {
    return 'screenshot';
  }
  
  // Frame errors
  if (errorMessage.includes('Frame with ID') ||
      errorMessage.includes('showing error page') ||
      errorMessage.includes('frame not found')) {
    return 'frame_error';
  }
  
  // Element resolution errors
  if (errorMessage.includes('Element resolution failed') ||
      errorMessage.includes('pointer-events:none') ||
      errorMessage.includes('Element not found') ||
      errorMessage.includes('Element found but') ||
      errorMessage.includes('Hover failed') ||
      errorMessage.includes('Click failed') ||
      errorMessage.includes('cannot receive clicks')) {
    return 'element_error';
  }
  
  // Network errors
  if (errorMessage.includes('network') ||
      errorMessage.includes('timeout') ||
      errorMessage.includes('ECONNREFUSED') ||
      errorMessage.includes('ETIMEDOUT') ||
      errorMessage.includes('fetch failed')) {
    return 'network';
  }
  
  return 'unknown';
}

/**
 * Log a workflow-level error with categorization
 * This is for high-level errors that affect the entire workflow execution
 */
export function logWorkflowError(
  error: any,
  agentName?: string,
  toolName?: string,
  toolId?: string
): void {
  const errorStr = error?.toString() || 'Unknown error';
  const errorMessage = error?.message || errorStr;
  const errorStack = error?.stack;
  const category = categorizeError(error);
  
  progressTracker.addEntry({
    type: 'workflow_error',
    errorCategory: category,
    errorMessage: errorMessage,
    errorStack: errorStack,
    agentName,
    toolName,
    toolId,
    isError: true,
  });
  
  console.log(`[Progress Tracker] Logged workflow error: category=${category}, message=${errorMessage.substring(0, 100)}`);
}

/**
 * Log the planning/workflow result
 */
export function logPlanningResult(planningResult: string): void {
  if (!planningResult || planningResult.trim() === '') return;
  progressTracker.addEntry({
    type: 'planning_result',
    planningResult,
  });
}

/**
 * Log the final result summary from workflow execution
 */
export function logResultSummary(resultSummary: string, success: boolean = true): void {
  if (!resultSummary || resultSummary.trim() === '') return;
  progressTracker.addEntry({
    type: 'result_summary',
    resultSummary,
    success,
  });
}

/**
 * Clear progress for new session.
 * Clears accumulated snapshots as well.
 */
export function clearProgress(): void {
  progressTracker.clear();
  accumulatedSnapshots = [];
}

/**
 * Get all progress entries
 */
export function getProgressEntries(): ProgressEntry[] {
  return progressTracker.getEntries();
}

/**
 * Accumulate a snapshot file in memory (deferred upload)
 */
function accumulateSnapshot(
  filename: string,
  type: string,
  mimeType: string,
  data: string,
  context: SnapshotUploadContext
): void {
  if (!debugModeEnabled) {
    return;
  }
  
  accumulatedSnapshots.push({
    filename,
    type,
    mimeType,
    data,
    stepNumber: context.stepNumber,
    toolCallId: context.toolCallId,
  });
  console.log(`[Snapshot Uploader] Accumulated: ${filename} (total: ${accumulatedSnapshots.length})`);
}

/**
 * Get all accumulated snapshots (for batch upload by extension)
 */
export function getAccumulatedSnapshots(): AccumulatedSnapshot[] {
  const snapshots: AccumulatedSnapshot[] = [];
  
  // Add progress.json if there are entries
  const progressSnapshot = progressTracker.getProgressSnapshot();
  if (progressSnapshot) {
    snapshots.push(progressSnapshot);
  }
  
  // Add all accumulated screenshots and DOM files
  snapshots.push(...accumulatedSnapshots);
  
  return snapshots;
}

/**
 * Clear all accumulated snapshots to release memory.
 * Called after upload completes or when starting a new task.
 */
export function clearAccumulatedSnapshots(): void {
  const count = accumulatedSnapshots.length;
  accumulatedSnapshots = [];
  progressTracker.clearEntries();
  console.log(`[Snapshot Uploader] Cleared ${count} accumulated snapshots from memory`);
}

/**
 * Accumulate a screenshot (deferred upload)
 */
export function uploadScreenshot(
  screenshot: ScreenshotData,
  context: SnapshotUploadContext
): void {
  const extension = screenshot.imageType === 'image/jpeg' ? 'jpg' : 'png';
  const filename = `${context.stepNumber}_after_${context.toolCallId}_complete.${extension}`;
  
  // Get raw base64 data (strip data URL prefix if present)
  let base64Data = screenshot.imageBase64;
  if (base64Data.startsWith('data:')) {
    base64Data = base64Data.split(',')[1];
  }

  console.log('[Snapshot Uploader] Accumulating screenshot:', filename);
  accumulateSnapshot(
    filename,
    'screenshot',
    screenshot.imageType || 'image/png',
    base64Data,
    context
  );
}

/**
 * Accumulate pseudo DOM content (deferred upload)
 */
export function uploadPseudoDom(
  pseudoHtml: string,
  context: SnapshotUploadContext
): void {
  const filename = `${context.stepNumber}_after_${context.toolCallId}_complete.pseudo.dom`;
  
  console.log('[Snapshot Uploader] Accumulating Pseudo DOM:', filename);
  accumulateSnapshot(
    filename,
    'pseudo_dom',
    'text/plain',
    btoa(unescape(encodeURIComponent(pseudoHtml))),
    context
  );
}

/**
 * Accumulate full DOM HTML content (deferred upload)
 */
export function uploadFullDom(
  fullDomHtml: string,
  context: SnapshotUploadContext
): void {
  const filename = `${context.stepNumber}_after_${context.toolCallId}_complete.html`;
  
  console.log('[Snapshot Uploader] Accumulating Full DOM:', filename);
  accumulateSnapshot(
    filename,
    'full_dom',
    'text/html',
    btoa(unescape(encodeURIComponent(fullDomHtml))),
    context
  );
}

/**
 * Check if snapshot capture is enabled.
 * When enabled, screenshots and DOM are accumulated in memory for later upload by the caller.
 */
export function isSnapshotUploadEnabled(): boolean {
  return debugModeEnabled;
}

/**
 * Create a snapshot context for tool execution.
 */
export function createSnapshotContext(
  stepNumber: string,
  toolCallId: string
): SnapshotUploadContext {
  return {
    stepNumber,
    toolCallId,
  };}