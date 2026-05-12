/**
 * Pattern 3 — Incremental replan.
 *
 * Instead of regenerating all remaining workflow nodes from scratch,
 * first ask the LLM to produce a lightweight patch (which specific nodes
 * to update/insert/remove). Only if it determines a full replan is needed,
 * fall through to the original replanWorkflow().
 */

import config from "../config";
import { AgentContext } from "../core/context";
import { RetryLanguageModel } from "../llm";
import { LLMRequest } from "../types/llm.types";
import { Workflow, WorkflowAgent, LanguageModelV2Prompt } from "../types";
import { getTodoState, TodoState } from "./todo_write_tool";
import { logStatus } from "../agent/browser/snapshot_uploader";
import Log from "../common/log";

interface NodePatch {
  action: "update" | "insert_after" | "remove";
  nodeId: string;
  newTask?: string;
  newNodes?: string;
  insertAfterId?: string;
}

interface IncrementalReplanResult {
  needsFullReplan: boolean;
  patches?: NodePatch[];
}

/**
 * Attempt an incremental replan. Returns true if the incremental patch was
 * applied successfully and no full replan is needed.
 * Returns false to signal the caller should fall through to full replanWorkflow().
 */
export async function tryIncrementalReplan(
  agentContext: AgentContext,
  getAgentExecutionPrompt: (ctx: AgentContext) => string
): Promise<boolean> {
  if (!config.enableEkoTodoRewrite) return false;

  try {
    const context = agentContext.context;
    const chain = context.chain;
    if (!chain.planRequest || !chain.planResult) return false;

    const workflow = context.workflow as Workflow;
    const currentAgentId = agentContext.agentChain.agent.id;

    // Find unexecuted agents
    let currentIndex = -1;
    const unexecutedAgents: WorkflowAgent[] = [];
    for (let i = 0; i < workflow.agents.length; i++) {
      if (workflow.agents[i].id === currentAgentId) {
        currentIndex = i;
      }
      if (currentIndex >= 0 && i > currentIndex && workflow.agents[i].status === "init") {
        unexecutedAgents.push(workflow.agents[i]);
      }
    }

    if (unexecutedAgents.length === 0) return false;

    const rlm = new RetryLanguageModel(context.config.llms, context.config.planLlms);
    rlm.setContext(agentContext);

    const agentExecution = getAgentExecutionPrompt(agentContext);
    const todoSuffix = buildTodoSuffix(agentContext);
    const unexecutedSummary = unexecutedAgents
      .map((a) => `  - [${a.id}] ${a.name}: ${a.task}`)
      .join("\n");

    const prompt = `# Task Execution Status
${agentExecution}
${todoSuffix}
# Unexecuted Plan Nodes
${unexecutedSummary}

# Incremental Plan Check
Based on the results of executed tasks, determine if the remaining unexecuted nodes need changes.
Pay attention to the agent's task tracking — pending items indicate unfinished work that downstream nodes may need to absorb.

You must respond with one of:
1. "no_changes" — the remaining plan is still valid as-is
2. "incremental" — specific nodes need targeted updates (provide patches)
3. "full_replan" — the remaining plan is fundamentally wrong and needs full regeneration

For "incremental", describe each patch as: which node to update and what its new task should be.
Keep changes minimal — only patch what's actually broken.`;

    const functionName = "plan_patch_decision";
    const request: LLMRequest = {
      maxTokens: 1024,
      temperature: 0.7,
      messages: [
        ...chain.planRequest.messages,
        {
          role: "assistant",
          content: [{ type: "text", text: chain.planResult as string }],
        },
        { role: "user", content: [{ type: "text", text: prompt }] },
      ],
      abortSignal: context.controller.signal,
      tools: [
        {
          type: "function",
          name: functionName,
          description:
            "Decide whether to patch individual nodes, do a full replan, or keep the current plan.",
          inputSchema: {
            type: "object",
            properties: {
              thinking: {
                type: "string",
                description: "Brief analysis of what changed and why (100 words max).",
              },
              decision: {
                type: "string",
                enum: ["no_changes", "incremental", "full_replan"],
                description: "The replan decision.",
              },
              patches: {
                type: "array",
                description:
                  "Only for 'incremental': list of node patches to apply.",
                items: {
                  type: "object",
                  properties: {
                    action: {
                      type: "string",
                      enum: ["update", "remove"],
                      description: "What to do with this node.",
                    },
                    nodeId: {
                      type: "string",
                      description: "The id of the node to patch.",
                    },
                    newTask: {
                      type: "string",
                      description: "For 'update': the new task description.",
                    },
                  },
                  required: ["action", "nodeId"],
                },
              },
            },
            required: ["thinking", "decision"],
          },
        },
      ],
      toolChoice: { type: "tool", toolName: functionName },
    };

    const result = await rlm.call(request);
    let input = result.content.find((c) => c.type === "tool-call")?.input;
    if (input && typeof input === "string") {
      input = JSON.parse(input);
    }
    const decision = (input as any)?.decision;

    if (decision === "no_changes") {
      Log.info(
        `[Task ${context.taskId}] Incremental replan: no changes needed.`
      );
      logStatus(`[dynamic_plan:replan] Decision: no_changes. Thinking: ${(input as any)?.thinking || 'N/A'}`);
      return true; // skip full replan
    }

    if (decision === "incremental" && (input as any)?.patches) {
      const patches = (input as any).patches as NodePatch[];
      applyPatches(workflow, patches);
      workflow.modified = true;
      const patchSummary = patches.map(p => `${p.action}(${p.nodeId}${p.newTask ? ': ' + p.newTask.substring(0, 100) : ''})`).join(', ');
      Log.info(
        `[Task ${context.taskId}] Incremental replan: applied ${patches.length} patches.`
      );
      logStatus(`[dynamic_plan:replan] Decision: incremental. Patches: ${patchSummary}. Thinking: ${(input as any)?.thinking || 'N/A'}`);
      return true; // skip full replan
    }

    // decision === "full_replan" or unexpected — fall through
    Log.info(
      `[Task ${context.taskId}] Incremental replan: full replan needed.`
    );
    logStatus(`[dynamic_plan:replan] Decision: full_replan. Thinking: ${(input as any)?.thinking || 'N/A'}`);
    return false;
  } catch (e) {
    Log.error("tryIncrementalReplan error:", e);
    return false; // fall through to full replan on error
  }
}

