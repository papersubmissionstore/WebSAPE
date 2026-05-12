/**
 * Centralized logging utility for the browser extension
 * Provides structured logging for debugging agent planning, LLM calls, and other operations
 */

import { BUILD_INFO, getBuildInfoForLogs, getBuildInfoString } from './build-info';

// Chrome API type declarations for extension context
declare const chrome: any;

export enum LogLevel {
  DEBUG = "debug",
  INFO = "info",
  SUCCESS = "success",
  WARNING = "warning",
  ERROR = "error",
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  category: string;
  message: string;
  data?: any;
  sessionId?: string;
}

// Structured log types for consolidated sidebar display
export type StructuredLogType = 
  | 'reasoning'       // LLM reasoning/thinking
  | 'tool_call'       // Tool being executed with params
  | 'tool_result'     // Tool execution result
  | 'experience'      // Experience injected/used
  | 'plan'            // Plan overview
  | 'plan_step'       // Current step in plan
  | 'snapshot'        // Link to downloaded DOM/screenshot
  | 'status'          // General status message
  | 'error'           // Error message
  | 'token_usage'     // Token usage stats
  | 'text_response'   // Final text/markdown response from LLM
  | 'instruction';    // Website navigation instruction loaded

export interface PlanStep {
  index: number;
  total: number;
  description: string;
  status: 'pending' | 'in-progress' | 'completed' | 'failed';
  agentName?: string;
  toolName?: string;
}

export interface StructuredLogEntry {
  id: string;
  timestamp: string;
  type: StructuredLogType;
  // Agent prefix for multi-agent mode (e.g., "[Child #1] ")
  agentPrefix?: string;
  // Content based on type
  reasoning?: string;                  // For 'reasoning' type
  toolName?: string;                   // For 'tool_call', 'tool_result' types
  toolId?: string;                     // For 'tool_call', 'tool_result' types - the tool call ID
  toolParams?: Record<string, any>;    // For 'tool_call' type
  paramSources?: Record<string, string>; // For 'tool_call' type - where each param came from
  paramSourceValidation?: {             // For 'tool_call' type - validation failures
    failures: Array<{
      paramName: string;
      invalidToolCallId: string;
      validToolCallIds: string[];
    }>;
  };
  toolResult?: string;                 // For 'tool_result' type (preview)
  pageStateChange?: { type?: string; details?: string }; // For 'tool_result' type - page state change
  // Action-landing watchdog events emitted by eko-core in-page during this
  // tool call (occlusion_check / auto_scroll_into_view / occlusion_recheck).
  // NEVER surfaced to the LLM; only persisted in progress.json for analysis.
  actionLandingEvents?: Array<Record<string, any>>;
  agentName?: string;                  // For tool-related types
  experienceReadCount?: number;        // For 'experience' type
  experienceSelectedCount?: number;    // For 'experience' type
  experiencePreview?: string;          // For 'experience' type - pretty JSON / text
  plan?: string;                       // For 'plan' type - raw plan XML/text
  planSteps?: PlanStep[];              // For 'plan' type - parsed steps
  currentStep?: PlanStep;              // For 'plan_step' type
  snapshotType?: 'dom' | 'screenshot'; // For 'snapshot' type
  snapshotPath?: string;               // For 'snapshot' type - download path
  snapshotUrl?: string;                // For 'snapshot' type - blob URL
  message?: string;                    // For 'status', 'error' types
  textContent?: string;                // For 'text_response' type - markdown text content
  tokenUsage?: {                       // For 'token_usage' type
    input: number;
    output: number;
    total: number;
    callCount: number;
  };
  instruction?: {                      // For 'instruction' type
    domain: string;
    displayName: string;
    contentLength: number;
    url: string;
    version?: string | null;
  };
  level: 'info' | 'success' | 'error' | 'warning';
}

export interface SessionLog {
  sessionId: string;
  startTime: string;
  endTime?: string;
  prompt: string;
  logs: LogEntry[];
  status: 'running' | 'completed' | 'failed' | 'aborted';
}

