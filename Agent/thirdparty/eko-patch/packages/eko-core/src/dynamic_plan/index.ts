/**
 * Dynamic Plan — hook dispatcher.
 *
 * The voluntary-todo / incremental-replan path is gated behind
 * `config.enableEkoTodoRewrite`. The agent-side verification nudge
 * (`onBeforeReturn`) has its own `config.enableEkoPostVerify` and is
 * independent of the todo-rewrite flag.
 *
 * When `enableEkoTodoRewrite` is disabled (default), every hook here that
 * checks `isEnabled()` is a no-op and the original code paths run
 * unchanged. This module is the *only* import that existing eko files
 * need — keeping the upstream-conflict surface minimal.
 */

import config from "../config";
import { RetryLanguageModel } from "../llm";
import { AgentContext } from "../core/context";
import { Tool, ToolResult } from "../types/tools.types";
import { TodoWriteTool, getTodoState, markVerificationFired } from "./todo_write_tool";
import { shouldVerify, injectVerificationNudge } from "./verification";
import { tryIncrementalReplan } from "./incremental_replan";
import {
  LanguageModelV2Prompt,
  LanguageModelV2FunctionTool,
} from "@ai-sdk/provider";
import { logStatus } from "../agent/browser/snapshot_uploader";
import Log from "../common/log";

function isEnabled(): boolean {
  return config.enableEkoTodoRewrite === true;
}

// ---------------------------------------------------------------------------
// Pattern 1 — Voluntary TodoWrite tool
// ---------------------------------------------------------------------------

/**
 * Returns the TodoWriteTool instance to be added to the agent's toolset.
 * Returns null when enableEkoTodoRewrite is disabled.
 */
export function getDynamicPlanTools(): Tool[] {
  if (!isEnabled()) return [];
  return [new TodoWriteTool()];
}

/**
 * Returns a system prompt snippet instructing the agent to use the todo_write tool.
 * Returns empty string when enableEkoTodoRewrite is disabled.
 */
export function getDynamicPlanPrompt(): string {
  if (!isEnabled()) return "";
  return `
* TASK TRACKING
You have access to the \`todo_write\` tool to manage a task checklist. Use it to track your progress:
- At the START of a multi-step task, call \`todo_write\` to create your checklist with all planned steps (status: "pending").
- BEFORE starting work on a step, mark it as "in_progress". Keep exactly ONE item "in_progress" at a time.
- After completing each step, call \`todo_write\` to update the item to "completed" and mark the next as "in_progress".
- Mark tasks complete IMMEDIATELY after finishing — do not batch completions.
- ONLY mark a task as "completed" when you have FULLY accomplished it.
- Pass the FULL replacement array every time — items not included will be removed.
- For simple tasks with fewer than 3 steps, you can skip using this tool.

IMPORTANT — adapt your plan as you work:
- If you discover new sub-steps or obstacles during execution, ADD them to the list.
- If planned steps turn out to be unnecessary, REMOVE them from the list.
- If a step's scope changes, RENAME it to match what you actually need to do.
- Do NOT keep the original plan unchanged when reality diverges — update it.
`;
}

// ---------------------------------------------------------------------------
// Hooks called from base.ts
// ---------------------------------------------------------------------------

/**
 * Called in the ReAct loop when the agent did NOT produce a final result
 * (i.e. it made tool calls and will continue looping).
 *
 * Returns `true` if this hook handled the todo-check (so the caller should
 * skip the original forced doTodoListManager).
 */
export async function onLoopContinue(
  agentContext: AgentContext,
  _rlm: RetryLanguageModel,
  _messages: LanguageModelV2Prompt,
  _llmTools: LanguageModelV2FunctionTool[],
  _loopNum: number
): Promise<boolean> {
  if (!isEnabled()) return false;
  // When enableEkoTodoRewrite is on, the TodoWriteTool is in the toolset
  // and the agent calls it voluntarily — no forced audit needed.
  return true;
}

/**
 * Called when the agent is about to return a final result.
 *
 * Returns `true` if execution should proceed to return (verified / no check needed).
 * Returns `false` if the verification nudge was injected and the agent should
 * continue its loop instead of returning.
 *
 * Gated by BOTH `config.enableEkoTodoRewrite` AND `config.enableEkoPostVerify`.
 * The nudge is meaningless without `enableEkoTodoRewrite`: it relies on
 * `getTodoState(agentContext)` to count completed todos, which is only
 * populated by the `TodoWriteTool` registered behind `enableEkoTodoRewrite`.
 * With `enableEkoTodoRewrite=false` the todo state is always empty, so
 * `shouldVerify` would never trigger anyway — we short-circuit here so
 * `onBeforeReturn` stays a cheap no-op every loop iteration in that case.
 */
export async function onBeforeReturn(
  agentContext: AgentContext,
  _rlm: RetryLanguageModel,
  messages: LanguageModelV2Prompt,
  _llmTools: LanguageModelV2FunctionTool[]
): Promise<boolean> {
  if (!isEnabled()) return true;
  if (!config.enableEkoPostVerify) return true;
  try {
    const todoState = getTodoState(agentContext);
    if (shouldVerify(todoState)) {
      markVerificationFired(agentContext);
      injectVerificationNudge(messages, todoState);
      const completedItems = todoState.completed.map(t => t.content).join(', ');
      Log.info(
        `[Task ${agentContext.context.taskId}][${agentContext.agent.Name}] ` +
          `Dynamic plan verification nudge injected (${todoState.completed.length} completed items).`
      );
      logStatus(`[dynamic_plan:verification] Nudge injected. ${todoState.completed.length} completed items: ${completedItems.substring(0, 300)}`);
      return false; // tell base.ts to continue loop
    }
  } catch (e) {
    Log.error("eko-post-verify onBeforeReturn error:", e);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Hooks called from plan.ts
// ---------------------------------------------------------------------------
//
// Pre-plan exploration was previously implemented here as `exploreBeforePlan`
// and called from `core/plan.ts`. The host (e.g. websape's extension) now
// owns that step end-to-end — it runs its own goal-understanding LLM call
// before invoking `Eko.run()` and writes the result into the planner's
// `plan_ext_prompt` context variable. Keeping a duplicate explorer here
// caused two divergent prompts and double LLM cost when the host already
// drove one. Verification nudge (Pattern 5/B) still lives in this module
// via the `onBeforeReturn` hook above.

// ---------------------------------------------------------------------------
// Hooks called from replan.ts
// ---------------------------------------------------------------------------

export { tryIncrementalReplan, buildTodoSuffix } from "./incremental_replan";

export { isEnabled as isDynamicPlanEnabled };
