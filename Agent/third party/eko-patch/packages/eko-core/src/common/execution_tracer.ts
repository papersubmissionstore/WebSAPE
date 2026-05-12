import { AgentContext } from "../core/context";
import {
  StreamCallback,
  StreamCallbackMessage,
  HumanCallback,
} from "../types/core.types";
import { ParamSourceAnalyzer } from "./param_source";

// Declare process for Node.js environment detection (avoids @types/node dependency)
declare const process: { versions?: { node?: string } } | undefined;

// Check if we're in a Node.js environment
const isNode = typeof process !== 'undefined' && 
  process.versions != null && 
  process.versions.node != null;

/**
 * Extracts login-related indicators from the prompt text.
 * Useful for identifying login flows during human help requests.
 * @param prompt The prompt text to analyze
 * @returns Array of detected login indicators
 */
export function extractLoginIndicators(prompt: string): string[] {
  const indicators: string[] = [];
  
  // Chinese login-related terms
  if (prompt.includes('登录')) indicators.push('login_required');
  if (prompt.includes('登录框') || prompt.includes('登录弹窗')) indicators.push('login_modal');
  if (prompt.includes('登录页')) indicators.push('login_page');
  if (prompt.includes('扫码')) indicators.push('qr_code_login');
  
  // English login-related terms
  if (prompt.toLowerCase().includes('sign in')) indicators.push('sign_in');
  if (prompt.toLowerCase().includes('log in')) indicators.push('log_in');
  if (prompt.toLowerCase().includes('login modal') || prompt.toLowerCase().includes('login popup')) {
    indicators.push('login_modal');
  }
  if (prompt.toLowerCase().includes('authentication')) indicators.push('auth_required');
  
  return indicators;
}

/**
 * Represents a single traced event during agent execution
 */
export interface TracedEvent {
  timestamp: string;
  elapsedMs: number;
  message: StreamCallbackMessage;
}

/**
 * Represents a DOM element from a page snapshot
 */
export interface ElementSnapshot {
  /** Element index (used for click_element, input_text, etc.) */
  index: number;
  /** HTML tag name (button, a, input, etc.) */
  tag: string;
  /** Visible text content */
  text?: string;
  /** Link URL for anchor elements */
  href?: string;
  /** ARIA label for accessibility */
  ariaLabel?: string;
  /** Element role */
  role?: string;
  /** Input type (for input elements) */
  type?: string;
  /** Placeholder text (for input elements) */
  placeholder?: string;
}

/**
 * Represents an analyzed tool call with context about why it was called
 * and where the parameters came from
 */
export interface AnalyzedToolCall {
  /** Unique identifier for this tool call */
  toolCallId: string;
  /** Name of the tool that was called */
  toolName: string;
  /** The agent that made the call */
  agentName: string;
  /** Timestamp when the tool was called */
  timestamp: string;
  /** Elapsed time from start in ms */
  elapsedMs: number;
  /** The reasoning/thinking that led to this tool call */
  reasoning: string;
  /** Any text output before the tool call that provides context */
  contextText: string;
  /** The parameters passed to the tool */
  parameters: Record<string, any>;
  /** Analysis of where each parameter value likely came from */
  parameterSources: Record<string, string>;
  /** 
   * For tools that use element indices (click_element, input_text, etc.):
   * Explicit reference to the source of the element data.
   * Format: { stepN: "navigate_to" } means elements come from step N's navigate_to output
   */
  inputSources?: {
    /** Which step's output provides the elements */
    elementsFromStep?: number;
    /** Which tool produced the elements */
    elementsFromTool?: string;
    /** Reference expression to reproduce the element selection */
    elementReference?: string;
  };
  /** The result returned by the tool */
  result?: {
    success: boolean;
    content: string;
  };
  /**
   * For tools that produce page snapshots (navigate_to, current_page, etc.):
   * The DOM elements available after this tool completes.
   * These elements can be referenced by subsequent click_element, input_text, etc.
   */
  outputElements?: ElementSnapshot[];
  /** Time taken for tool execution in ms */
  executionTimeMs?: number;
}