export interface LLMInteraction {
  requestId: string;
  timestamp: string;
  provider: string;
  model: string;
  request: {
    messages: any[];
    parameters?: any;
  };
  response?: {
    content: string;
    usage?: any;
    metadata?: any;
  };
  error?: any;
}

export class Logger {
  private static instance: Logger;
  private logs: LogEntry[] = [];
  private sessions: Map<string, SessionLog> = new Map();
  private currentSessionId: string | null = null;
  private llmInteractions: Map<string, LLMInteraction> = new Map();
  private maxLogs: number = 1000;
  private enableConsole: boolean = true;
  private enableStorage: boolean = true;
  
  // Structured logs for consolidated UI display
  private structuredLogs: StructuredLogEntry[] = [];
  private currentPlanSteps: PlanStep[] = [];
  private currentStepIndex: number = 0;
  private logIdCounter: number = 0;

  // Per-run console error/warning log collector for task_status upload
  private runConsoleLogs: Array<{ timestamp: string; level: 'error' | 'warning'; message: string }> = [];
  private maxRunConsoleLogs: number = 500;
  private consoleIntercepted: boolean = false;
  private originalConsoleError: (...args: any[]) => void = console.error;
  private originalConsoleWarn: (...args: any[]) => void = console.warn;

  private constructor() {
    this.interceptConsole();
  }

  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  /**
   * Configure logger settings
   */
  configure(options: {
    maxLogs?: number;
    enableConsole?: boolean;
    enableStorage?: boolean;
  }) {
    if (options.maxLogs !== undefined) this.maxLogs = options.maxLogs;
    if (options.enableConsole !== undefined)
      this.enableConsole = options.enableConsole;
    if (options.enableStorage !== undefined)
      this.enableStorage = options.enableStorage;
  }

  /**
   * Intercept console.error and console.warn to collect per-run diagnostic logs.
   * Captures all error/warning output including from eko-core and third-party code.
   */
  private interceptConsole(): void {
    if (this.consoleIntercepted) return;
    this.consoleIntercepted = true;

    const self = this;

    console.error = function (...args: any[]) {
      self.collectConsoleLog('error', args);
      self.originalConsoleError.apply(console, args);
    };

    console.warn = function (...args: any[]) {
      self.collectConsoleLog('warning', args);
      self.originalConsoleWarn.apply(console, args);
    };
  }

  /**
   * Format console args into a single message string and add to run logs.
   */
  private collectConsoleLog(level: 'error' | 'warning', args: any[]): void {
    const message = args.map(arg => {
      if (typeof arg === 'string') return arg;
      try { return JSON.stringify(arg); } catch { return String(arg); }
    }).join(' ');

    if (this.runConsoleLogs.length < this.maxRunConsoleLogs) {
      this.runConsoleLogs.push({
        timestamp: new Date().toISOString(),
        level,
        message,
      });
    }
  }

  /**
   * Get all collected console error/warning logs for the current run.
   */
  getRunConsoleLogs(): Array<{ timestamp: string; level: 'error' | 'warning'; message: string }> {
    return this.runConsoleLogs;
  }

  /**
   * Clear collected console logs (called at the start of each run).
   */
  clearRunConsoleLogs(): void {
    this.runConsoleLogs = [];
  }

  /**
   * Core logging method
   */
  private log(
    level: LogLevel,
    category: string,
    message: string,
    data?: any
  ): void {
    const timestamp = new Date().toISOString();
    const entry: LogEntry = {
      timestamp,
      level,
      category,
      message,
      data,
      sessionId: this.currentSessionId || undefined,
    };

    // Add to in-memory logs
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    // Console output with colors
    if (this.enableConsole) {
      const prefix = `[${timestamp}] [${category}] [${level.toUpperCase()}]`;
      const consoleMethod = this.getConsoleMethod(level);
      if (data) {
        consoleMethod(`${prefix} ${message}`, data);
      } else {
        consoleMethod(`${prefix} ${message}`);
      }
    }

    // Store in chrome storage for persistence
    if (this.enableStorage) {
      this.persistLogs();
    }

    // Send to UI if available
    this.sendToUI(entry);
  }

