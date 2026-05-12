import config from "../config";
import Log from "../common/log";
import * as memory from "../memory";
import { RetryLanguageModel } from "../llm";
import { extractToolCallsFromText } from "../llm/qwen-fetch-adapter";
import { AgentContext } from "../core/context";
import { uuidv4, sleep, toFile, getMimeType } from "../common/utils";
import { logReasoning } from "./browser/snapshot_uploader";
import {
  Tool,
  LLMRequest,
  ToolResult,
  DialogueTool,
  StreamResult,
  HumanCallback,
  StreamCallback,
  StreamCallbackMessage,
} from "../types";
import {
  LanguageModelV2Prompt,
  LanguageModelV2TextPart,
  SharedV2ProviderOptions,
  LanguageModelV2ToolChoice,
  LanguageModelV2StreamPart,
  LanguageModelV2ToolCallPart,
  LanguageModelV2FunctionTool,
  LanguageModelV2ToolResultPart,
  LanguageModelV2ToolResultOutput,
} from "@ai-sdk/provider";
import { isRateLimitError, getRateLimitDelay, RATE_LIMIT_MAX_RETRIES } from "../llm";

export function defaultLLMProviderOptions(): SharedV2ProviderOptions {
  return {
    openai: {
      stream_options: {
        include_usage: true,
      },
    },
    openrouter: {
      reasoning: {
        max_tokens: 10,
      },
    },
  };
}

export function defaultMessageProviderOptions(): SharedV2ProviderOptions {
  return {
    anthropic: {
      cacheControl: { type: "ephemeral" },
    },
    bedrock: {
      cachePoint: { type: "default" },
    },
    openrouter: {
      cacheControl: { type: "ephemeral" },
    },
  };
}

export function convertTools(
  tools: Tool[] | DialogueTool[]
): LanguageModelV2FunctionTool[] {
  return tools.map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
    // providerOptions: defaultMessageProviderOptions()
  })) as LanguageModelV2FunctionTool[];
}

export function getTool<T extends Tool | DialogueTool>(
  tools: T[],
  name: string
): T | null {
  for (let i = 0; i < tools.length; i++) {
    if (tools[i].name == name) {
      return tools[i];
    }
  }
  return null;
}

export function convertToolResult(
  toolUse: LanguageModelV2ToolCallPart,
  toolResult: ToolResult,
  user_messages: LanguageModelV2Prompt
): LanguageModelV2ToolResultPart {
  let result: LanguageModelV2ToolResultOutput;
  if (!toolResult || !toolResult.content) {
    result = {
      type: "error-text",
      value: "Error",
    };
  } else if (
    toolResult.content.length == 1 &&
    toolResult.content[0].type == "text"
  ) {
    let text = toolResult.content[0].text;
    result = {
      type: "text",
      value: text,
    };
    let isError = toolResult.isError == true;
    if (isError && !text.startsWith("Error")) {
      text = "Error: " + text;
      result = {
        type: "error-text",
        value: text,
      };
    } else if (!isError && text.length == 0) {
      text = "Successful";
      result = {
        type: "text",
        value: text,
      };
    }
    if (
      text &&
      ((text.startsWith("{") && text.endsWith("}")) ||
        (text.startsWith("[") && text.endsWith("]")))
    ) {
      try {
        result = JSON.parse(text);
        result = {
          type: "json",
          value: result,
        };
      } catch (e) {}
    }
  } else {
    result = {
      type: "content",
      value: [],
    };
    for (let i = 0; i < toolResult.content.length; i++) {
      let content = toolResult.content[i];
      if (content.type == "text") {
        result.value.push({
          type: "text",
          text: content.text,
        });
      } else {
        if (config.toolResultMultimodal) {
          // Support returning images from tool results
          let mediaData = content.data;
          if (mediaData.startsWith("data:")) {
            mediaData = mediaData.substring(mediaData.indexOf(",") + 1);
          }
          result.value.push({
            type: "media",
            data: mediaData,
            mediaType: content.mimeType || "image/png",
          });
        } else {
          // Only the claude model supports returning images from tool results, while openai only supports text,
          // Compatible with other AI models that do not support tool results as images.
          user_messages.push({
            role: "user",
            content: [
              {
                type: "file",
                data: toFile(content.data),
                mediaType: content.mimeType || getMimeType(content.data),
              },
              {
                type: "text",
                text: `call \`${toolUse.toolName}\` tool result`,
              },
            ],
          });
        }
      }
    }
  }
  return {
    type: "tool-result",
    toolCallId: toolUse.toolCallId,
    toolName: toolUse.toolName,
    output: result,
  };
}