/**
 * Represents a complete reasoning chain from thought to action to result
 */
export interface ReasoningChain {
  /** Sequential step number */
  step: number;
  /** The agent performing this step */
  agentName: string;
  /** The thinking/reasoning for this step */
  thinking: string;
  /** Any text output/planning for this step */
  text: string;
  /** Tool calls made in this step */
  toolCalls: AnalyzedToolCall[];
}

/**
 * Represents the complete execution trace
 */
export interface ExecutionTrace {
  taskId: string;
  startTime: string;
  endTime?: string;
  durationMs?: number;
  events: TracedEvent[];
  summary: {
    totalEvents: number;
    thinkingEvents: number;
    textEvents: number;
    toolUseEvents: number;
    toolStreamingEvents: number;
    toolResultEvents: number;
    toolRunningEvents: number;
    fileEvents: number;
    errorEvents: number;
    finishEvents: number;
    workflowEvents: number;
    agentStartEvents: number;
    agentResultEvents: number;
  };
}

/**
 * Represents a file that was generated/received during execution
 */
export interface TracedFile {
  timestamp: string;
  elapsedMs: number;
  agentName: string;
  mimeType: string;
  /** Base64 data (may be truncated) */
  data: string;
}

/**
 * Represents accumulated text/thinking content
 */
export interface AccumulatedContent {
  streamId: string;
  agentName: string;
  type: "text" | "thinking";
  content: string;
  startTime: string;
  endTime?: string;
  durationMs?: number;
}

/**
 * ExecutionTracer collects all intermediate results during agent execution
 * including reasoning/planning/tool calls and stores them for later analysis.
 */
export class ExecutionTracer implements StreamCallback, HumanCallback {
  private events: TracedEvent[] = [];
  private startTime: Date;
  private taskId: string = "";
  private originalCallback?: StreamCallback & HumanCallback;
  
  /**
   * Parameter source analyzer instance for analyzing where tool parameters come from.
   */
  private paramSourceAnalyzer: ParamSourceAnalyzer = new ParamSourceAnalyzer();
  
  /** 
   * Pre-computed parameter sources for each tool call, keyed by toolId.
   * Computed at the moment the tool_use event is received (before tool execution).
   */
  private parameterSourcesCache: Map<string, Record<string, string>> = new Map();
  
  /**
   * Validation failures for parameter sources, keyed by toolId.
   * Contains details about invalid tool_call ID references that the LLM should be aware of.
   */
  private parameterSourceValidationFailures: Map<string, { paramName: string; invalidToolCallId: string; validToolCallIds: string[]; validToolCallsInfo?: { toolId: string; toolName: string; description: string }[] }[]> = new Map();
  
  /**
   * Accumulated thinking content from the current reasoning step
   */
  private currentThinking: string = "";
  
  /**
   * Accumulated text content from the current reasoning step
   */
  private currentText: string = "";

  /**
   * Creates a new ExecutionTracer
   * @param options Configuration options
   * @param options.originalCallback Original callback to chain (optional)
   */
  constructor(options?: {
    originalCallback?: StreamCallback & HumanCallback;
  }) {
    this.startTime = new Date();
    this.originalCallback = options?.originalCallback;
  }