function applyPatches(workflow: Workflow, patches: NodePatch[]): void {
  for (const patch of patches) {
    const agentIndex = workflow.agents.findIndex((a) => a.id === patch.nodeId);
    if (agentIndex === -1) continue;

    if (patch.action === "update" && patch.newTask) {
      workflow.agents[agentIndex].task = patch.newTask;
      // Update the XML representation
      const agent = workflow.agents[agentIndex];
      agent.xml = agent.xml.replace(
        /<task>[\s\S]*?<\/task>/,
        `<task>${patch.newTask}</task>`
      );
    } else if (patch.action === "remove") {
      // Mark as done/skipped so it won't be executed
      workflow.agents[agentIndex].status = "done";
    }
  }
}

/**
 * Build a todo-state suffix to append to the replan prompt.
 * Returns empty string if no todo state is available.
 */
export function buildTodoSuffix(agentContext: AgentContext): string {
  if (!config.enableEkoTodoRewrite) return "";
  const todoState = getTodoState(agentContext);
  if (todoState.items.length === 0) return "";

  const lines = todoState.items.map((t) => {
    const icon = t.status === "completed" ? "✅" : t.status === "in_progress" ? "🔄" : "⏳";
    return `  ${icon} ${t.content}`;
  });

  return `\n# Last Agent's Task Tracking\n${lines.join("\n")}\n`;
}