/**
 * Known model context window sizes (in tokens).
 * Used to dynamically compute the compression threshold.
 */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic
  "claude-opus-4": 200000,
  "claude-sonnet-4": 200000,
  "claude-sonnet-4-5": 200000,
  "claude-3-5-sonnet": 200000,
  "claude-3-5-haiku": 200000,
  "claude-3-opus": 200000,
  "claude-3-sonnet": 200000,
  "claude-3-haiku": 200000,
  // OpenAI
  "gpt-4o": 128000,
  "gpt-4-turbo": 128000,
  "gpt-4.1": 1047576,
  "o3": 200000,
  "o4-mini": 200000,
  // Google
  "gemini-2.5-pro": 1048576,
  "gemini-2.5-flash": 1048576,
  "gemini-2.0-flash": 1048576,
};

function getModelContextWindow(modelId: string): number {
  if (MODEL_CONTEXT_WINDOWS[modelId]) return MODEL_CONTEXT_WINDOWS[modelId];
  // Substring match for versioned/prefixed model IDs
  // e.g. "claude-sonnet-4-5-20250514" or "dev-anthropic-claude-sonnet-4-5"
  for (const [key, value] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (modelId.includes(key)) return value;
  }
  return 0; // unknown model
}

/**
 * Compute the compression token threshold for a given model name.
 * When config.dynamicCompressThreshold is true, returns 75% of the model's
 * context window minus max output tokens. Otherwise returns the static
 * config.compressTokensThreshold value.
 */
export function getCompressTokensThresholdForModel(modelId: string, maxOutputTokens?: number): number {
  if (config.dynamicCompressThreshold) {
    const contextWindow = getModelContextWindow(modelId);
    if (contextWindow > 0) {
      const outputBudget = maxOutputTokens || config.maxTokens || 16000;
      return Math.floor(contextWindow * 0.75) - outputBudget;
    }
  }
  return config.compressTokensThreshold;
}

function getCompressTokensThreshold(rlm: RetryLanguageModel): number {
  const names = rlm.Names;
  const llms = rlm.Llms;
  for (const name of names) {
    const llmConfig = llms[name];
    if (llmConfig?.model) {
      return getCompressTokensThresholdForModel(llmConfig.model, llmConfig.config?.maxTokens);
    }
  }
  return config.compressTokensThreshold;
}