  /**
   * Handles incoming messages during agent execution
   */
  async onMessage(
    message: StreamCallbackMessage,
    agentContext?: AgentContext
  ): Promise<void> {
    const now = new Date();
    const elapsedMs = now.getTime() - this.startTime.getTime();

    // Capture the task ID from the first message
    if (!this.taskId && message.taskId) {
      this.taskId = message.taskId;
    }

    const msg = message as any;
    
    // Track thinking/text content as it streams in
    if (msg.type === "thinking" && msg.streamDone) {
      this.currentThinking = msg.text || "";
    }
    if (msg.type === "text" && msg.streamDone) {
      this.currentText = msg.text || "";
    }
    
    // When a tool_use event arrives, analyze parameter sources BEFORE the tool runs
    // This gives us the best context for understanding where parameters came from
    if (msg.type === "tool_use" && msg.toolId && msg.params) {
      const paramSources = this.paramSourceAnalyzer.analyzeParameterSources(
        msg.params,
        this.events,  // All events so far (before this tool runs)
        (toolResult: any) => this.extractToolResultContent(toolResult)
      );
      
      // Extract and store validation failures if any
      const validationFailures = (paramSources as any).__validationFailures;
      if (validationFailures && validationFailures.length > 0) {
        this.parameterSourceValidationFailures.set(msg.toolId, validationFailures);
        delete (paramSources as any).__validationFailures;
      }
      
      this.parameterSourcesCache.set(msg.toolId, paramSources);
    }
    
    // Note: Validation failures are now handled in base.ts callToolCall() method
    // which skips tool execution entirely when param_sources validation fails.
    // The validation error is returned directly as the tool result.

    const event: TracedEvent = {
      timestamp: now.toISOString(),
      elapsedMs,
      message: this.sanitizeMessage(message),
    };

    this.events.push(event);

    // Chain to the original callback if present
    if (this.originalCallback?.onMessage) {
      await this.originalCallback.onMessage(message, agentContext);
    }
  }

  /**
   * Handles human confirmation requests (passthrough to original callback)
   */
  async onHumanConfirm(
    agentContext: AgentContext,
    prompt: string,
    extInfo?: any
  ): Promise<boolean> {
    if (this.originalCallback?.onHumanConfirm) {
      return this.originalCallback.onHumanConfirm(agentContext, prompt, extInfo);
    }
    return false;
  }

  /**
   * Handles human input requests (passthrough to original callback)
   */
  async onHumanInput(
    agentContext: AgentContext,
    prompt: string,
    extInfo?: any
  ): Promise<string> {
    if (this.originalCallback?.onHumanInput) {
      return this.originalCallback.onHumanInput(agentContext, prompt, extInfo);
    }
    return "";
  }

  /**
   * Handles human selection requests (passthrough to original callback)
   */
  async onHumanSelect(
    agentContext: AgentContext,
    prompt: string,
    options: string[],
    multiple?: boolean,
    extInfo?: any
  ): Promise<string[]> {
    if (this.originalCallback?.onHumanSelect) {
      return this.originalCallback.onHumanSelect(agentContext, prompt, options, multiple, extInfo);
    }
    return [];
  }

  /**
   * Handles human help requests (passthrough to original callback)
   */
  async onHumanHelp(
    agentContext: AgentContext,
    helpType: "request_login" | "request_assistance",
    prompt: string,
    extInfo?: any
  ): Promise<boolean> {
    if (this.originalCallback?.onHumanHelp) {
      return this.originalCallback.onHumanHelp(agentContext, helpType, prompt, extInfo);
    }
    return false;
  }

  /**
   * Sanitizes a message for JSON serialization (removes circular references, etc.)
   */
  private sanitizeMessage(message: StreamCallbackMessage): StreamCallbackMessage {
    try {
      // Create a deep copy and handle any non-serializable content
      return JSON.parse(JSON.stringify(message, (key, value) => {
        // Handle potential circular references or non-serializable values
        if (value instanceof Error) {
          return {
            name: value.name,
            message: value.message,
            stack: value.stack,
          };
        }
        if (typeof value === "function") {
          return "[Function]";
        }
        if (typeof value === "bigint") {
          return value.toString();
        }
        // Truncate very large strings (e.g., base64 images)
        if (typeof value === "string" && value.length > 50000) {
          return value.substring(0, 50000) + "...[truncated]";
        }
        return value;
      }));
    } catch (e) {
      // If serialization fails, return a simplified version
      return {
        taskId: message.taskId,
        agentName: message.agentName,
        nodeId: message.nodeId,
        type: (message as any).type,
      } as StreamCallbackMessage;
    }
  }

