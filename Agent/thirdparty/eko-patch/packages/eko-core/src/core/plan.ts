import Log from "../common/log";
import Context from "./context";
import { sleep } from "../common/utils";
import { RetryLanguageModel } from "../llm";
import { parseWorkflow } from "../common/xml";
import { LLMRequest } from "../types/llm.types";
import { StreamCallback, Workflow } from "../types/core.types";
import { getPlanSystemPrompt, getPlanUserPrompt } from "../prompt/plan";
import { logPlanningResult } from "../agent/browser/snapshot_uploader";
import { estimatePromptTokens, estimateTokens } from "../agent/llm";
import {
  LanguageModelV2Prompt,
  LanguageModelV2FinishReason,
  LanguageModelV2StreamPart,
  LanguageModelV2TextPart,
} from "@ai-sdk/provider";

export class Planner {
  private taskId: string;
  private context: Context;
  private callback?: StreamCallback;

  constructor(context: Context, callback?: StreamCallback) {
    this.context = context;
    this.taskId = context.taskId;
    this.callback = callback || context.config.callback;
  }

  async plan(
    taskPrompt: string | LanguageModelV2TextPart,
    saveHistory: boolean = true
  ): Promise<Workflow> {
    let taskPromptStr;
    let userPrompt: LanguageModelV2TextPart;
    if (typeof taskPrompt === "string") {
      taskPromptStr = taskPrompt;
      // Pre-plan exploration is now driven by the host (see websape
      // extension's `explorer.ts`). The host writes any goal-analysis or
      // task-specific addendum into the `plan_ext_prompt` context variable
      // BEFORE calling `Eko.run()`; the planner just consumes it verbatim
      // here. Keeping the call inside core duplicated the LLM call when the
      // host had already done its own.
      const extPrompt = this.context.variables.get("plan_ext_prompt");
      userPrompt = {
        type: "text",
        text: getPlanUserPrompt(
          taskPrompt,
          this.context.variables.get("task_website"),
          extPrompt
        ),
      };
    } else {
      userPrompt = taskPrompt;
      taskPromptStr = taskPrompt.text || "";
    }
    const messages: LanguageModelV2Prompt = [
      {
        role: "system",
        content: await getPlanSystemPrompt(this.context),
      },
      {
        role: "user",
        content: [userPrompt],
      },
    ];
    return await this.doPlan(taskPromptStr, messages, saveHistory);
  }

  async replan(
    taskPrompt: string,
    saveHistory: boolean = true
  ): Promise<Workflow> {
    const chain = this.context.chain;
    if (chain.planRequest && chain.planResult) {
      const messages: LanguageModelV2Prompt = [
        ...chain.planRequest.messages,
        {
          role: "assistant",
          content: [{ type: "text", text: chain.planResult }],
        },
        {
          role: "user",
          content: [{ type: "text", text: taskPrompt }],
        },
      ];
      return await this.doPlan(taskPrompt, messages, saveHistory);
    } else {
      return this.plan(taskPrompt, saveHistory);
    }
  }