export async function callAgentLLM(
  agentContext: AgentContext,
  rlm: RetryLanguageModel,
  messages: LanguageModelV2Prompt,
  tools: LanguageModelV2FunctionTool[],
  noCompress?: boolean,
  toolChoice?: LanguageModelV2ToolChoice,
  retryNum: number = 0,
  callback?: StreamCallback & HumanCallback,
  requestHandler?: (request: LLMRequest) => void
): Promise<Array<LanguageModelV2TextPart | LanguageModelV2ToolCallPart>> {
  await agentContext.context.checkAborted();
  if (
    !noCompress &&
    (messages.length >= config.compressThreshold || (messages.length >= 10 && estimatePromptTokens(messages, tools) >= getCompressTokensThreshold(rlm)))
  ) {
    // Compress messages
    await memory.compressAgentMessages(agentContext, messages, tools, callback, requestHandler);
  }
  if (!toolChoice) {
    // Append user dialogue
    appendUserConversation(agentContext, messages);
  }
  const context = agentContext.context;
  const agentChain = agentContext.agentChain;
  const agentNode = agentChain.agent;
  const streamCallback = callback ||
    context.config.callback || {
      onMessage: async () => {},
    };
  const stepController = new AbortController();
  const signal = AbortSignal.any([
    context.controller.signal,
    stepController.signal,
  ]);
  const correlationId = agentContext.context.variables.get('correlation_id');
  const request: LLMRequest = {
    tools: tools,
    toolChoice,
    messages: messages,
    abortSignal: signal,
    correlation_id: correlationId,
    llm_call_annotation: `Agent ${agentNode.name} (ID: ${agentNode.id}) call callAgentLLM`,
  };
  requestHandler && requestHandler(request);
  let streamText = "";
  let thinkText = "";
  let toolArgsText = "";
  let textStreamId = uuidv4();
  let thinkStreamId = uuidv4();
  let textStreamDone = false;
  const toolParts: LanguageModelV2ToolCallPart[] = [];
  let reader: ReadableStreamDefaultReader<LanguageModelV2StreamPart> | null = null;
  const llmCallStartTime = Date.now();
  Log.warn(`[Task ${context.taskId}][${agentNode.name}] Started processing LLM stream response`);
  try {
    agentChain.agentRequest = request;
    context.currentStepControllers.add(stepController);
    const result: StreamResult = await rlm.callStream(request);
    reader = result.stream.getReader();
    let toolPart: LanguageModelV2ToolCallPart | null = null;
    while (true) {
      await context.checkAborted();
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = value as LanguageModelV2StreamPart;
      switch (chunk.type) {
        case "text-start": {
          textStreamId = uuidv4();
          break;
        }
        case "text-delta": {
          if (toolPart && !chunk.delta) {
            continue;
          }
          streamText += chunk.delta || "";
          await streamCallback.onMessage(
            {
              taskId: context.taskId,
              agentName: agentNode.name,
              nodeId: agentNode.id,
              type: "text",
              streamId: textStreamId,
              streamDone: false,
              text: streamText,
            },
            agentContext
          );
          if (toolPart) {
            await streamCallback.onMessage(
              {
                taskId: context.taskId,
                agentName: agentNode.name,
                nodeId: agentNode.id,
                type: "tool_use",
                toolId: toolPart.toolCallId,
                toolName: toolPart.toolName,
                params: toolPart.input || {},
              },
              agentContext
            );
            toolPart = null;
          }
          break;
        }
        case "text-end": {
          textStreamDone = true;
          
          // Check if streamText contains JSON tool calls (for Qwen models)
          Log.warn(`[Qwen Tool Extraction] streamText: ${streamText.substring(0, 200)}`);
          const extractedToolCalls = extractToolCallsFromText(streamText);
          Log.warn(`[Qwen Tool Extraction] Found ${extractedToolCalls.length} tool calls`);
          if (extractedToolCalls.length > 0) {
            for (const tc of extractedToolCalls) {
              Log.warn(`[Qwen Tool Extraction] Extracted tool: ${tc.name} with args: ${JSON.stringify(tc.arguments)}`);
            }
            // Remove the tool calls from streamText
            let cleanedText = streamText;
            for (const toolCall of extractedToolCalls) {
              cleanedText = cleanedText.replace(toolCall.originalJson, '').trim();
            }
            
            // Add extracted tools to toolParts
            for (let i = 0; i < extractedToolCalls.length; i++) {
              const tc = extractedToolCalls[i];
              toolParts.push({
                type: "tool-call",
                toolCallId: `call_${Date.now()}_${i}`,
                toolName: tc.name,
                input: tc.arguments,
              });
            }
            
            streamText = cleanedText;
          }
          
          if (streamText) {
            // Log text/reasoning to progress tracker
            logReasoning(streamText);
            
            await streamCallback.onMessage(
              {
                taskId: context.taskId,
                agentName: agentNode.name,
                nodeId: agentNode.id,
                type: "text",
                streamId: textStreamId,
                streamDone: true,
                text: streamText,
              },
              agentContext
            );
          }
          break;
        }
        case "reasoning-start": {
          thinkStreamId = uuidv4();
          break;
        }
        case "reasoning-delta": {
          thinkText += chunk.delta || "";
          await streamCallback.onMessage(
            {
              taskId: context.taskId,
              agentName: agentNode.name,
              nodeId: agentNode.id,
              type: "thinking",
              streamId: thinkStreamId,
              streamDone: false,
              text: thinkText,
            },
            agentContext
          );
          break;
        }
        case "reasoning-end": {
          if (thinkText) {
            // Log reasoning to progress tracker
            logReasoning(thinkText);
            
            await streamCallback.onMessage(
              {
                taskId: context.taskId,
                agentName: agentNode.name,
                nodeId: agentNode.id,
                type: "thinking",
                streamId: thinkStreamId,
                streamDone: true,
                text: thinkText,
              },
              agentContext
            );
          }
          break;
        }
        case "tool-input-start": {
          if (toolPart && toolPart.toolCallId == chunk.id) {
            toolPart.toolName = chunk.toolName;
          } else {
            toolPart = {
              type: "tool-call",
              toolCallId: chunk.id,
              toolName: chunk.toolName,
              input: {},
            };
            toolParts.push(toolPart);
          }
          break;
        }
        case "tool-input-delta": {
          if (!textStreamDone) {
            textStreamDone = true;
            await streamCallback.onMessage(
              {
                taskId: context.taskId,
                agentName: agentNode.name,
                nodeId: agentNode.id,
                type: "text",
                streamId: textStreamId,
                streamDone: true,
                text: streamText,
              },
              agentContext
            );
          }
          toolArgsText += chunk.delta || "";
          await streamCallback.onMessage(
            {
              taskId: context.taskId,
              agentName: agentNode.name,
              nodeId: agentNode.id,
              type: "tool_streaming",
              toolId: chunk.id,
              toolName: toolPart?.toolName || "",
              paramsText: toolArgsText,
            },
            agentContext
          );
          break;
        }
        case "tool-call": {
          toolArgsText = "";
          const args = chunk.input ? JSON.parse(chunk.input) : {};
          const message: StreamCallbackMessage = {
            taskId: context.taskId,
            agentName: agentNode.name,
            nodeId: agentNode.id,
            type: "tool_use",
            toolId: chunk.toolCallId,
            toolName: chunk.toolName,
            params: args,
          };
          await streamCallback.onMessage(message, agentContext);
          if (toolPart == null) {
            toolParts.push({
              type: "tool-call",
              toolCallId: chunk.toolCallId,
              toolName: chunk.toolName,
              input: message.params || args,
            });
          } else {
            toolPart.input = message.params || args;
            toolPart = null;
          }
          break;
        }
        case "file": {
          await streamCallback.onMessage(
            {
              taskId: context.taskId,
              agentName: agentNode.name,
              nodeId: agentNode.id,
              type: "file",
              mimeType: chunk.mediaType,
              data: chunk.data as string,
            },
            agentContext
          );
          break;
        }
        case "error": {
          Log.error(`${agentNode.name} agent error: `, chunk);
          await streamCallback.onMessage(
            {
              taskId: context.taskId,
              agentName: agentNode.name,
              nodeId: agentNode.id,
              type: "error",
              error: chunk.error,
            },
            agentContext
          );
          throw new Error("LLM Error: " + chunk.error);
        }
        case "finish": {
          if (!textStreamDone) {
            textStreamDone = true;
            await streamCallback.onMessage(
              {
                taskId: context.taskId,
                agentName: agentNode.name,
                nodeId: agentNode.id,
                type: "text",
                streamId: textStreamId,
                streamDone: true,
                text: streamText,
              },
              agentContext
            );
          }
          if (chunk.finishReason === "content-filter") {
            throw new Error("LLM error: trigger content filtering violation");
          } else if (chunk.finishReason === "other") {
            throw new Error("LLM error: terminated due to other reasons");
          } else if (
            chunk.finishReason === "length" &&
            messages.length >= 3 &&
            !noCompress &&
            retryNum < config.maxRetryNum
          ) {
            await memory.compressAgentMessages(
              agentContext,
              messages,
              tools,
              streamCallback,
              requestHandler
            );
            return callAgentLLM(
              agentContext,
              rlm,
              messages,
              tools,
              noCompress,
              toolChoice,
              ++retryNum,
              streamCallback,
              requestHandler
            );
          }
          if (toolPart) {
            await streamCallback.onMessage(
              {
                taskId: context.taskId,
                agentName: agentNode.name,
                nodeId: agentNode.id,
                type: "tool_use",
                toolId: toolPart.toolCallId,
                toolName: toolPart.toolName,
                params: toolPart.input || {},
              },
              agentContext
            );
            toolPart = null;
          }
          // Log token usage and duration for this LLM call
          const usage = (chunk.usage || {}) as Record<string, any>;
          let inputTokens = usage.inputTokens || usage.promptTokens || usage.prompt_tokens || usage.input_tokens || 0;
          let outputTokens = usage.outputTokens || usage.completionTokens || usage.completion_tokens || usage.output_tokens || 0;

          // Extract cache token counts (Anthropic prompt caching)
          const providerMeta = (chunk as any).providerMetadata?.anthropic || {};
          const cachedInputTokens = usage.cachedInputTokens || usage.cache_read_input_tokens || providerMeta.cacheReadInputTokens || 0;
          const cacheCreationInputTokens = usage.cacheCreationInputTokens || usage.cache_creation_input_tokens || providerMeta.cacheCreationInputTokens || 0;

          // Track whether token counts are estimated vs reported by the provider
          let isEstimated = false;

          // If provider doesn't return token counts, estimate them
          if (inputTokens === 0) {
            inputTokens = estimatePromptTokens(messages, tools);
            isEstimated = true;
          }
          if (outputTokens === 0) {
            // Estimate output tokens from the generated text and tool calls
            const outputContent = streamText + thinkText + toolParts.map(tp => tp.toolName + JSON.stringify(tp.input || {})).join('');
            outputTokens = estimateTokens(outputContent);
            isEstimated = true;
          }

          const totalTokens = usage.totalTokens || usage.total_tokens || (inputTokens + outputTokens);
          const llmCallDurationMs = Date.now() - llmCallStartTime;
          Log.info(`[Task ${context.taskId}][${agentNode.name}] LLM call completed - Duration: ${llmCallDurationMs}ms, Input tokens: ${inputTokens}, Output tokens: ${outputTokens}, Total tokens: ${totalTokens}, Cached: ${cachedInputTokens}, CacheCreation: ${cacheCreationInputTokens}${isEstimated ? ' (estimated)' : ''}`);

          await streamCallback.onMessage(
            {
              taskId: context.taskId,
              agentName: agentNode.name,
              nodeId: agentNode.id,
              type: "finish",
              finishReason: chunk.finishReason,
              usage: {
                promptTokens: inputTokens,
                completionTokens: outputTokens,
                totalTokens: totalTokens,
                cachedInputTokens: cachedInputTokens || undefined,
                cacheCreationInputTokens: cacheCreationInputTokens || undefined,
                isEstimated,
                durationMs: llmCallDurationMs,
              },
            },
            agentContext
          );
          break;
        }
      }
    }
  } catch (e: any) {
    await context.checkAborted();
    
    // Check if this is a rate limit error - use longer delay
    const isRateLimit = isRateLimitError(e);
    if (isRateLimit) {
      const rateLimitDelay = getRateLimitDelay(retryNum, e);
      Log.warn(`[Task ${context.taskId}][${agentNode.name}] Rate limit hit. Waiting ${Math.round(rateLimitDelay / 1000)}s before retry (attempt ${retryNum + 1}/${config.maxRetryNum})`);
      await sleep(rateLimitDelay);
      return callAgentLLM(
        agentContext,
        rlm,
        messages,
        tools,
        noCompress,
        toolChoice,
        ++retryNum,
        streamCallback,
        requestHandler
      );
    }

    if (retryNum < config.maxRetryNum) {
      Log.warn(`[Task ${context.taskId}][${agentNode.name}] Retrying request (attempt ${retryNum + 1})`);
      await sleep(300 * (retryNum + 1) * (retryNum + 1));
      if ((e + "").indexOf("is too long") > -1) {
        await memory.compressAgentMessages(agentContext, messages, tools, streamCallback, requestHandler);
      }
      return callAgentLLM(
        agentContext,
        rlm,
        messages,
        tools,
        noCompress,
        toolChoice,
        ++retryNum,
        streamCallback,
        requestHandler
      );
    }
    throw e;
  } finally {
    reader && reader.releaseLock();
    context.currentStepControllers.delete(stepController);
  }
  Log.warn(`[Task ${context.taskId}][${agentNode.name}] Completed processing LLM stream response`);
  agentChain.agentResult = streamText;
  return streamText
    ? [
        { type: "text", text: streamText } as LanguageModelV2TextPart,
        ...toolParts,
      ]
    : toolParts;
}