  /**
   * Gets all collected events
   */
  getEvents(): TracedEvent[] {
    return [...this.events];
  }

  /**
   * Gets the complete execution trace with summary
   */
  getTrace(): ExecutionTrace {
    const endTime = new Date();
    const summary = this.computeSummary();

    return {
      taskId: this.taskId,
      startTime: this.startTime.toISOString(),
      endTime: endTime.toISOString(),
      durationMs: endTime.getTime() - this.startTime.getTime(),
      events: this.events,
      summary,
    };
  }

  /**
   * Computes summary statistics for the trace
   */
  private computeSummary(): ExecutionTrace["summary"] {
    const summary = {
      totalEvents: this.events.length,
      thinkingEvents: 0,
      textEvents: 0,
      toolUseEvents: 0,
      toolStreamingEvents: 0,
      toolResultEvents: 0,
      toolRunningEvents: 0,
      fileEvents: 0,
      errorEvents: 0,
      finishEvents: 0,
      workflowEvents: 0,
      agentStartEvents: 0,
      agentResultEvents: 0,
    };

    for (const event of this.events) {
      const type = (event.message as any).type;
      switch (type) {
        case "thinking":
          summary.thinkingEvents++;
          break;
        case "text":
          summary.textEvents++;
          break;
        case "tool_use":
          summary.toolUseEvents++;
          break;
        case "tool_streaming":
          summary.toolStreamingEvents++;
          break;
        case "tool_result":
          summary.toolResultEvents++;
          break;
        case "tool_running":
          summary.toolRunningEvents++;
          break;
        case "file":
          summary.fileEvents++;
          break;
        case "error":
          summary.errorEvents++;
          break;
        case "finish":
          summary.finishEvents++;
          break;
        case "workflow":
          summary.workflowEvents++;
          break;
        case "agent_start":
          summary.agentStartEvents++;
          break;
        case "agent_result":
          summary.agentResultEvents++;
          break;
      }
    }

    return summary;
  }

  /**
   * Gets the trace as a JSON string (works in both browser and Node.js)
   * Use this method to get the trace data, then save it using your preferred method.
   * 
   * In Node.js, you can save with:
   * ```
   * const fs = require('fs');
   * fs.writeFileSync('trace.json', tracer.getTraceAsJson());
   * ```
   * 
   * In browser, you can download with:
   * ```
   * const blob = new Blob([tracer.getTraceAsJson()], {type: 'application/json'});
   * const url = URL.createObjectURL(blob);
   * // Create download link...
   * ```
   * 
   * @param pretty Whether to format the JSON with indentation (default: true)
   */
  getTraceAsJson(pretty: boolean = true): string {
    const trace = this.getTrace();
    return pretty ? JSON.stringify(trace, null, 2) : JSON.stringify(trace);
  }

  /**
   * Clears all collected events and cached data
   */
  clear(): void {
    this.events = [];
    this.startTime = new Date();
    this.taskId = "";
    this.parameterSourcesCache.clear();
    this.parameterSourceValidationFailures.clear();
    this.currentThinking = "";
    this.currentText = "";
  }

  /**
   * Gets events filtered by type
   */
  getEventsByType(type: string): TracedEvent[] {
    return this.events.filter((e) => (e.message as any).type === type);
  }

  /**
   * Gets all thinking/reasoning events
   */
  getThinkingEvents(): TracedEvent[] {
    return this.getEventsByType("thinking");
  }

  /**
   * Gets all tool use events
   */
  getToolUseEvents(): TracedEvent[] {
    return this.getEventsByType("tool_use");
  }

  /**
   * Gets all tool result events
   */
  getToolResultEvents(): TracedEvent[] {
    return this.getEventsByType("tool_result");
  }

  /**
   * Gets all text output events
   */
  getTextEvents(): TracedEvent[] {
    return this.getEventsByType("text");
  }