  async doPlan(
    taskPrompt: string,
    messages: LanguageModelV2Prompt,
    saveHistory: boolean,
    retryNum: number = 0
  ): Promise<Workflow> {
    const config = this.context.config;
    const rlm = new RetryLanguageModel(config.llms, config.planLlms);
    const correlation_id = this.context.variables.get('correlation_id');
    rlm.setContext(this.context);
    const request: LLMRequest = {
      maxTokens: 8192,
      temperature: 0.7,
      messages: messages,
      abortSignal: this.context.controller.signal,
      llm_call_annotation: `Planner for task ${this.taskId} doPlan`,
      correlation_id: correlation_id,
    };
    const llmCallStartTime = Date.now();
    const result = await rlm.callStream(request);
    const reader = result.stream.getReader();
    let streamText = "";
    let thinkingText = "";
    let finishReason: LanguageModelV2FinishReason = "stop";
    let finishUsage: Record<string, any> = {};
    let finishProviderMetadata: Record<string, any> = {};
    try {
      while (true) {
        await this.context.checkAborted(true);
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        let chunk = value as LanguageModelV2StreamPart;
        if (chunk.type == "error") {
          Log.error("Plan, LLM Error: ", chunk);
          throw new Error("LLM Error: " + chunk.error);
        }
        if (chunk.type == "reasoning-delta") {
          thinkingText += chunk.delta || "";
        }
        if (chunk.type == "text-delta") {
          streamText += chunk.delta || "";
        }
        if (chunk.type == "finish") {
          finishReason = chunk.finishReason;
          finishUsage = (chunk.usage || {}) as Record<string, any>;
          finishProviderMetadata = ((chunk as any).providerMetadata || {}) as Record<string, any>;
          if (chunk.finishReason == "content-filter") {
            throw new Error("LLM error: trigger content filtering violation");
          }
          if (chunk.finishReason == "other") {
            throw new Error("LLM error: terminated due to other reasons");
          }
        }
        if (this.callback) {
          let workflow = parseWorkflow(
            this.taskId,
            streamText,
            false,
            thinkingText
          );
          if (workflow) {
            await this.callback.onMessage({
              taskId: this.taskId,
              agentName: "Planer",
              type: "workflow",
              streamDone: false,
              workflow: workflow as Workflow,
            });
          }
        }
      }
    } catch (e: any) {
      if (retryNum < 3) {
        await sleep(1000);
        return await this.doPlan(taskPrompt, messages, saveHistory, ++retryNum);
      }
      throw e;
    } finally {
      reader.releaseLock();
      if (Log.isEnableInfo()) {
        Log.info("Planner result: \n" + streamText);
      }
    }
    // Emit planning token usage through the callback so it gets counted
    if (this.callback) {
      let inputTokens = finishUsage.inputTokens || finishUsage.promptTokens || finishUsage.prompt_tokens || finishUsage.input_tokens || 0;
      let outputTokens = finishUsage.outputTokens || finishUsage.completionTokens || finishUsage.completion_tokens || finishUsage.output_tokens || 0;
      const providerMeta = finishProviderMetadata.anthropic || {};
      const cachedInputTokens = finishUsage.cachedInputTokens || finishUsage.cache_read_input_tokens || providerMeta.cacheReadInputTokens || 0;
      const cacheCreationInputTokens = finishUsage.cacheCreationInputTokens || finishUsage.cache_creation_input_tokens || providerMeta.cacheCreationInputTokens || 0;
      let isEstimated = false;
      if (inputTokens === 0) {
        inputTokens = estimatePromptTokens(messages);
        isEstimated = true;
      }
      if (outputTokens === 0) {
        outputTokens = estimateTokens(streamText + thinkingText);
        isEstimated = true;
      }
      const totalTokens = finishUsage.totalTokens || finishUsage.total_tokens || (inputTokens + outputTokens);
      const llmCallDurationMs = Date.now() - llmCallStartTime;
      Log.info(`[Task ${this.taskId}][Planner] LLM call completed - Duration: ${llmCallDurationMs}ms, Input tokens: ${inputTokens}, Output tokens: ${outputTokens}, Total tokens: ${totalTokens}, Cached: ${cachedInputTokens}, CacheCreation: ${cacheCreationInputTokens}${isEstimated ? ' (estimated)' : ''}`);
      await this.callback.onMessage({
        taskId: this.taskId,
        agentName: "Planner",
        nodeId: "planner",
        type: "finish",
        finishReason: finishReason,
        usage: {
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          totalTokens: totalTokens,
          cachedInputTokens: cachedInputTokens || undefined,
          cacheCreationInputTokens: cacheCreationInputTokens || undefined,
          isEstimated,
          durationMs: llmCallDurationMs,
        },
      });
    }
    if (saveHistory) {
      const chain = this.context.chain;
      chain.planRequest = request;
      chain.planResult = streamText;
    }
    // Log planning result to snapshot
    logPlanningResult(streamText);
    let workflow = parseWorkflow(
      this.taskId,
      streamText,
      true,
      thinkingText
    ) as Workflow;
    if (this.callback) {
      await this.callback.onMessage({
        taskId: this.taskId,
        agentName: "Planer",
        type: "workflow",
        streamDone: true,
        workflow: workflow,
      });
    }
    if (workflow.taskPrompt) {
      workflow.taskPrompt += "\n" + taskPrompt;
    } else {
      workflow.taskPrompt = taskPrompt;
    }
    workflow.taskPrompt = workflow.taskPrompt.trim();
    return workflow;
  }
}