export function estimatePromptTokens(
  messages: LanguageModelV2Prompt,
  tools?: LanguageModelV2FunctionTool[]
) {
  let tokens = messages.reduce((total, message) => {
    if (message.role == "system") {
      return total + estimateTokens(message.content);
    } else if (message.role == "user") {
      return (
        total +
        estimateTokens(
          message.content
            .filter((part) => part.type == "text")
            .map((part) => part.text)
            .join("\n")
        )
      );
    } else if (message.role == "assistant") {
      return (
        total +
        estimateTokens(
          message.content
            .map((part) => {
              if (part.type == "text") {
                return part.text;
              } else if (part.type == "reasoning") {
                return part.text;
              } else if (part.type == "tool-call") {
                return part.toolName + JSON.stringify(part.input || {});
              } else if (part.type == "tool-result") {
                return part.toolName + JSON.stringify(part.output || {});
              }
              return "";
            })
            .join("")
        )
      );
    } else if (message.role == "tool") {
      return (
        total +
        estimateTokens(
          message.content
            .map((part) => part.toolName + JSON.stringify(part.output || {}))
            .join("")
        )
      );
    }
    return total;
  }, 0);
  if (tools) {
    tokens += tools.reduce((total, tool) => {
      return total + estimateTokens(JSON.stringify(tool));
    }, 0);
  }
  return tokens;
}