  /**
   * Gets all tool streaming events
   */
  getToolStreamingEvents(): TracedEvent[] {
    return this.getEventsByType("tool_streaming");
  }

  /**
   * Gets all tool running events
   */
  getToolRunningEvents(): TracedEvent[] {
    return this.getEventsByType("tool_running");
  }

  /**
   * Gets all file events
   */
  getFileEvents(): TracedEvent[] {
    return this.getEventsByType("file");
  }

  /**
   * Gets all workflow events
   */
  getWorkflowEvents(): TracedEvent[] {
    return this.getEventsByType("workflow");
  }

  /**
   * Gets all finish events
   */
  getFinishEvents(): TracedEvent[] {
    return this.getEventsByType("finish");
  }

  /**
   * Gets all agent start events
   */
  getAgentStartEvents(): TracedEvent[] {
    return this.getEventsByType("agent_start");
  }

  /**
   * Gets all agent result events
   */
  getAgentResultEvents(): TracedEvent[] {
    return this.getEventsByType("agent_result");
  }

  /**
   * Gets all error events
   */
  getErrorEvents(): TracedEvent[] {
    return this.getEventsByType("error");
  }

  /**
   * Gets all parameter source validation failures.
   * These represent cases where the LLM referenced a tool_call ID that doesn't exist.
   * Use this to inform the LLM about invalid references so it can correct its behavior.
   * 
   * @returns Map of toolId -> array of validation failures
   */
  getParameterSourceValidationFailures(): Map<string, { paramName: string; invalidToolCallId: string; validToolCallIds: string[]; validToolCallsInfo?: { toolId: string; toolName: string; description: string }[] }[]> {
    return new Map(this.parameterSourceValidationFailures);
  }

  /**
   * Gets validation failures for a specific tool call ID.
   * This method is called by the tool execution framework to determine if tool execution should be skipped.
   * Implements the StreamCallback.getValidationFailures interface method.
   * 
   * @param toolId The tool call ID to check for validation failures
   * @returns Array of validation failures, or undefined if none
   */
  getValidationFailures(
    toolId: string
  ): { paramName: string; invalidToolCallId: string; validToolCallIds: string[]; validToolCallsInfo?: { toolId: string; toolName: string; description: string }[] }[] | undefined {
    return this.parameterSourceValidationFailures.get(toolId);
  }

  /**
   * Gets the analyzed parameter sources for a specific tool call ID.
   * This shows where each parameter value likely came from (e.g., user input, previous tool result, etc.)
   * 
   * @param toolId The tool call ID to get parameter sources for
   * @returns Record of parameter name to source description, or undefined if not analyzed
   */
  getParameterSources(toolId: string): Record<string, string> | undefined {
    return this.parameterSourcesCache.get(toolId);
  }

  /**
   * Formats validation failures into an error message for the LLM.
   * This is the public method that matches the StreamCallback interface.
   * 
   * @param failures The validation failures to format
   * @param toolId The tool call ID that had the failures
   * @returns A formatted error message string
   */
  formatValidationFailures(
    failures: { paramName: string; invalidToolCallId: string; validToolCallIds: string[]; validToolCallsInfo?: { toolId: string; toolName: string; description: string }[] }[],
    toolId: string
  ): string {
    return this.formatValidationFailuresForLLM(failures, toolId);
  }

  /**
   * Gets validation failures formatted as a message for LLM awareness.
   * @returns A formatted string describing all validation failures, or null if none
   */
  getValidationFailuresForLLM(): string | null {
    if (this.parameterSourceValidationFailures.size === 0) {
      return null;
    }

    const messages: string[] = [];
    for (const [toolId, failures] of this.parameterSourceValidationFailures) {
      for (const failure of failures) {
        messages.push(
          `Parameter '${failure.paramName}' in tool call '${toolId}' referenced invalid tool_call ID '${failure.invalidToolCallId}'. ` +
          `Valid tool_call IDs are: [${failure.validToolCallIds.join(', ')}]`
        );
      }
    }

    return `[VALIDATION ERRORS - Invalid tool_call ID references]\n${messages.join('\n')}`;
  }

