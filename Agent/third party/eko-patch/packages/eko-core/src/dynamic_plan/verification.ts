/**
 * Pattern 5/B — Verification nudge.
 *
 * When the agent is about to return a final result and has 3+ completed
 * todo items, inject a verification message asking the agent to double-check
 * its work before returning. Fires at most once per agent run.
 */

import { TodoState } from "./todo_write_tool";
import { LanguageModelV2Prompt } from "@ai-sdk/provider";

const MIN_COMPLETED_FOR_VERIFICATION = 3;

/**
 * Determine whether a verification nudge should be injected.
 * Returns false if already fired once (prevents infinite loop).
 */
export function shouldVerify(todoState: TodoState): boolean {
  if (todoState.verificationFired) return false;
  return (
    todoState.completed.length >= MIN_COMPLETED_FOR_VERIFICATION &&
    todoState.pending.length === 0
  );
}

/**
 * Inject a verification nudge into the message history.
 * The agent will see this as a user message and should verify before returning.
 */
export function injectVerificationNudge(
  messages: LanguageModelV2Prompt,
  todoState: TodoState
): void {
  const completedSummary = todoState.completed
    .map((t) => `  - ${t.content}`)
    .join("\n");

  messages.push({
    role: "user",
    content: [
      {
        type: "text",
        text: `# Verification Required

You have completed ${todoState.completed.length} tasks:
${completedSummary}

Before returning your final result, please verify:
1. Review the current page state — does it reflect the expected outcome?
2. Were all task requirements actually met (not just attempted)?
3. Are there any error messages or unexpected states visible?

If everything checks out, proceed with your final answer. If not, take corrective action.`,
      },
    ],
  });
}
