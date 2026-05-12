/**
 * Multi-Agent Orchestrator
 *
 * This module implements a hierarchical multi-agent workflow where:
 * - A parent agent handles high-level planning and task decomposition
 * - Child agents execute individual sub-tasks with fresh context
 *
 * This approach helps manage context length by:
 * 1. Each child agent starts with a clean message history
 * 2. Only text summaries (not screenshots) are passed between parent and children
 * 3. The parent maintains a compressed history of completed sub-tasks
 */

import { 
  Eko, 
  LLMs, 
  StreamCallbackMessage, 
  HumanInteractTool, 
  config as ekoConfig, 
  clearProgress, 
  logStatus,
  logSubTaskStart,
  logSubTaskEnd,
  logParentPlanning,
  createScopedProgressTracker,
  mergeScopedTracker,
  RetryLanguageModel 
} from "@eko-ai/eko";
import { BrowserAgent } from "@eko-ai/eko-extension";
import { StreamCallback, HumanCallback, LLMConfig } from "@eko-ai/eko/types";
import { logger } from "../utils/logger";
import { ExecutionTracer } from "../utils/execution-tracer";
import {
  extractDomainsFromUrl,
  loadInstructionsForDomain,
  formatInstructionsForPrompt,
  type InstructionInfo,
} from "../utils/instruction-loader";
import { buildExperienceUsePrompt } from "../prompts/experience-use";

/**
 * Print log to extension UI panel
 * Sends as structured_log for visibility in the new UI
 */