  /**
   * Formats validation failures for a specific tool call into a message for the LLM.
   * This is used internally when injecting errors into tool results.
   * 
   * @param failures Array of validation failures for a specific tool call
   * @param toolId The tool call ID that had the failures
   * @returns A formatted error message string
   */
  private formatValidationFailuresForLLM(
    failures: { paramName: string; invalidToolCallId: string; validToolCallIds: string[]; validToolCallsInfo?: { toolId: string; toolName: string; description: string }[] }[],
    toolId: string
  ): string {
    const messages = failures.map(failure => 
      `- Parameter '${failure.paramName}' referenced non-existent tool_call ID '${failure.invalidToolCallId}'`
    );
    
    // Build detailed valid tool calls info
    const validToolCallsInfo = failures[0]?.validToolCallsInfo || [];
    let validToolCallsSection: string;
    
    if (validToolCallsInfo.length > 0) {
      const toolCallsList = validToolCallsInfo.map(tc => 
        `  - tool_call['${tc.toolId}'] : ${tc.toolName}`
      ).join('\n');
      validToolCallsSection = `Valid tool_call IDs in conversation history (only successful tool results, excluding failed ones):\n${toolCallsList}`;
    } else {
      validToolCallsSection = `No valid tool_call IDs found in conversation history (all previous tool calls either failed or have no results yet).`;
    }
    
    return `[TOOL EXECUTION SKIPPED - INVALID TOOL_CALL ID REFERENCE]\n\n` +
      `Tool '${toolId}' was NOT executed because param_sources reference invalid tool_call IDs:\n${messages.join('\n')}\n\n` +
      `${validToolCallsSection}\n\n` +
      `ACTION REQUIRED: Re-invoke this tool with correct param_sources that reference valid tool_call IDs from the list above.\n` +
      `Format: tool_call['<valid_tool_call_id>'].outputs[\"<output_field>\"]`;
  }

  /**
   * Gets events for a specific agent
   */
  getEventsByAgent(agentName: string): TracedEvent[] {
    return this.events.filter((e) => e.message.agentName === agentName);
  }

  /**
   * Gets all accumulated thinking content (from thinking events marked as streamDone)
   */
  getAccumulatedThinking(): string {
    const thinking: string[] = [];
    for (const event of this.events) {
      const msg = event.message as any;
      // Note: thinking type uses 'text' property, not 'thinking'
      if (msg.type === "thinking" && msg.streamDone && msg.text) {
        thinking.push(msg.text);
      }
    }
    return thinking.join("\n\n");
  }

  /**
   * Gets all accumulated text content (from text events marked as streamDone)
   */
  getAccumulatedText(): string {
    const texts: string[] = [];
    for (const event of this.events) {
      const msg = event.message as any;
      if (msg.type === "text" && msg.streamDone && msg.text) {
        texts.push(msg.text);
      }
    }
    return texts.join("\n\n");
  }

  /**
   * Gets all tool streaming content accumulated by tool name
   */
  getAccumulatedToolStreaming(): Map<string, string> {
    const toolStreaming = new Map<string, string>();
    for (const event of this.events) {
      const msg = event.message as any;
      if (msg.type === "tool_streaming" && msg.streamDone) {
        const toolName = msg.toolName || "unknown";
        toolStreaming.set(toolName, msg.content || "");
      }
    }
    return toolStreaming;
  }

  /**
   * Gets all file events grouped by file operation type
   */
  getFileOperations(): { path: string; operation: string; timestamp: string }[] {
    const fileOps: { path: string; operation: string; timestamp: string }[] = [];
    for (const event of this.events) {
      const msg = event.message as any;
      if (msg.type === "file") {
        fileOps.push({
          path: msg.filePath || msg.path || "unknown",
          operation: msg.operation || msg.action || "file",
          timestamp: event.timestamp,
        });
      }
    }
    return fileOps;
  }