  private getConsoleMethod(level: LogLevel): (...args: any[]) => void {
    switch (level) {
      case LogLevel.ERROR:
        return console.error;
      case LogLevel.WARNING:
        return console.warn;
      case LogLevel.DEBUG:
        return console.debug;
      default:
        return console.log;
    }
  }

  private sendToUI(entry: LogEntry): void {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime) {
        Promise.resolve(chrome.runtime.sendMessage({
          type: "log",
          log: `[${entry.category}] ${entry.message}${
            entry.data ? "\n" + JSON.stringify(entry.data, null, 2) : ""
          }`,
          level: this.mapLogLevelToUILevel(entry.level),
        })).catch(() => { /* sidebar not open */ });
      }
    } catch (e) {
      // Silently fail if UI is not available
    }
  }

  /**
   * Send a structured log to the UI for consolidated display
   */
  private sendStructuredLogToUI(entry: StructuredLogEntry): void {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime) {
        Promise.resolve(chrome.runtime.sendMessage({
          type: "structured_log",
          entry,
        })).catch(() => { /* sidebar not open */ });
      }
    } catch (e) {
      // Silently fail if UI is not available
    }
  }

  /**
   * Generate a unique ID for structured log entries
   */
  private generateLogId(): string {
    return `log_${Date.now()}_${++this.logIdCounter}`;
  }

  /**
   * Add a structured log entry and send to UI
   */
  addStructuredLog(entry: Omit<StructuredLogEntry, 'id' | 'timestamp'>): void {
    const fullEntry: StructuredLogEntry = {
      ...entry,
      id: this.generateLogId(),
      timestamp: new Date().toISOString(),
    };
    
    this.structuredLogs.push(fullEntry);
    this.sendStructuredLogToUI(fullEntry);
  }

  /**
   * Log loaded experience that Eko injected/used.
   */
  logExperienceLoaded(payload: {
    readCount: number;
    selectedCount: number;
    selected: any[];
  }): void {
    const safeStringify = (value: any, maxChars: number): string => {
      let text = '';
      try {
        text = JSON.stringify(value, null, 2);
      } catch {
        text = String(value);
      }
      if (text.length <= maxChars) return text;
      return text.slice(0, Math.max(0, maxChars - 1)) + '…';
    };

    this.addStructuredLog({
      type: 'experience',
      experienceReadCount: payload.readCount,
      experienceSelectedCount: payload.selectedCount,
      experiencePreview: safeStringify(payload.selected, 12000),
      level: 'info',
    });
  }

  /**
   * Log LLM reasoning/thinking
   */
  logReasoning(reasoning: string, agentPrefix?: string): void {
    if (!reasoning || reasoning.trim() === '') return;
    this.addStructuredLog({
      type: 'reasoning',
      reasoning,
      agentPrefix,
      level: 'info',
    });
  }

  /**
   * Log final text response from LLM (supports markdown)
   */
  logTextResponse(textContent: string): void {
    if (!textContent || textContent.trim() === '') return;
    this.addStructuredLog({
      type: 'text_response',
      textContent,
      level: 'info',
    });
  }

  /**
   * Log a tool call with parameters
   */
  logStructuredToolCall(
    agentName: string, 
    toolName: string, 
    toolId: string,
    params: Record<string, any>,
    paramSources?: Record<string, string>,
    paramSourceValidation?: {
      failures: Array<{
        paramName: string;
        invalidToolCallId: string;
        validToolCallIds: string[];
      }>;
    },
    agentPrefix?: string
  ): void {
    this.addStructuredLog({
      type: 'tool_call',
      agentName,
      toolName,
      toolId,
      toolParams: params,
      paramSources,
      paramSourceValidation,
      agentPrefix,
      level: paramSourceValidation?.failures?.length ? 'warning' : 'info',
    });
  }

  /**
   * Log a tool result
   */
  logStructuredToolResult(
    agentName: string,
    toolName: string,
    result: string,
    pageStateChange?: { type?: string; details?: string },
    agentPrefix?: string,
    actionLandingEvents?: Array<Record<string, any>>
  ): void {
    this.addStructuredLog({
      type: 'tool_result',
      agentName,
      toolName,
      toolResult: result, // Full result for debug portal
      pageStateChange,
      agentPrefix,
      actionLandingEvents,
      level: 'success',
    });
  }

  /**
   * Parse plan XML into steps
   * Supports multiple formats:
   * 1. Eko workflow format: <agent><nodes><node>description</node></nodes></agent>
   * 2. Step format: <step><description>...</description></step>
   * 3. Numbered text: "1. Do something" or "Step 1: Do something"
   */
  private parsePlanXml(planXml: string): PlanStep[] {
    const steps: PlanStep[] = [];
    
    // First, try to extract agent name
    const agentMatch = planXml.match(/<agent[^>]*name=["']([^"']+)["'][^>]*>/i);
    const agentName = agentMatch?.[1];
    
    // Try Eko workflow format: <node>description</node>
    const nodeRegex = /<node[^>]*>([\s\S]*?)<\/node>/gi;
    let match;
    let index = 0;
    
    while ((match = nodeRegex.exec(planXml)) !== null) {
      const content = match[0];
      const innerContent = match[1].trim();
      
      // Skip if this node contains other nodes (it's a container like forEach)
      if (innerContent.includes('<node')) continue;
      
      // Skip empty nodes
      if (!innerContent) continue;
      
      // Check for output/input attributes
      const outputMatch = content.match(/output=["']([^"']+)["']/i);
      const inputMatch = content.match(/input=["']([^"']+)["']/i);
      
      steps.push({
        index: index++,
        total: 0, // Will be updated after parsing
        description: innerContent.substring(0, 150),
        status: 'pending',
        agentName: agentName,
        toolName: outputMatch?.[1] || inputMatch?.[1],
      });
    }
    
    // If no nodes found, try <step> tags with content
    if (steps.length === 0) {
      const stepRegex = /<step[^>]*>([\s\S]*?)<\/step>/gi;
      
      while ((match = stepRegex.exec(planXml)) !== null) {
        const content = match[1].trim();
        // Extract description, agent, tool from step content
        const descMatch = content.match(/<description[^>]*>([\s\S]*?)<\/description>/i);
        const agentStepMatch = content.match(/<agent[^>]*>([\s\S]*?)<\/agent>/i);
        const toolMatch = content.match(/<tool[^>]*>([\s\S]*?)<\/tool>/i);
        
        steps.push({
          index: index++,
          total: 0, // Will be updated after parsing
          description: descMatch?.[1]?.trim() || content.substring(0, 100),
          status: 'pending',
          agentName: agentStepMatch?.[1]?.trim(),
          toolName: toolMatch?.[1]?.trim(),
        });
      }
    }
    
    // If still no steps found, try numbered steps like "1. Do something" or "Step 1: Do something"
    if (steps.length === 0) {
      const numberedRegex = /(?:^|\n)\s*(?:step\s*)?(\d+)[.:)\s]+(.+?)(?=\n\s*(?:step\s*)?\d+[.:)\s]|\n*$)/gi;
      while ((match = numberedRegex.exec(planXml)) !== null) {
        steps.push({
          index: parseInt(match[1]) - 1,
          total: 0,
          description: match[2].trim(),
          status: 'pending',
        });
      }
    }
    
    // Update total for all steps
    steps.forEach(step => step.total = steps.length);
    
    return steps;
  }

  /**
   * Log a plan and parse its steps
   */
  logPlan(planXml: string): void {
    const planSteps = this.parsePlanXml(planXml);
    this.currentPlanSteps = planSteps;
    this.currentStepIndex = 0;
    
    // Mark the first step as in-progress
    if (this.currentPlanSteps.length > 0) {
      this.currentPlanSteps[0].status = 'in-progress';
    }
    
    this.addStructuredLog({
      type: 'plan',
      plan: planXml,
      planSteps: this.currentPlanSteps,
      level: 'info',
    });
    
    // Also emit a plan_step entry for step 1 so it shows in the log
    if (this.currentPlanSteps.length > 0) {
      this.addStructuredLog({
        type: 'plan_step',
        currentStep: this.currentPlanSteps[0],
        planSteps: this.currentPlanSteps,
        level: 'info',
      });
    }
  }

  /**
   * Update current step in plan
   */
  updatePlanStep(stepIndex: number, status: PlanStep['status']): void {
    if (stepIndex >= 0 && stepIndex < this.currentPlanSteps.length) {
      this.currentPlanSteps[stepIndex].status = status;
      this.currentStepIndex = stepIndex;
      
      this.addStructuredLog({
        type: 'plan_step',
        currentStep: this.currentPlanSteps[stepIndex],
        planSteps: this.currentPlanSteps,
        level: status === 'failed' ? 'error' : status === 'completed' ? 'success' : 'info',
      });
    }
  }

  /**
   * Advance to next step in plan
   */
  advancePlanStep(): void {
    if (this.currentStepIndex < this.currentPlanSteps.length) {
      // Mark current as completed
      if (this.currentPlanSteps[this.currentStepIndex]) {
        this.currentPlanSteps[this.currentStepIndex].status = 'completed';
      }
      
      // Move to next step
      this.currentStepIndex++;
      if (this.currentStepIndex < this.currentPlanSteps.length) {
        this.currentPlanSteps[this.currentStepIndex].status = 'in-progress';
        this.addStructuredLog({
          type: 'plan_step',
          currentStep: this.currentPlanSteps[this.currentStepIndex],
          planSteps: this.currentPlanSteps,
          level: 'info',
        });
      }
    }
  }

  /**
   * Update plan steps based on doneIds from task_snapshot
   * Mark steps with indices in doneIds as completed
   */
  updatePlanStepsFromDoneIds(doneIds: number[]): void {
    if (!this.currentPlanSteps.length) return;
    
    let hasChanges = false;
    let firstInProgressIndex = -1;
    
    for (let i = 0; i < this.currentPlanSteps.length; i++) {
      const step = this.currentPlanSteps[i];
      if (doneIds.includes(i)) {
        if (step.status !== 'completed') {
          step.status = 'completed';
          hasChanges = true;
        }
      } else if (firstInProgressIndex === -1 && step.status !== 'completed') {
        // First non-completed step that's not in doneIds should be in-progress
        firstInProgressIndex = i;
      }
    }
    
    // Set the first non-done step as in-progress
    if (firstInProgressIndex >= 0 && this.currentPlanSteps[firstInProgressIndex].status !== 'in-progress') {
      this.currentPlanSteps[firstInProgressIndex].status = 'in-progress';
      this.currentStepIndex = firstInProgressIndex;
      hasChanges = true;
    }
    
    if (hasChanges) {
      this.addStructuredLog({
        type: 'plan_step',
        currentStep: this.currentPlanSteps[this.currentStepIndex],
        planSteps: this.currentPlanSteps,
        level: 'info',
      });
    }
  }

  /**
   * Get current plan steps
   */
  getCurrentPlanSteps(): PlanStep[] {
    return [...this.currentPlanSteps];
  }

  /**
   * Log a snapshot (DOM or screenshot) with download link
   */
  logSnapshot(type: 'dom' | 'screenshot', path: string, url?: string): void {
    this.addStructuredLog({
      type: 'snapshot',
      snapshotType: type,
      snapshotPath: path,
      snapshotUrl: url,
      level: 'info',
    });
  }

  /**
   * Log status message
   */
  logStatus(message: string, level: 'info' | 'success' | 'error' | 'warning' = 'info'): void {
    this.addStructuredLog({
      type: 'status',
      message,
      level,
    });
  }

  /**
   * Log token usage
   */
  logTokenUsage(input: number, output: number, total: number, callCount: number): void {
    this.addStructuredLog({
      type: 'token_usage',
      tokenUsage: { input, output, total, callCount },
      level: 'info',
    });
  }

  /**
   * Log website instruction loaded
   */
  logInstruction(info: { domain: string; displayName: string; contentLength: number; url: string; version?: string | null }): void {
    this.addStructuredLog({
      type: 'instruction',
      instruction: info,
      level: 'success',
    });
  }

  /**
   * Get all structured logs
   */
  getStructuredLogs(): StructuredLogEntry[] {
    return [...this.structuredLogs];
  }

  /**
   * Clear structured logs (for new session)
   */
  clearStructuredLogs(): void {
    this.structuredLogs = [];
    this.currentPlanSteps = [];
    this.currentStepIndex = 0;
  }

  private mapLogLevelToUILevel(level: LogLevel): string {
    switch (level) {
      case LogLevel.ERROR:
        return "error";
      case LogLevel.SUCCESS:
        return "success";
      default:
        return "info";
    }
  }

  private persistLogs(): void {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage) {
        const recentLogs = this.logs.slice(-100); // Keep last 100 logs
        chrome.storage.local.set({ debugLogs: recentLogs });
      }
    } catch (e) {
      console.error("Failed to persist logs:", e);
    }
  }

  // Session management methods
  startSession(prompt: string): string {
    const sessionId = Date.now().toString();
    this.currentSessionId = sessionId;
    
    // Clear structured logs for new session
    this.clearStructuredLogs();
    
    // Clear per-run console logs for new session
    this.clearRunConsoleLogs();
    
    const session: SessionLog = {
      sessionId,
      startTime: new Date().toISOString(),
      prompt,
      logs: [],
      status: 'running',
    };
    
    this.sessions.set(sessionId, session);
    this.info("SESSION_START", `Started session: ${sessionId}`, { prompt });
    
    // Log build info at session start for traceability
    this.info("BUILD_INFO", `Build: ${getBuildInfoString()}`, getBuildInfoForLogs());
    
    return sessionId;
  }

  endSession(status: 'completed' | 'failed' | 'aborted', result?: any, error?: any): void {
    if (!this.currentSessionId) return;
    
    const session = this.sessions.get(this.currentSessionId);
    if (session) {
      session.endTime = new Date().toISOString();
      session.status = status;
      
      // Copy current session logs
      session.logs = this.logs.filter(log => log.sessionId === this.currentSessionId);
      
      this.info("SESSION_END", `Session ${this.currentSessionId} ended with status: ${status}`, {
        sessionId: this.currentSessionId,
        status,
        duration: new Date().getTime() - new Date(session.startTime).getTime(),
        logCount: session.logs.length,
        result,
        error
      });
    }
    
    this.currentSessionId = null;
  }

  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  /**
   * Update the current session ID with a new value (e.g., to add a prefix like "qt").
   * This ensures that all subsequent calls to getCurrentSessionId() return the prefixed version.
   */
  updateCurrentSessionId(newSessionId: string): void {
    if (this.currentSessionId) {
      // Also update the session in the sessions map if it exists
      const oldSession = this.sessions.get(this.currentSessionId);
      if (oldSession) {
        // Move session to new key
        this.sessions.delete(this.currentSessionId);
        oldSession.sessionId = newSessionId;
        this.sessions.set(newSessionId, oldSession);
      }
    }
    this.currentSessionId = newSessionId;
    this.info("SESSION_ID_UPDATE", `Session ID updated to: ${newSessionId}`);
  }

  getSession(sessionId: string): SessionLog | undefined {
    return this.sessions.get(sessionId);
  }

  getAllSessions(): SessionLog[] {
    return Array.from(this.sessions.values()).sort((a, b) =>
      new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
    );
  }

  // LLM interaction tracking
  startLLMInteraction(provider: string, model: string, messages: any[], parameters?: any): string {
    const requestId = Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9);
    
    const interaction: LLMInteraction = {
      requestId,
      timestamp: new Date().toISOString(),
      provider,
      model,
      request: {
        messages,
        parameters
      }
    };
    
    this.llmInteractions.set(requestId, interaction);
    this.debug("LLM_REQUEST", `LLM request started: ${provider}/${model}`, {
      requestId,
      provider,
      model,
      messageCount: messages.length,
      parameters
    });
    
    return requestId;
  }

  completeLLMInteraction(requestId: string, response: any, usage?: any, metadata?: any): void {
    const interaction = this.llmInteractions.get(requestId);
    if (interaction) {
      interaction.response = {
        content: response,
        usage,
        metadata
      };
      
      this.debug("LLM_RESPONSE", `LLM response completed: ${interaction.provider}/${interaction.model}`, {
        requestId,
        responseLength: typeof response === 'string' ? response.length : JSON.stringify(response).length,
        usage,
        metadata
      });
    }
  }

  errorLLMInteraction(requestId: string, error: any): void {
    const interaction = this.llmInteractions.get(requestId);
    if (interaction) {
      interaction.error = error;
      
      this.error("LLM_ERROR", `LLM request failed: ${interaction.provider}/${interaction.model}`, {
        requestId,
        error: error.toString()
      });
    }
  }

  getLLMInteractions(sessionId?: string): LLMInteraction[] {
    const interactions = Array.from(this.llmInteractions.values());
    if (sessionId) {
      // Filter interactions that occurred during the session
      const session = this.getSession(sessionId);
      if (session) {
        const startTime = new Date(session.startTime).getTime();
        const endTime = session.endTime ? new Date(session.endTime).getTime() : Date.now();
        
        return interactions.filter(interaction => {
          const interactionTime = new Date(interaction.timestamp).getTime();
          return interactionTime >= startTime && interactionTime <= endTime;
        });
      }
    }
    return interactions;
  }

  // Public logging methods
  debug(category: string, message: string, data?: any): void {
    this.log(LogLevel.DEBUG, category, message, data);
  }

  info(category: string, message: string, data?: any): void {
    this.log(LogLevel.INFO, category, message, data);
  }

  success(category: string, message: string, data?: any): void {
    this.log(LogLevel.SUCCESS, category, message, data);
  }

  warning(category: string, message: string, data?: any): void {
    this.log(LogLevel.WARNING, category, message, data);
  }

  error(category: string, message: string, data?: any): void {
    this.log(LogLevel.ERROR, category, message, data);
  }

  // Specialized logging methods for agent operations
  logAgentPlanning(plan: string, metadata?: any): void {
    this.info("AGENT_PLANNING", "Agent plan generated", {
      plan,
      ...metadata,
    });
  }

  logLLMCall(
    provider: string,
    model: string,
    prompt: string,
    metadata?: any
  ): void {
    this.debug("LLM_CALL", `LLM request to ${provider}/${model}`, {
      provider,
      model,
      promptLength: prompt.length,
      promptPreview: prompt.substring(0, 200) + "...",
      ...metadata,
    });
  }

  logLLMResponse(
    provider: string,
    model: string,
    response: string,
    metadata?: any
  ): void {
    this.debug("LLM_RESPONSE", `LLM response from ${provider}/${model}`, {
      provider,
      model,
      responseLength: response.length,
      responsePreview: response.substring(0, 200) + "...",
      ...metadata,
    });
  }

  logToolCall(agentName: string, toolName: string, params: any): void {
    this.info("TOOL_CALL", `${agentName} executing ${toolName}`, {
      agentName,
      toolName,
      params,
    });
  }

  logToolResult(agentName: string, toolName: string, result: any): void {
    this.info("TOOL_RESULT", `${agentName} ${toolName} completed`, {
      agentName,
      toolName,
      result,
    });
  }

  logWorkflowStart(prompt: string, config?: any): void {
    this.info("WORKFLOW_START", "Starting workflow execution", {
      prompt,
      config,
    });
  }

  logWorkflowEnd(success: boolean, result?: any, error?: any): void {
    if (success) {
      this.success("WORKFLOW_END", "Workflow completed successfully", {
        result,
      });
    } else {
      this.error("WORKFLOW_END", "Workflow failed", { error, result });
    }
  }

  logUserAction(action: string, details?: any): void {
    this.info("USER_ACTION", action, details);
  }

  logPerformance(operation: string, durationMs: number, details?: any): void {
    this.debug("PERFORMANCE", `${operation} took ${durationMs}ms`, {
      durationMs,
      ...details,
    });
  }

  // Get logs for debugging
  getLogs(filter?: {
    category?: string;
    level?: LogLevel;
    limit?: number;
  }): LogEntry[] {
    let filtered = [...this.logs];

    if (filter?.category) {
      filtered = filtered.filter((log) => log.category === filter.category);
    }

    if (filter?.level) {
      filtered = filtered.filter((log) => log.level === filter.level);
    }

    if (filter?.limit) {
      filtered = filtered.slice(-filter.limit);
    }

    return filtered;
  }

  // Clear logs
  clearLogs(): void {
    this.logs = [];
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.remove("debugLogs");
    }
    this.info("SYSTEM", "Logs cleared");
  }

  clearSessions(): void {
    this.sessions.clear();
    this.llmInteractions.clear();
    this.currentSessionId = null;
    this.info("SYSTEM", "Sessions cleared");
  }

  // Export logs as JSON
  exportLogs(): string {
    return JSON.stringify(this.logs, null, 2);
  }

  // Export session data with comprehensive information
  exportSessionData(sessionId?: string): string {
    const data: any = {
      exportTimestamp: new Date().toISOString(),
      exportVersion: '1.0',
      buildInfo: BUILD_INFO
    };
    
    if (sessionId) {
      const session = this.getSession(sessionId);
      if (session) {
        // Clone the session to avoid modifying the original
        const sessionCopy = { ...session };
        
        // If session is still running or has no logs, get logs from main log array
        // (logs are only copied to session.logs in endSession())
        if (sessionCopy.logs.length === 0 || sessionCopy.status === 'running') {
          sessionCopy.logs = this.logs.filter(log => log.sessionId === sessionId);
        }
        
        data.session = sessionCopy;
        data.llmInteractions = this.getLLMInteractions(sessionId);
      } else {
        throw new Error(`Session ${sessionId} not found`);
      }
    } else {
      data.sessions = this.getAllSessions();
      data.allLogs = this.logs;
      data.llmInteractions = Array.from(this.llmInteractions.values());
    }
    
    return JSON.stringify(data, null, 2);
  }

  // Export session data as downloadable file
  downloadSessionData(sessionId?: string, filename?: string): void {
    const data = this.exportSessionData(sessionId);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || `websape-session-${sessionId || 'all'}-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Load persisted logs
  async loadPersistedLogs(): Promise<void> {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage) {
        const result = await chrome.storage.local.get(["debugLogs"]);
        if (result.debugLogs) {
          this.logs = result.debugLogs;
        }
      }
    } catch (e) {
      console.error("Failed to load persisted logs:", e);
    }
  }
}

// Export singleton instance
export const logger = Logger.getInstance();

// Helper function for measuring performance
export function measurePerformance<T>(
  operation: string,
  fn: () => T | Promise<T>
): Promise<T> {
  const start = performance.now();
  const result = fn();

  if (result instanceof Promise) {
    return result.then((value) => {
      const duration = performance.now() - start;
      logger.logPerformance(operation, duration);
      return value;
    });
  } else {
    const duration = performance.now() - start;
    logger.logPerformance(operation, duration);
    return Promise.resolve(result);
  }
}