function printLog(
  message: string,
  level?: "info" | "success" | "error" | "warning"
) {
  const logMessage = message + "";
  if (!logMessage || logMessage.trim() === "" || logMessage === "undefined" || logMessage === "null") {
    return;
  }
  
  // Send as structured_log (new UI format that gets displayed)
  // Use 'status' type which is already handled by the sidebar
  chrome.runtime.sendMessage({
    type: "structured_log",
    entry: {
      id: `multi_agent_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      type: "status",
      message: logMessage,
      level: level || "info",
    },
  });
}

// Default API key for SDF proxy (same as main.ts)
const DEFAULT_SDF_API_KEY = "websape-dev-key";

/**
 * Represents a sub-task decomposed from the main task
 */
export interface SubTask {
  id: string;
  description: string;
  contextSummary: string;
  successCriteria: string;
  priority: number;
  /**
   * Optional retrieval-friendly query the planner emits for this sub-task.
   * Used to select the most relevant prior experience for this child agent.
   * If absent, the orchestrator falls back to a concat of description /
   * contextSummary / successCriteria.
   */
  experienceQuery?: string;
}

/**
 * A prior-experience item passed into the orchestrator. Mirrors the shape
 * returned by experience selection, but kept narrow so multi-agent.ts does not
 * have to import RemoteSelectExperience from main.ts (which would create a
 * circular import).
 */
export interface ExperienceItem {
  id: string;
  task?: string;
  summary?: string;
  lessons?: string[];
  // Other fields (ts, success, trace, ...) returned by the server are
  // accepted but ignored by the orchestrator.
}

export interface ExperienceSelectionResult {
  experiences: ExperienceItem[];
  readCount: number;
  selectedCount: number;
  error?: string;
}

/**
 * Callback the orchestrator uses to fetch the most relevant experiences for a
 * specific (sub-)task query. Provided by main.ts.
 */
export type ExperienceSelector = (
  taskPrompt: string,
) => Promise<ExperienceSelectionResult>;

/**
 * Result of executing a sub-task
 */
export interface SubTaskResult {
  taskId: string;
  success: boolean;
  summary: string;  // Text-only summary for parent context
  extractedData?: Record<string, unknown>;
  errorMessage?: string;
  actionsPerformed: string[];
  finalState: string;
}

/**
 * Configuration for dynamic instruction loading in multi-agent mode
 */
export interface InstructionConfig {
  serverUrl: string;            // Server URL for fetching instructions
  version?: string;             // Instruction set version (e.g., "v1_2026_2_28")
}

/**
 * Configuration for the multi-agent orchestrator
 */
export interface MultiAgentConfig {
  maxSubTaskSteps: number;      // Max steps per child agent (default: 25)
  maxSubTasks: number;          // Max sub-tasks per planning iteration (default: 5)
  maxIterations: number;        // Max planning iterations (default: 10)
  maxHistorySummaries: number;  // Max completed task summaries to keep (default: 8)
  maxContinuations: number;     // Max continuation children for a single sub-task (default: 3)
  plannerModel?: string;        // Optional: use different model for planning
  childModel?: string;          // Optional: use lighter model for children
}

const DEFAULT_CONFIG: MultiAgentConfig = {
  maxSubTaskSteps: 25,
  maxSubTasks: 5,
  maxIterations: 10,
  maxHistorySummaries: 8,
  maxContinuations: 3,
};

/**
 * Multi-Agent Orchestrator
 * 
 * Coordinates parent and child agents to complete complex browser tasks
 * while managing context length through task decomposition.
 */
export class MultiAgentOrchestrator {
  private llms: LLMs;
  private agents: BrowserAgent[];
  private callback: StreamCallback & HumanCallback;
  private config: MultiAgentConfig;
  private tracer: ExecutionTracer;
  private completedSummaries: string[] = [];
  private abortController: AbortController;
  private childAgentIndex: number = 0;  // Track child agent numbering
  private currentChildTask: { eko: Eko; taskId: string } | null = null;  // Track current child for immediate abort
  private instructionConfig: InstructionConfig | null = null;  // Server config for loading instructions
  private instructionCache: Map<string, InstructionInfo> = new Map();  // Cached instructions keyed by domain

  // ── Experience injection ────────────────────────────────────────────────
  // Universal "meta" experience block (always shown when experience is on).
  private experienceMetaPrompt: string = "";
  // Selection chosen at the top level using the user's full task prompt.
  // Used for the parent planner and as a fallback when per-child selection
  // fails / is skipped / returns nothing.
  private parentExperiences: ExperienceItem[] = [];
  // Optional callback to re-select experiences for an individual sub-task.
  private experienceSelector: ExperienceSelector | null = null;
  // Per-child cache keyed by `${domain}::${subTaskId}` to avoid duplicate
  // server calls for continuations and same-domain sub-tasks.
  private experienceCache: Map<string, ExperienceItem[]> = new Map();

  constructor(
    llms: LLMs,
    agents: BrowserAgent[],
    callback: StreamCallback & HumanCallback,
    tracer: ExecutionTracer,
    config: Partial<MultiAgentConfig> = {},
    instructionConfig?: InstructionConfig,
    experienceMetaPrompt?: string,
    parentExperiences?: ExperienceItem[],
    experienceSelector?: ExperienceSelector,
  ) {
    this.llms = llms;
    this.agents = agents;
    this.callback = callback;
    this.tracer = tracer;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.abortController = new AbortController();
    this.instructionConfig = instructionConfig || null;
    this.experienceMetaPrompt = experienceMetaPrompt || "";
    this.parentExperiences = parentExperiences || [];
    this.experienceSelector = experienceSelector || null;
  }

  /**
   * Main entry point - runs the multi-agent workflow
   */
  async run(
    mainTask: string,
    contextParams?: Record<string, any>
  ): Promise<{ success: boolean; result: string }> {
    logger.info("MULTI_AGENT", "Starting multi-agent orchestration", {
      mainTask: mainTask.substring(0, 100),
      config: this.config,
    });

    this.completedSummaries = [];
    this.childAgentIndex = 0;  // Reset child agent counter
    this.experienceCache.clear();
    let iteration = 0;
    let lastError: string | null = null;

    console.log("🔀 [Multi-Agent Mode] Starting orchestration (console.log)");
    printLog("🔀 [Multi-Agent Mode] Starting orchestration", "info");

    try {
      while (iteration < this.config.maxIterations) {
        // Check for abort
        if (this.abortController.signal.aborted) {
          return { success: false, result: "Task was aborted by user" };
        }

        iteration++;
        logger.info("MULTI_AGENT", `Planning iteration ${iteration}/${this.config.maxIterations}`);
        console.log(`🧠 [Parent Agent] Planning iteration ${iteration} (console.log)`);
        
        // Visible UI log for parent agent planning
        printLog(`\n🧠 [Parent Agent] Planning iteration ${iteration}/${this.config.maxIterations}`, "info");
        printLog("   ├─ Analyzing current state...", "info");

        // Get current page state as compressed text
        const pageState = await this.getCompressedPageState();
        
        // Parent agent plans sub-tasks
        printLog("   ├─ Decomposing task into sub-tasks...", "info");
        const planResult = await this.planSubTasks(mainTask, pageState, lastError);
        
        if (planResult.isComplete) {
          logger.info("MULTI_AGENT", "Task completed successfully", {
            iterations: iteration,
            totalSubTasks: this.completedSummaries.length,
          });
          printLog(`\n✅ [Parent Agent] Task COMPLETED`, "success");
          printLog(`   └─ Total child agents used: ${this.childAgentIndex}`, "success");
          printLog("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━", "info");
          return { 
            success: true, 
            result: planResult.completionSummary || this.buildFinalSummary() 
          };
        }

        if (planResult.subTasks.length === 0) {
          logger.warning("MULTI_AGENT", "No sub-tasks generated, retrying planning");
          printLog("   └─ ⚠️ No sub-tasks generated, re-planning...", "warning");
          continue;
        }
        
        // Log planned sub-tasks
        printLog(`   └─ Planned ${planResult.subTasks.length} sub-task(s):`, "info");
        planResult.subTasks.forEach((task, idx) => {
          printLog(`      ${idx + 1}. ${task.description}`, "info");
        });
        
        // Log parent planning to progress tracker for snapshot display
        logParentPlanning(
          iteration,
          this.config.maxIterations,
          planResult.subTasks.map(task => ({
            id: task.id,
            description: task.description,
            successCriteria: task.successCriteria,
          }))
        );

        // Execute each sub-task with a fresh child agent
        for (const subTask of planResult.subTasks) {
          if (this.abortController.signal.aborted) {
            return { success: false, result: "Task was aborted by user" };
          }

          // Increment and display child agent index
          this.childAgentIndex++;
          const childLabel = `Child Agent #${this.childAgentIndex}`;
          
          printLog(`\n🤖 [${childLabel}] Starting execution`, "info");
          printLog(`   ├─ Sub-task: ${subTask.description}`, "info");
          printLog(`   ├─ Success criteria: ${subTask.successCriteria}`, "info");
          
          logger.info("MULTI_AGENT", `Executing sub-task: ${subTask.id}`, {
            description: subTask.description,
            childAgentIndex: this.childAgentIndex,
          });

          let result = await this.executeSubTask(subTask, contextParams, this.childAgentIndex);
          
          // ── Continuation mechanism ─────────────────────────────────────────
          // If the child reported success but its result suggests the work is
          // incomplete (e.g., it made progress but couldn't finish within the
          // step limit), spawn continuation children with fresh context.
          // The continuation child gets the same task + accumulated prior results.
          let continuationCount = 0;
          while (
            result.success &&
            this.isPartialCompletion(result) &&
            continuationCount < this.config.maxContinuations &&
            !this.abortController.signal.aborted
          ) {
            continuationCount++;
            this.childAgentIndex++;
            const contLabel = `Child Agent #${this.childAgentIndex}`;
            
            printLog(`\n🔄 [${contLabel}] Continuation #${continuationCount} for sub-task: ${subTask.id}`, "info");
            logger.info("MULTI_AGENT", `Continuation #${continuationCount} for ${subTask.id}`, {
              priorSummary: result.summary.substring(0, 200),
            });
            
            // Add partial result to summaries so the continuation child sees progress
            const partialEntry = `[${subTask.id}_cont${continuationCount - 1}] (partial) ${subTask.description}: ${result.summary}`;
            this.completedSummaries.push(partialEntry);
            if (this.completedSummaries.length > this.config.maxHistorySummaries) {
              this.completedSummaries = this.completedSummaries.slice(-this.config.maxHistorySummaries);
            }
            
            result = await this.executeSubTask(subTask, contextParams, this.childAgentIndex);
          }
          
          // Log child agent completion status
          if (result.success) {
            printLog(`   └─ ✅ [Child Agent #${this.childAgentIndex}] Completed successfully${continuationCount > 0 ? ` (after ${continuationCount} continuation(s))` : ''}`, "success");
          } else {
            printLog(`   └─ ❌ [Child Agent #${this.childAgentIndex}] Failed: ${result.errorMessage}`, "error");
          }
          
          // Add result summary to history (text only, no screenshots)
          const summaryEntry = `[${subTask.id}] ${subTask.description}: ${result.summary}`;
          this.completedSummaries.push(summaryEntry);
          
          // Keep only recent summaries to manage context
          if (this.completedSummaries.length > this.config.maxHistorySummaries) {
            this.completedSummaries = this.completedSummaries.slice(-this.config.maxHistorySummaries);
          }

          if (!result.success) {
            lastError = `Sub-task "${subTask.description}" failed: ${result.errorMessage}`;
            logger.warning("MULTI_AGENT", "Sub-task failed, will re-plan", {
              taskId: subTask.id,
              error: lastError,
            });
            printLog(`\n🧠 [Parent Agent] Re-planning due to child failure...`, "warning");
            break; // Re-plan after failure
          }

          lastError = null;
        }
      }

      // Max iterations reached
      logger.warning("MULTI_AGENT", "Max iterations reached without completion");
      printLog(`\n⚠️ [Parent Agent] Max iterations (${this.config.maxIterations}) reached`, "warning");
      printLog(`   └─ Total child agents used: ${this.childAgentIndex}`, "warning");
      printLog("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━", "info");
      return { 
        success: false, 
        result: `Task incomplete after ${this.config.maxIterations} iterations. ` +
                `Completed: ${this.buildFinalSummary()}` 
      };

    } catch (error) {
      logger.error("MULTI_AGENT", "Orchestration error", { error: String(error) });
      printLog(`\n❌ [Parent Agent] Orchestration error: ${error}`, "error");
      printLog("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━", "info");
      return { success: false, result: `Error: ${error}` };
    }
  }

  /**
   * Parent agent: Plans sub-tasks based on current state and history
   * Uses direct LLM API call instead of Eko.run() for simple text generation
   */
  private async planSubTasks(
    mainTask: string,
    pageState: string,
    lastError: string | null
  ): Promise<{ subTasks: SubTask[]; isComplete: boolean; completionSummary?: string }> {
    
    const historyContext = this.completedSummaries.length > 0
      ? `\n\nCompleted sub-tasks:\n${this.completedSummaries.join('\n')}`
      : '';

    const errorContext = lastError 
      ? `\n\nPrevious attempt failed: ${lastError}\nPlease adjust your approach.`
      : '';

    // Standing-experience guidance: meta lessons + parent-level selected
    // experiences. Kept separate from MAIN TASK so it reads as guidance, not
    // as part of the user request.
    const experienceBlock = this.buildExperienceBlock(this.parentExperiences);
    const experienceContext = experienceBlock
      ? `\n\n${experienceBlock}\n`
      : '';

    const planningPrompt = `You are a planning agent for browser automation. Analyze the task and current state to determine next steps.

MAIN TASK: ${mainTask}

CURRENT PAGE STATE:
${pageState}${this.getCachedInstructionSummary()}${experienceContext}
${historyContext}
${errorContext}

INSTRUCTIONS:
1. If the main task is COMPLETE, respond with: {"isComplete": true, "completionSummary": "description of what was accomplished"}
2. Otherwise, create sub-tasks using ONE of these two strategies:

   STRATEGY A — MULTI-PHASE (for tasks involving multiple websites or clear phases):
   Create 2-${this.config.maxSubTasks} sub-tasks when the task requires:
   - Working on DIFFERENT websites/domains (one sub-task per site)
   - Data from one site needed before acting on another
   Always include the full URL in the sub-task description when navigating to a site.

   STRATEGY B — FULL-TASK (for single-site tasks or when unsure how to split):
   Create just ONE sub-task with the complete objective.
   The system will automatically create continuation agents if the task needs more steps.
   This is the PREFERRED strategy when all work happens on the same website.

3. Each sub-task can perform many browser actions — do not create separate sub-tasks for individual clicks or searches on the same site.
4. Use "contextSummary" to pass critical information between sub-tasks. Be specific — include data values, names, URLs.
5. In successCriteria, specify what data the agent should report back.
6. For each sub-task, also emit "experienceQuery": a short retrieval-friendly phrase (target site/domain + main action + key entity) that will be used to look up the most relevant prior experience for that sub-task. Example: "ebay.com search and extract product price for headphones".

IMPORTANT: Respond ONLY with valid JSON, no other text.

{
  "isComplete": false,
  "reasoning": "your analysis of current state and what needs to be done",
  "subTasks": [
    {
      "id": "task_1",
      "description": "specific action to take",
      "contextSummary": "key information this sub-task needs from prior results or current state",
      "successCriteria": "how to verify this sub-task is complete — include what data to report back",
      "experienceQuery": "short retrieval-friendly phrase for selecting prior experience",
      "priority": 1
    }
  ]
}`;

    try {
      // Make direct LLM API call for planning (not Eko.run which creates workflow)
      const planningResult = await this.callLLMForPlanning(planningPrompt);
      
      logger.info("MULTI_AGENT", "Planning LLM response received", {
        responseLength: planningResult.length,
        responsePreview: planningResult.substring(0, 200),
      });
      
      // Parse the planning result
      return this.parsePlanningResult(planningResult);
      
    } catch (error) {
      logger.error("MULTI_AGENT", "Planning failed", { error: String(error) });
      return { subTasks: [], isComplete: false };
    }
  }

  /**
   * Make a direct LLM API call for planning (simple text completion)
   * Uses RetryLanguageModel from Eko to ensure consistent authentication handling
   */
  private async callLLMForPlanning(prompt: string): Promise<string> {
    // Get LLM config from the llms object
    const defaultLLM = this.llms.default;
    if (!defaultLLM) {
      throw new Error("No default LLM configured");
    }

    // Check for abort before making the call
    if (this.abortController.signal.aborted) {
      throw new Error("Planning aborted by user");
    }

    // Handle model which can be string or function
    let model: string;
    if (typeof defaultLLM.model === 'function') {
      model = await (defaultLLM.model as () => Promise<string>)();
    } else {
      model = defaultLLM.model as string;
    }

    logger.info("MULTI_AGENT", "Calling LLM for planning via RetryLanguageModel", {
      model,
      promptLength: prompt.length,
    });

    // Use RetryLanguageModel which properly handles authentication via Anthropic SDK
    const retryLLM = new RetryLanguageModel(this.llms, ['default']);
    
    // Build the LLM request with just the planning prompt
    // Include abortSignal so the request can be cancelled
    const request = {
      messages: [
        {
          role: 'user' as const,
          content: [{ type: 'text' as const, text: prompt }],
        }
      ],
      maxTokens: 2048,
      abortSignal: this.abortController.signal,
    };

    const llmCallStartTime = Date.now();

    try {
      const result = await retryLLM.call(request);

      // Emit a synthetic "finish" message so the parent planning call's token
      // usage is counted by the global counters in main.ts (same path as child
      // agent LLM calls).
      if (result.usage && this.callback.onMessage) {
        const inputTokens = result.usage.inputTokens || 0;
        const outputTokens = result.usage.outputTokens || 0;
        const totalTokens = inputTokens + outputTokens;
        const durationMs = Date.now() - llmCallStartTime;
        await this.callback.onMessage({
          taskId: `parent_planning_${Date.now()}`,
          agentName: "Parent Planner",
          nodeId: "parent_planner",
          type: "finish",
          finishReason: result.finishReason || "stop",
          usage: {
            promptTokens: inputTokens,
            completionTokens: outputTokens,
            totalTokens,
            isEstimated: false,
            durationMs,
          },
        } as any);
        logger.info("MULTI_AGENT", "Parent planning LLM token usage emitted", {
          inputTokens,
          outputTokens,
          totalTokens,
          durationMs,
        });
      }
      
      // Extract text from result
      if (result.text) {
        return result.text;
      }
      
      // Try to extract from content array
      if (result.content && Array.isArray(result.content)) {
        const textContent = result.content.find((c: any) => c.type === 'text');
        if (textContent && 'text' in textContent) {
          return textContent.text;
        }
      }
      
      logger.error("MULTI_AGENT", "Unexpected LLM response format", { result });
      throw new Error("Unexpected LLM response format");
    } catch (error: any) {
      // Check if this is an abort
      if (error?.name === 'AbortError' || this.abortController.signal.aborted) {
        logger.info("MULTI_AGENT", "LLM call aborted", { reason: error.message });
        throw new Error("Planning aborted by user");
      }
      
      console.error("❌ [Multi-Agent] LLM API error:", error);
      printLog(`❌ [Multi-Agent] LLM API error: ${error.message || String(error)}`, "error");
      
      logger.error("MULTI_AGENT", "LLM API error", {
        error: String(error),
        message: error.message,
      });
      throw error;
    }
  }

  /**
   * Child agent: Executes a single sub-task with fresh context
   */
  private async executeSubTask(
    subTask: SubTask,
    contextParams?: Record<string, any>,
    childAgentIndex?: number
  ): Promise<SubTaskResult> {
    // Create agentPrefix for this child (e.g., "[Child #1]")
    // Used consistently for both logStatus and logSubTaskStart so the UI can match them.
    const agentPrefix = `[Child #${childAgentIndex}]`;
    const childLabel = childAgentIndex ? `Child #${childAgentIndex}` : `Child`;
    
    // Load topology instructions for the child's target site (lazy, cached)
    // Uses URLs from the sub-task description to determine target site,
    // falling back to the current page URL if no URL found in description.
    const instructionBlock = await this.loadInstructionForSubTask(agentPrefix, childLabel, subTask);

    // Pick the most relevant prior experiences for THIS sub-task. Falls back
    // to the parent-level selection if no per-child selector is configured,
    // the call fails / times out, or returns nothing.
    const childExperienceBlock = await this.loadExperienceForSubTask(agentPrefix, childLabel, subTask);

    // Build context from prior completed sub-task summaries so the child
    // knows what previous children discovered (e.g., prices, item names).
    const priorContext = this.completedSummaries.length > 0
      ? `\n\nPRIOR SUB-TASK RESULTS (use this information, do NOT repeat these steps):\n${this.completedSummaries.join('\n')}`
      : '';

    const experiencePrefix = childExperienceBlock ? `${childExperienceBlock}\n\n` : '';
    const childPrompt = `${experiencePrefix}You are a focused browser automation agent. Complete ONLY the following specific task:

TASK: ${subTask.description}

${subTask.contextSummary ? `CONTEXT: ${subTask.contextSummary}\n\n` : ''}SUCCESS CRITERIA: ${subTask.successCriteria}
${priorContext}

IMPORTANT:
- Focus only on this specific task
- Use any information from prior sub-task results above — do not re-discover what is already known
- If a website navigation guide is provided in the system prompt, use its selectors and navigation paths
- Stop as soon as the success criteria is met
- Do not perform any actions beyond this task
- If your task depends on data from a prior sub-task, that data is provided in PRIOR SUB-TASK RESULTS above
- Report what you accomplished and any key data you found or extracted`;

    // Create a scoped progress tracker for this child agent
    // This isolates child's progress from parent and other children
    createScopedProgressTracker(subTask.id);
    logger.info("MULTI_AGENT", `Created scoped progress tracker for ${subTask.id}`);
    
    // Log sub-task start to progress tracker for snapshot display
    logSubTaskStart(subTask.id, subTask.description, agentPrefix, subTask.successCriteria);

    try {
      // Create a NEW Eko instance for the child agent
      // This ensures fresh message history (key for context management!)
      const childEko = new Eko({ 
        llms: this.llms, 
        agents: this.agents,
        callback: this.createChildCallback(subTask.id, childAgentIndex),
      });
      
      // Generate a taskId and track for immediate abort capability
      const childTaskId = `child_${subTask.id}_${Date.now()}`;
      this.currentChildTask = { eko: childEko, taskId: childTaskId };

      logger.info("MULTI_AGENT", `Child agent starting for ${subTask.id}`);
      printLog(`   ├─ [${childLabel}] Executing browser actions...`, "info");

      // Execute with step limit via context params (pass explicit taskId for abort support)
      // Pass agentPrefix through contextParams so it gets logged with each tool call
      // Pass websiteNavigationGuide so eko-core injects it into the agent's system prompt
      // (bypasses the planner which would choke on large instruction content)
      const result = await childEko.run(childPrompt, childTaskId, {
        ...contextParams,
        maxSteps: this.config.maxSubTaskSteps,
        subTaskId: subTask.id,
        agentPrefix,  // This will be available as context.variables.get("agentPrefix") in eko-core
        websiteNavigationGuide: instructionBlock || undefined,  // Injected into agent system prompt via extSysPrompt
      });

      const actionsPerformed = this.extractActionsFromResult(result);
      
      // Clear current child task reference
      this.currentChildTask = null;
      
      // Log sub-task completion
      logSubTaskEnd(subTask.id, agentPrefix, result.success, result.result);
      
      // Merge scoped progress back to main tracker when child completes
      mergeScopedTracker(subTask.id);
      logger.info("MULTI_AGENT", `Merged scoped progress for ${subTask.id}`);
      
      return {
        taskId: subTask.id,
        success: result.success,
        summary: this.summarizeResult(result, subTask),
        actionsPerformed,
        finalState: await this.getCompressedPageState(),
        errorMessage: result.success ? undefined : result.result,
      };

    } catch (error) {
      logger.error("MULTI_AGENT", `Child agent error for ${subTask.id}`, { 
        error: String(error) 
      });
      
      // Clear current child task reference
      this.currentChildTask = null;
      
      // Log sub-task failure
      logSubTaskEnd(subTask.id, agentPrefix, false, String(error));
      
      // Still merge progress on error to capture what was attempted
      mergeScopedTracker(subTask.id);
      
      return {
        taskId: subTask.id,
        success: false,
        summary: `Failed: ${error}`,
        actionsPerformed: [],
        finalState: await this.getCompressedPageState(),
        errorMessage: String(error),
      };
    }
  }

  /**
   * Creates a wrapped callback for child agents that tracks sub-task context
   */
  private createChildCallback(subTaskId: string, childAgentIndex?: number): StreamCallback & HumanCallback {
    const childLabel = childAgentIndex ? `Child #${childAgentIndex}` : 'Child';
    const agentPrefix = childAgentIndex ? `[Child #${childAgentIndex}] ` : '';
    
    return {
      ...this.callback,
      onMessage: async (message: StreamCallbackMessage) => {
        // Add sub-task context and child agent index to messages
        // Also add agentPrefix for UI display purposes
        const enhancedMessage = {
          ...message,
          subTaskId,
          childAgentIndex,
          agentPrefix,  // This will be used by sidebar to prefix UI elements
        };
        
        // Forward to parent callback (this handles all the UI display)
        if (this.callback.onMessage) {
          await this.callback.onMessage(enhancedMessage);
        }
      },
    };
  }

  /**
   * Extract URLs from text (sub-task description, context, etc.)
   * Returns an array of full URL strings found in the text.
   */
  private extractUrlsFromText(text: string): string[] {
    const urls: string[] = [];
    // Match http/https URLs
    const urlPattern = /https?:\/\/[^\s,)>\]"']+/gi;
    let match;
    while ((match = urlPattern.exec(text)) !== null) {
      urls.push(match[0]);
    }
    return urls;
  }

  /**
   * Loads topology instructions for a child agent's target site.
   * 
   * Determines the target site by:
   * 1. Extracting URLs from the sub-task description/context (preferred — matches where the child is GOING)
   * 2. Falling back to the current page URL (where the child IS right now)
   * 
   * Uses a cache to avoid re-fetching instructions for the same domain.
   * Returns formatted instruction block or empty string.
   */
  private async loadInstructionForSubTask(agentPrefix: string, childLabel: string, subTask: SubTask): Promise<string> {
    if (!this.instructionConfig) {
      return '';
    }

    try {
      // Strategy 1: Extract target URL from sub-task description and context
      const textToSearch = `${subTask.description} ${subTask.contextSummary || ''}`;
      const taskUrls = this.extractUrlsFromText(textToSearch);
      
      // Try domains from task description URLs first (this is where the child is GOING)
      for (const taskUrl of taskUrls) {
        const domains = extractDomainsFromUrl(taskUrl);
        for (const domain of domains) {
          // Check cache
          const cached = this.instructionCache.get(domain);
          if (cached) {
            if (cached.found && cached.content) {
              logger.info("MULTI_AGENT", `Instruction cache hit for ${domain} (from task URL)`, { childLabel });
              const sizeKB = (cached.content.length / 1024).toFixed(1);
              const versionTag = cached.version ? ` (${cached.version})` : '';
              printLog(`   ├─ [${childLabel}] 📖 Using cached guide: ${cached.matchedDomain || domain}${versionTag} (${sizeKB} KB)`, "info");
              logStatus(`instruction_cache_hit domain=${domain} guide="${cached.displayName || domain}" size=${sizeKB}KB source=task_url`, agentPrefix);
              return formatInstructionsForPrompt(cached);
            }
            // Cached as "not found" — skip this domain
            continue;
          }
          
          // Cache miss — fetch from server
          logger.info("MULTI_AGENT", `Loading instructions for ${domain} (from task URL: ${taskUrl})`, { childLabel });
          printLog(`   ├─ [${childLabel}] Loading navigation guide for ${domain}...`, "info");
          
          const info = await loadInstructionsForDomain(
            domain,
            this.instructionConfig.serverUrl,
            this.instructionConfig.version
          );
          
          // Cache the result
          const cacheKey = info.found && info.matchedDomain ? info.matchedDomain : domain;
          this.instructionCache.set(cacheKey, info);
          if (cacheKey !== domain) {
            this.instructionCache.set(domain, info);
          }
          
          if (info.found && info.content) {
            const sizeKB = (info.content.length / 1024).toFixed(1);
            const versionTag = info.version ? ` (${info.version})` : '';
            printLog(`   ├─ [${childLabel}] 📖 Loaded: ${info.matchedDomain || domain}${versionTag} (${sizeKB} KB)`, "success");
            logStatus(`instruction_loaded domain=${info.matchedDomain} guide="${info.displayName || info.matchedDomain}" size=${sizeKB}KB version="${info.version || 'default'}" source=task_url`, agentPrefix);
            return formatInstructionsForPrompt(info);
          }
        }
      }

      // Strategy 2: Fall back to current page URL (where the child IS right now)
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs.length === 0 || !tabs[0].url) {
        return '';
      }

      const currentUrl = tabs[0].url;
      const currentDomains = extractDomainsFromUrl(currentUrl);
      if (currentDomains.length === 0) {
        return '';
      }

      // Check cache for current page domains
      for (const domain of currentDomains) {
        const cached = this.instructionCache.get(domain);
        if (cached) {
          if (cached.found && cached.content) {
            logger.info("MULTI_AGENT", `Instruction cache hit for ${domain} (from current page)`, { childLabel });
            const sizeKB = (cached.content.length / 1024).toFixed(1);
            const versionTag = cached.version ? ` (${cached.version})` : '';
            printLog(`   ├─ [${childLabel}] 📖 Using cached guide: ${cached.matchedDomain || domain}${versionTag} (${sizeKB} KB)`, "info");
            logStatus(`instruction_cache_hit domain=${domain} guide="${cached.displayName || domain}" size=${sizeKB}KB source=current_page`, agentPrefix);
            return formatInstructionsForPrompt(cached);
          }
          // Cached as "not found"
          logStatus(`instruction_cache_hit domain=${domain} result=not_found source=current_page`, agentPrefix);
          return '';
        }
      }

      // Cache miss for current page — fetch from server
      const primaryDomain = currentDomains[0];
      logger.info("MULTI_AGENT", `Loading instructions for ${primaryDomain} (from current page)`, { childLabel, url: currentUrl });
      printLog(`   ├─ [${childLabel}] Loading navigation guide for ${primaryDomain}...`, "info");

      const info = await loadInstructionsForDomain(
        primaryDomain,
        this.instructionConfig.serverUrl,
        this.instructionConfig.version
      );

      const cacheKey = info.found && info.matchedDomain ? info.matchedDomain : primaryDomain;
      this.instructionCache.set(cacheKey, info);
      if (cacheKey !== primaryDomain) {
        this.instructionCache.set(primaryDomain, info);
      }

      if (info.found && info.content) {
        const sizeKB = (info.content.length / 1024).toFixed(1);
        const versionTag = info.version ? ` (${info.version})` : '';
        printLog(`   ├─ [${childLabel}] 📖 Loaded: ${info.matchedDomain || primaryDomain}${versionTag} (${sizeKB} KB)`, "success");
        logStatus(`instruction_loaded domain=${info.matchedDomain} guide="${info.displayName || info.matchedDomain}" size=${sizeKB}KB version="${info.version || 'default'}" source=current_page`, agentPrefix);
        return formatInstructionsForPrompt(info);
      } else {
        printLog(`   ├─ [${childLabel}] No navigation guide available`, "info");
        logStatus(`instruction_not_found domain=${primaryDomain} source=current_page`, agentPrefix);
        return '';
      }
    } catch (error) {
      logger.warning("MULTI_AGENT", "Failed to load instruction for sub-task", { error: String(error) });
      logStatus(`instruction_error error="${String(error).substring(0, 200)}"`, agentPrefix);
      return '';
    }
  }

  /**
   * Gets a summary of cached instruction domains for the parent planner.
   * Returns a one-line string listing domains with available guides.
   */
  private getCachedInstructionSummary(): string {
    const loadedDomains: string[] = [];
    for (const [domain, info] of this.instructionCache) {
      if (info.found && info.content) {
        loadedDomains.push(info.displayName || domain);
      }
    }
    if (loadedDomains.length === 0) return '';
    // Deduplicate (matchedDomain and primaryDomain may both point to same info)
    const unique = [...new Set(loadedDomains)];
    return `\nAvailable navigation guides (loaded for child agents): ${unique.join(', ')}`;
  }

  /**
   * Builds the textual experience block (meta lessons + selected experiences)
   * for either the parent planner or a child agent.
   */
  private buildExperienceBlock(experiences: ExperienceItem[]): string {
    const meta = (this.experienceMetaPrompt || '').trim();
    const selected = (experiences || []).filter(Boolean);
    if (!selected.length && !meta) return '';

    let body = meta;
    if (selected.length) {
      const payload = selected.map((e) => ({
        id: String(e.id ?? ''),
        task: typeof e.task === 'string' ? e.task : '',
        summary: typeof e.summary === 'string' ? e.summary : '',
        lessons: Array.isArray(e.lessons) ? (e.lessons as string[]) : [],
      }));
      const useBlock = buildExperienceUsePrompt({ experiences: payload });
      body = body ? `${body}\n\n${useBlock}` : useBlock;
    }
    return body.trim();
  }

  /**
   * Builds a focused retrieval query for the child's experience selection.
   * Prefers the planner-supplied `experienceQuery`, otherwise concatenates
   * description + contextSummary + successCriteria. Always appends a domain
   * hint extracted from the sub-task text when available, since experiences
   * are typically site-keyed.
   */
  private buildChildExperienceQuery(subTask: SubTask, domainHint: string | null): string {
    const base = (subTask.experienceQuery && subTask.experienceQuery.trim())
      || [subTask.description, subTask.contextSummary, subTask.successCriteria]
        .filter((s) => typeof s === 'string' && s.trim())
        .join('\n');
    if (domainHint) {
      return `${base}\nTarget: ${domainHint}`;
    }
    return base;
  }

  /**
   * Picks the most relevant prior experiences for THIS sub-task and returns
   * a fully-formatted experience prompt block. Caches by (domain, subTaskId)
   * so continuations and repeated same-domain sub-tasks reuse the result.
   *
   * Falls back to `parentExperiences` whenever:
   *   - no selector is configured
   *   - the selector errors / times out / returns empty
   */
  private async loadExperienceForSubTask(
    agentPrefix: string,
    childLabel: string,
    subTask: SubTask,
  ): Promise<string> {
    // No experience configured at all → nothing to inject.
    if (!this.experienceMetaPrompt && this.parentExperiences.length === 0 && !this.experienceSelector) {
      return '';
    }

    // Determine domain hint from the sub-task text (preferred) or current page.
    const taskUrls = this.extractUrlsFromText(`${subTask.description} ${subTask.contextSummary || ''}`);
    let domainHint: string | null = null;
    if (taskUrls.length > 0) {
      const doms = extractDomainsFromUrl(taskUrls[0]);
      if (doms.length > 0) domainHint = doms[0];
    }
    if (!domainHint) {
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs.length > 0 && tabs[0].url) {
          const doms = extractDomainsFromUrl(tabs[0].url);
          if (doms.length > 0) domainHint = doms[0];
        }
      } catch {
        // ignore
      }
    }

    const cacheKey = `${domainHint || 'unknown'}::${subTask.id}`;
    let chosen: ExperienceItem[] | undefined = this.experienceCache.get(cacheKey);

    if (!chosen) {
      if (this.experienceSelector) {
        const query = this.buildChildExperienceQuery(subTask, domainHint);
        try {
          const res = await this.experienceSelector(query);
          if (res.experiences && res.experiences.length > 0) {
            chosen = res.experiences;
          }
          logStatus(
            `experience_selected_child subTask=${subTask.id} domain=${domainHint || 'unknown'} read=${res.readCount} selected=${res.selectedCount}${res.error ? ` error=${res.error}` : ''}`,
            agentPrefix,
          );
        } catch (error) {
          logger.warning('MULTI_AGENT', 'Per-child experience selection failed, falling back', {
            error: String(error),
            subTaskId: subTask.id,
          });
          logStatus(
            `experience_selected_child subTask=${subTask.id} error="${String(error).substring(0, 120)}" fallback=parent`,
            agentPrefix,
          );
        }
      }

      // Fallback: parent-level selection (still better than nothing).
      if (!chosen || chosen.length === 0) {
        chosen = this.parentExperiences;
      }
      this.experienceCache.set(cacheKey, chosen);
    } else {
      logStatus(
        `experience_cache_hit_child subTask=${subTask.id} domain=${domainHint || 'unknown'} count=${chosen.length}`,
        agentPrefix,
      );
    }

    const block = this.buildExperienceBlock(chosen);
    if (block) {
      printLog(`   ├─ [${childLabel}] 📚 Injected ${chosen.length} experience item(s) (domain=${domainHint || 'unknown'})`, 'info');
    }
    return block;
  }

  /**
   * Gets current page state as compressed text (NOT screenshot)
   * This is critical for context management - we use text instead of images
   */
  private async getCompressedPageState(): Promise<string> {
    try {
      // Get active tab info
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs.length === 0) {
        return "No active tab";
      }
      
      const tab = tabs[0];
      const url = tab.url || "unknown";
      const title = tab.title || "unknown";

      // Build text-only state description
      return `URL: ${url}\nPage Title: ${title}`;
      
    } catch (error) {
      logger.warning("MULTI_AGENT", "Failed to get page state", { error: String(error) });
      return "Unable to determine current page state";
    }
  }

  /**
   * Parses the JSON planning result from the planner agent
   */
  private parsePlanningResult(result: string): { 
    subTasks: SubTask[]; 
    isComplete: boolean; 
    completionSummary?: string 
  } {
    try {
      // Try to extract JSON from the result
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warning("MULTI_AGENT", "No JSON found in planning result");
        return { subTasks: [], isComplete: false };
      }

      const parsed = JSON.parse(jsonMatch[0]);
      
      if (parsed.isComplete) {
        return { 
          subTasks: [], 
          isComplete: true, 
          completionSummary: parsed.completionSummary 
        };
      }

      const subTasks: SubTask[] = (parsed.subTasks || []).map((task: any, index: number) => ({
        id: task.id || `task_${index + 1}`,
        description: task.description || '',
        contextSummary: task.contextSummary || '',
        successCriteria: task.successCriteria || 'Task completed',
        priority: task.priority || index + 1,
        experienceQuery: typeof task.experienceQuery === 'string' && task.experienceQuery.trim()
          ? task.experienceQuery.trim()
          : undefined,
      }));

      // Sort by priority
      subTasks.sort((a, b) => a.priority - b.priority);

      return { subTasks, isComplete: false };

    } catch (error) {
      logger.error("MULTI_AGENT", "Failed to parse planning result", { 
        error: String(error),
        result: result.substring(0, 500),
      });
      return { subTasks: [], isComplete: false };
    }
  }

  /**
   * Extracts action descriptions from Eko result
   */
  private extractActionsFromResult(result: any): string[] {
    // This would ideally parse the execution trace
    // For now, return a placeholder
    return result.success ? ["Actions completed"] : ["Actions attempted but failed"];
  }

  /**
   * Creates a text summary of the sub-task result (no screenshots)
   * Preserves the LLM's actual output so subsequent children and the parent
   * planner can see what data was extracted or what state was reached.
   */
  private summarizeResult(result: any, subTask: SubTask): string {
    const resultText = typeof result.result === 'string' && result.result.trim()
      ? result.result.trim()
      : '';
    if (result.success) {
      return resultText
        ? `Completed: ${subTask.description}. Result: ${resultText}`
        : `Completed: ${subTask.description}`;
    } else {
      return `Failed: ${resultText || 'Unknown error'}`;
    }
  }

  /**
   * Detects if a child agent's "success" result is actually a partial completion
   * that needs continuation. This happens when the agent made progress but
   * couldn't finish the full task within its step limit.
   * 
   * Heuristics:
   * - Result text mentions being incomplete, needing more steps, or being cut off
   * - Result text is very short (< 50 chars) suggesting the agent was interrupted
   * - The stopReason from eko was not explicitly "done" with a substantive result
   */
  private isPartialCompletion(result: SubTaskResult): boolean {
    if (!result.success) return false;
    
    const summary = result.summary.toLowerCase();
    
    // Check for explicit partial completion indicators in the result
    const partialIndicators = [
      'not yet complete',
      'not yet finished',
      'still in progress',
      'need more steps',
      'could not finish',
      'ran out of steps',
      'partially complete',
      'incomplete',
      'continuation needed',
      'more actions needed',
      'did not finish',
      'was unable to complete',
      'step limit',
    ];
    
    for (const indicator of partialIndicators) {
      if (summary.includes(indicator)) {
        logger.info("MULTI_AGENT", `Partial completion detected: "${indicator}"`);
        return true;
      }
    }
    
    return false;
  }

  /**
   * Builds the final summary from completed sub-tasks
   */
  private buildFinalSummary(): string {
    if (this.completedSummaries.length === 0) {
      return "No sub-tasks were completed";
    }
    return this.completedSummaries.join('\n');
  }

  /**
   * Aborts the multi-agent workflow immediately
   * Stops the current child Eko if running and signals abort to all async operations
   */
  abort(reason?: string): void {
    logger.info("MULTI_AGENT", "Aborting multi-agent workflow", { reason });
    
    // Signal abort to all async operations (planning, etc.)
    this.abortController.abort(reason);
    
    // Immediately abort the current child task if one is running
    if (this.currentChildTask) {
      logger.info("MULTI_AGENT", "Aborting current child Eko agent", { taskId: this.currentChildTask.taskId });
      try {
        this.currentChildTask.eko.abortTask(this.currentChildTask.taskId, reason || "User requested abort");
      } catch (e) {
        logger.warning("MULTI_AGENT", "Error aborting child Eko", { error: String(e) });
      }
      this.currentChildTask = null;
    }
  }

  /**
   * Resets the orchestrator for a new task
   */
  reset(): void {
    this.completedSummaries = [];
    this.childAgentIndex = 0;
    this.currentChildTask = null;
    this.abortController = new AbortController();
    this.instructionCache.clear();
    this.experienceCache.clear();
  }
}

/**
 * Factory function to create a multi-agent orchestrator with standard configuration
 */
export function createMultiAgentOrchestrator(
  llms: LLMs,
  agents: BrowserAgent[],
  callback: StreamCallback & HumanCallback,
  tracer: ExecutionTracer,
  customConfig?: Partial<MultiAgentConfig>,
  instructionConfig?: InstructionConfig,
  experienceMetaPrompt?: string,
  parentExperiences?: ExperienceItem[],
  experienceSelector?: ExperienceSelector,
): MultiAgentOrchestrator {
  return new MultiAgentOrchestrator(
    llms,
    agents,
    callback,
    tracer,
    customConfig,
    instructionConfig,
    experienceMetaPrompt,
    parentExperiences,
    experienceSelector,
  );
}