export function estimateTokens(text: string) {
  if (!text) {
    return 0;
  }
  let tokenCount = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const code = char.charCodeAt(0);
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3040 && code <= 0x309f) ||
      (code >= 0x30a0 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      tokenCount += 2;
    } else if (/\s/.test(char)) {
      continue;
    } else if (/[a-zA-Z]/.test(char)) {
      let word = "";
      while (i < text.length && /[a-zA-Z]/.test(text[i])) {
        word += text[i];
        i++;
      }
      i--;
      if (word.length <= 4) {
        tokenCount += 1;
      } else {
        tokenCount += Math.ceil(word.length / 4);
      }
    } else if (/\d/.test(char)) {
      let number = "";
      while (i < text.length && /\d/.test(text[i])) {
        number += text[i];
        i++;
      }
      i--;
      tokenCount += Math.max(1, Math.ceil(number.length / 3));
    } else {
      tokenCount += 1;
    }
  }
  return Math.max(1, tokenCount);
}

function appendUserConversation(
  agentContext: AgentContext,
  messages: LanguageModelV2Prompt
) {
  const userPrompts = agentContext.context.conversation
    .splice(0, agentContext.context.conversation.length)
    .filter((s) => !!s);
  if (userPrompts.length > 0) {
    const prompt =
      "The user is intervening in the current task, please replan and execute according to the following instructions:\n" +
      userPrompts.map((s) => `- ${s.trim()}`).join("\n");
    messages.push({
      role: "user",
      content: [{ type: "text", text: prompt }],
    });
  }
}
