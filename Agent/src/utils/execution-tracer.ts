/**
 * Execution Tracer for Browser Extension
 *
 * This module wraps the ExecutionTracer from @eko-ai/eko core library
 * and adds functionality to send trace data to the server.
 *
 * The core ExecutionTracer handles:
 * - Collecting tool calls, reasoning context, and human interactions
 * - Parameter source analysis
 * - Element snapshots from page navigation
 *
 * This wrapper adds:
 * - Session metadata (prompt, LLM config, token usage)
 * - HTTP POST to server's /trace endpoint
 */

import { 
  ExecutionTracer as EkoExecutionTracer, 
  createTracingCallback as ekoCreateTracingCallback,
  extractLoginIndicators,
  type AnalyzedToolCall,
  type ExecutionTrace,
} from "@eko-ai/eko";
import { StreamCallbackMessage } from "@eko-ai/eko";
import { logger } from "./logger";

// ============================================================================
// Types
// ============================================================================

export interface TraceMetadata {
  sessionId: string;
  prompt: string;
  startTime: string;
  endTime?: string;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  llmProvider?: string;
  llmModel?: string;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalTokens?: number;
  llmCallCount?: number;
}

export interface HumanHelpEntry {
  timestamp: string;
  toolName: string;
  eventType: 'help_request';
  helpType: string;
  prompt: string;
  extInfo?: any;
  loginIndicators?: string[];
}

export interface TraceSavePayload {
  toolCalls: AnalyzedToolCall[];
  humanHelp?: HumanHelpEntry[];
  metadata: TraceMetadata;
  trace?: ExecutionTrace;
}

// ============================================================================
// WebSAPETracer Class - Wrapper around EkoExecutionTracer
// ============================================================================

/**
 * WebSAPETracer wraps the eko-core ExecutionTracer and adds
 * server communication and metadata tracking.
 */
export class WebSAPETracer {
  private ekoTracer: EkoExecutionTracer;
  private metadata: TraceMetadata;
  private serverUrl: string;
  private humanHelpEntries: HumanHelpEntry[] = [];

  constructor(sessionId: string, prompt: string, serverUrl: string = 'http://localhost:8202') {
    this.serverUrl = serverUrl;
    this.metadata = {
      sessionId,
      prompt,
      startTime: new Date().toISOString(),
      status: 'running',
    };
    
    // Create the eko-core tracer
    this.ekoTracer = new EkoExecutionTracer();
  }

  /**
   * Get the underlying eko tracer for use as a callback
   */
  getEkoTracer(): EkoExecutionTracer {
    return this.ekoTracer;
  }

  /**
   * Set LLM configuration info
   */
  setLLMConfig(provider: string, model: string): void {
    this.metadata.llmProvider = provider;
    this.metadata.llmModel = model;
  }

  /**
   * Update token usage
   */
  updateTokenUsage(inputTokens: number, outputTokens: number, totalTokens: number, callCount: number): void {
    this.metadata.totalInputTokens = inputTokens;
    this.metadata.totalOutputTokens = outputTokens;
    this.metadata.totalTokens = totalTokens;
    this.metadata.llmCallCount = callCount;
  }

  /**
   * Record a human help request (login, assistance, etc.)
   */
  recordHumanHelp(helpType: string, prompt: string, extInfo?: any): void {
    const entry: HumanHelpEntry = {
      timestamp: new Date().toISOString(),
      toolName: 'human_interact',
      eventType: 'help_request',
      helpType,
      prompt,
      extInfo: extInfo || null,
      loginIndicators: extractLoginIndicators(prompt),
    };
    this.humanHelpEntries.push(entry);

    logger.debug("TRACER", `Human help request recorded: ${helpType}`);
  }

  /**
   * End the trace session
   */
  endSession(status: 'completed' | 'failed' | 'aborted'): void {
    this.metadata.endTime = new Date().toISOString();
    this.metadata.status = status;
  }

  /**
   * Get trace metadata
   */
  getMetadata(): TraceMetadata {
    return { ...this.metadata };
  }

  /**
   * Get full trace data as a payload for the server
   */
  getTracePayload(): TraceSavePayload {
    // Get analyzed tool calls from the eko tracer
    const toolCalls = this.ekoTracer.getAnalyzedToolCalls();
    
    return {
      toolCalls,
      humanHelp: this.humanHelpEntries.length > 0 ? this.humanHelpEntries : undefined,
      metadata: this.metadata,
      trace: this.ekoTracer.getTrace(),
    };
  }

  /**
   * Send trace data to the server
   */
  async sendToServer(): Promise<{ success: boolean; sessionId?: string; error?: string }> {
    try {
      const payload = this.getTracePayload();
      
      logger.info("TRACER", "Sending trace to server", {
        serverUrl: this.serverUrl,
        toolCallCount: payload.toolCalls.length,
        humanHelpCount: payload.humanHelp?.length || 0,
        sessionId: payload.metadata.sessionId,
      });

      const response = await fetch(`${this.serverUrl}/trace`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Server responded with ${response.status}: ${errorText}`);
      }

      const result = await response.json();
      
      logger.success("TRACER", "Trace sent successfully", {
        serverSessionId: result.id,
        filesCreated: result.files?.length || 0,
      });

      return {
        success: true,
        sessionId: result.id,
      };
    } catch (error: any) {
      logger.error("TRACER", "Failed to send trace to server", {
        error: error.message,
        serverUrl: this.serverUrl,
      });

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Export trace as JSONL string (for local storage/debugging)
   */
  exportAsJsonl(): string {
    const toolCalls = this.ekoTracer.getAnalyzedToolCalls();
    return toolCalls.map(tc => JSON.stringify(tc)).join('\n');
  }

  /**
   * Export full trace as JSON string
   */
  exportAsJson(): string {
    return JSON.stringify(this.getTracePayload(), null, 2);
  }
}

// ============================================================================
// Backward compatibility - keep the old class name as an alias
// ============================================================================

/**
 * @deprecated Use WebSAPETracer instead. This alias is for backward compatibility.
 */
export class ExecutionTracer extends WebSAPETracer {
  constructor(sessionId: string, prompt: string, serverUrl: string = 'http://localhost:8202') {
    super(sessionId, prompt, serverUrl);
  }

  /**
   * Process a stream callback message.
   * This forwards to the eko tracer's onMessage method.
   */
  processMessage(message: StreamCallbackMessage): void {
    // Forward to the eko tracer
    this.getEkoTracer().onMessage(message);
  }
}

// ============================================================================
// Re-export types from eko-core for convenience
// ============================================================================

export type { AnalyzedToolCall, ExecutionTrace };