  /**
   * Gets workflow structure information
   */
  getWorkflowInfo(): { name: string; description?: string; steps?: any[] }[] {
    const workflows: { name: string; description?: string; steps?: any[] }[] = [];
    for (const event of this.events) {
      const msg = event.message as any;
      if (msg.type === "workflow") {
        workflows.push({
          name: msg.workflowName || msg.name || "unnamed",
          description: msg.description,
          steps: msg.steps || msg.workflow?.nodes,
        });
      }
    }
    return workflows;
  }

  /**
   * Analyzes tool calls and returns them with reasoning context.
   * This method correlates thinking/text events with subsequent tool calls
   * to explain WHY each tool was called and WHERE the parameters came from.
   */
  getAnalyzedToolCalls(): AnalyzedToolCall[] {
    const analyzedCalls: AnalyzedToolCall[] = [];
    let currentThinking = "";
    let currentText = "";
    let lastThinkingTime = 0;
    let lastTextTime = 0;


    for (let i = 0; i < this.events.length; i++) {
      const event = this.events[i];
      const msg = event.message as any;

      // Accumulate thinking (only when stream is done to avoid duplicates)
      if (msg.type === "thinking" && msg.streamDone) {
        currentThinking = msg.text || "";
        lastThinkingTime = event.elapsedMs;
      }

      // Accumulate text (only when stream is done)
      if (msg.type === "text" && msg.streamDone) {
        currentText = msg.text || "";
        lastTextTime = event.elapsedMs;
      }

      // When we see a tool_use, analyze it
      if (msg.type === "tool_use") {
        // Use pre-computed parameter sources if available (computed at tool_use time)
        // Fall back to computing now if not in cache (e.g., for historical analysis)
        const cachedSources = this.parameterSourcesCache.get(msg.toolId);
        const parameterSources = cachedSources || this.paramSourceAnalyzer.analyzeParameterSources(
          msg.params || {},
          this.events.slice(0, i),
          (toolResult: any) => this.extractToolResultContent(toolResult)
        );

        const toolCall: AnalyzedToolCall = {
          toolCallId: msg.toolId,
          toolName: msg.toolName,
          agentName: event.message.agentName,
          timestamp: event.timestamp,
          elapsedMs: event.elapsedMs,
          reasoning: currentThinking,
          contextText: currentText,
          parameters: msg.params || {},
          parameterSources,
        };

        // Look for the corresponding tool_result
        for (let j = i + 1; j < this.events.length; j++) {
          const resultEvent = this.events[j];
          const resultMsg = resultEvent.message as any;
          if (resultMsg.type === "tool_result" && resultMsg.toolId === msg.toolId) {
            toolCall.result = {
              success: !resultMsg.toolResult?.isError,
              content: this.extractToolResultContent(resultMsg.toolResult),
            };
            toolCall.executionTimeMs = resultEvent.elapsedMs - event.elapsedMs;
            break;
          }
        }

        analyzedCalls.push(toolCall);
      }
    }

    return analyzedCalls;
  }

  /**
   * Extracts readable content from a tool result
   */
  private extractToolResultContent(toolResult: any): string {
    if (!toolResult || !toolResult.content) return "";
    
    try {
      if (Array.isArray(toolResult.content)) {
        return toolResult.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text || "")
          .join("\n");
      }
      return JSON.stringify(toolResult.content);
    } catch {
      return "";
    }
  }

}

/**
 * Creates a callback that wraps an existing callback with tracing capability
 * @param originalCallback The original callback to wrap
 * @returns Object containing the tracer and the wrapped callback
 */
export function createTracingCallback(
  originalCallback?: StreamCallback & HumanCallback
): {
  tracer: ExecutionTracer;
  callback: StreamCallback & HumanCallback;
} {
  const tracer = new ExecutionTracer({
    originalCallback,
  });

  return {
    tracer,
    callback: tracer,
  };
}
