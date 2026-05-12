/**
 * Pattern 1 — Voluntary TodoWrite tool.
 *
 * Unlike the original TodoListManagerTool (which is force-called every N
 * iterations), this is a regular tool that the agent calls whenever it wants.
 * The agent writes the full replacement todo array each time (same semantics
 * as Claude Code's TodoWrite). The agent can freely add, remove, rename,
 * and reorder items — the array is a full replacement each call.
 */

import { JSONSchema7 } from "json-schema";
import { AgentContext } from "../core/context";
import { Tool, ToolResult } from "../types/tools.types";
import Log from "../common/log";

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface TodoState {
  items: TodoItem[];
  completed: TodoItem[];
  pending: TodoItem[];
  verificationFired: boolean;
}

const TODO_STATE_KEY = "__dynamicPlan_todos";
const VERIFICATION_FIRED_KEY = "__dynamicPlan_verificationFired";

/**
 * Read the current todo state from the agent's context variables.
 */
export function getTodoState(agentContext: AgentContext): TodoState {
  const items: TodoItem[] =
    agentContext.variables.get(TODO_STATE_KEY) || [];
  return {
    items,
    completed: items.filter((t) => t.status === "completed"),
    pending: items.filter((t) => t.status !== "completed"),
    verificationFired: agentContext.variables.get(VERIFICATION_FIRED_KEY) === true,
  };
}

/**
 * Mark that the verification nudge has been fired for this agent run.
 */
export function markVerificationFired(agentContext: AgentContext): void {
  agentContext.variables.set(VERIFICATION_FIRED_KEY, true);
}

export class TodoWriteTool implements Tool {
  readonly name = "todo_write";
  readonly description =
    "Update the task checklist for the current session. Use proactively to " +
    "track progress and pending tasks. Pass the full replacement array " +
    "every time — items not included will be removed. You SHOULD freely add " +
    "new items discovered during execution, remove items that turned out " +
    "unnecessary, or rename items to match reality. Keep exactly one item " +
    '"in_progress" at all times. Use statuses: "pending", "in_progress", ' +
    '"completed". Mark tasks completed immediately after finishing, not in batches.';
  readonly parameters: JSONSchema7 = {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "The complete updated todo list. This is a full replacement — include ALL items you want to keep.",
        items: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "Short description of the task item.",
            },
            status: {
              type: "string",
              description: "Current status of the item.",
              enum: ["pending", "in_progress", "completed"],
            },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  };
  readonly supportParallelCalls = false;

  async execute(
    args: Record<string, unknown>,
    agentContext: AgentContext
  ): Promise<ToolResult> {
    const todos = (args.todos as TodoItem[]) || [];
    const oldTodos: TodoItem[] =
      agentContext.variables.get(TODO_STATE_KEY) || [];

    // Always store the current state — don't clear on allDone.
    // The verification nudge in onBeforeReturn needs to see completed items.
    agentContext.variables.set(TODO_STATE_KEY, todos);

    const completed = todos.filter((t) => t.status === "completed").length;
    const pending = todos.filter((t) => t.status !== "completed").length;

    // Compute structural diff between old and new todo lists
    const diff = computeTodoDiff(oldTodos, todos);

    Log.info(
      `[Task ${agentContext.context.taskId}][${agentContext.agent.Name}] ` +
        `TodoWrite: ${completed} completed, ${pending} pending, ${todos.length} total` +
        (diff ? ` | ${diff}` : "")
    );

    const resultParts: string[] = [
      `Todo list updated (${completed} completed, ${pending} pending).`,
    ];
    if (diff) {
      resultParts.push(`Changes: ${diff}`);
    }
    resultParts.push(
      "Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable."
    );

    return {
      content: [
        {
          type: "text",
          text: resultParts.join(" "),
        },
      ],
    };
  }
}

/**
 * Compute a human-readable diff between old and new todo lists.
 * Reports added, removed, and status-changed items.
 */
function computeTodoDiff(
  oldTodos: TodoItem[],
  newTodos: TodoItem[]
): string {
  if (oldTodos.length === 0) {
    // First call — everything is new, no diff needed
    return "";
  }

  const oldContents = new Set(oldTodos.map((t) => t.content));
  const newContents = new Set(newTodos.map((t) => t.content));

  const added = newTodos.filter((t) => !oldContents.has(t.content));
  const removed = oldTodos.filter((t) => !newContents.has(t.content));

  const oldStatusMap = new Map(oldTodos.map((t) => [t.content, t.status]));
  const statusChanged = newTodos.filter(
    (t) => oldStatusMap.has(t.content) && oldStatusMap.get(t.content) !== t.status
  );

  const parts: string[] = [];
  if (added.length > 0) {
    parts.push(`${added.length} added`);
  }
  if (removed.length > 0) {
    parts.push(`${removed.length} removed`);
  }
  if (statusChanged.length > 0) {
    parts.push(`${statusChanged.length} status changed`);
  }

  return parts.join(", ");
}
