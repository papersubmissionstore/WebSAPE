import {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
} from "@ai-sdk/provider";
import Log from "../common/log";
import config from "../config";
import { createOpenAI } from "@ai-sdk/openai";
import { call_timeout } from "../common/utils";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createResponsesApiAdapter } from "./responses-api-adapter";
import { logWorkflowError } from "../agent/browser/snapshot_uploader";
import {
  LLMs,
  LLMRequest,
  StreamResult,
  GenerateResult,
} from "../types/llm.types";
import Context, { AgentContext } from "../core/context";
import { defaultLLMProviderOptions } from "../agent/llm_provider_options";

// Rate limit retry configuration
export const RATE_LIMIT_MAX_RETRIES = 5;
export const RATE_LIMIT_BASE_DELAY_MS = 3000; // Start with 3 seconds
export const RATE_LIMIT_MAX_DELAY_MS = 120000; // Max 2 minutes

/**
 * Check if an error is a rate limit error (429 Too Many Requests)
 */
export function isRateLimitError(error: any): boolean {
  if (!error) return false;
  
  // Log error details for debugging
  Log.info(`[isRateLimitError] Checking error: name=${error.name}, message=${error.message?.substring(0, 100)}, statusCode=${error.statusCode}, isRetryable=${error.isRetryable}`);
  
  // Check error message
  const message = error.message?.toLowerCase() || '';
  if (message.includes('too many requests') || 
      message.includes('rate limit') ||
      message.includes('rate_limit') ||
      message.includes('ratelimit') ||
      message.includes('throttl')) {
    Log.info(`[isRateLimitError] Detected rate limit from message: ${error.message?.substring(0, 100)}`);
    return true;
  }
  
  // Check status code (AI SDK APICallError uses statusCode)
  if (error.status === 429 || error.statusCode === 429) {
    Log.info(`[isRateLimitError] Detected rate limit from status code: ${error.status || error.statusCode}`);
    return true;
  }
  
  // Check for nested response status
  if (error.response?.status === 429) {
    Log.info(`[isRateLimitError] Detected rate limit from response.status`);
    return true;
  }
  
  // Check error name/type - AI SDK uses names like "AI_APICallError"
  if (error.name?.includes('RateLimit') || error.type?.includes('rate_limit')) {
    Log.info(`[isRateLimitError] Detected rate limit from error name/type`);
    return true;
  }
  
  // Check for AI SDK specific error patterns
  if (error.cause?.status === 429 || error.cause?.statusCode === 429) {
    Log.info(`[isRateLimitError] Detected rate limit from cause.statusCode`);
    return true;
  }
  
  // Check if AI SDK marks it as retryable (server errors like 429 are marked retryable)
  // Combined with "Too Many Requests" in message, this catches AI_APICallError
  if (error.isRetryable === true && message.includes('request')) {
    Log.info(`[isRateLimitError] Detected retryable request error`);
    return true;
  }
  
  Log.info(`[isRateLimitError] Not a rate limit error`);
  return false;
}

/**
 * Get the delay for rate limit retry with exponential backoff
 */
export function getRateLimitDelay(retryCount: number, error?: any): number {
  // Check if the error contains a Retry-After header hint
  const retryAfter = error?.headers?.['retry-after'] || 
                     error?.response?.headers?.['retry-after'] ||
                     error?.responseHeaders?.['retry-after'] ||
                     error?.cause?.headers?.['retry-after'];
  
  if (retryAfter) {
    const retryAfterMs = parseInt(retryAfter, 10) * 1000;
    if (!isNaN(retryAfterMs) && retryAfterMs > 0) {
      Log.info(`[getRateLimitDelay] Using Retry-After header: ${retryAfter}s`);
      return Math.min(retryAfterMs, RATE_LIMIT_MAX_DELAY_MS);
    }
  }
  
  // Exponential backoff with jitter
  const exponentialDelay = RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, retryCount);
  const jitter = Math.random() * 2000; // Add up to 2 seconds of jitter
  const delay = Math.min(exponentialDelay + jitter, RATE_LIMIT_MAX_DELAY_MS);
  Log.info(`[getRateLimitDelay] Using exponential backoff: ${Math.round(delay)}ms (retry ${retryCount})`);
  return delay;
}

/**
 * Sleep for the specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class RetryLanguageModel {
  private llms: LLMs;
  private names: string[];
  private stream_first_timeout: number;
  private stream_token_timeout: number;
  private context?: Context;
  private agentContext?: AgentContext;

  constructor(
    llms: LLMs,
    names?: string[],
    stream_first_timeout?: number,
    stream_token_timeout?: number,
    context?: Context | AgentContext,
  ) {
    this.llms = llms;
    this.names = names || [];
    context && this.setContext(context);
    this.stream_first_timeout = stream_first_timeout || 300_000;
    this.stream_token_timeout = stream_token_timeout || 1800_000;
    if (this.names.indexOf("default") == -1) {
      this.names.push("default");
    }
  }

  setContext(context?: Context | AgentContext) {
    if (!context) {
      this.context = undefined;
      this.agentContext = undefined;
      return;
    }
    this.context = context instanceof Context ? context : context.context;
    this.agentContext = context instanceof AgentContext ? context : undefined;
  }

  async call(request: LLMRequest): Promise<GenerateResult> {
    const options: LanguageModelV2CallOptions = {
      prompt: request.messages,
      tools: request.tools,
      toolChoice: request.toolChoice,
      maxOutputTokens: request.maxCompletionTokens ?? request.maxTokens,
      temperature: request.temperature,
      topP: request.topP,
      topK: request.topK,
      stopSequences: request.stopSequences,
      abortSignal: request.abortSignal,
    };
    if (request.correlation_id) {
      options.headers = { 'x-correlation-id': request.correlation_id };
    }
    return await this.doGenerate(options);
  }

  async doGenerate(
    options: LanguageModelV2CallOptions
  ): Promise<GenerateResult> {
    const maxTokens = options.maxOutputTokens;
    const providerOptions = options.providerOptions;
    const names = [...this.names, ...this.names];
    let lastError;
    let rateLimitExhaustedLLMs = new Set<string>(); // Track LLMs that exhausted rate limit retries
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      
      // Skip LLMs that have already exhausted their rate limit retries
      if (rateLimitExhaustedLLMs.has(name)) {
        Log.info(`[LLM ${name}] Skipping - rate limit retries already exhausted`);
        continue;
      }
      
      const llmConfig = this.llms[name];
      const llm = await this.getLLM(name);
      if (!llm) {
        continue;
      }
      if (!maxTokens) {
        options.maxOutputTokens =
          llmConfig.config?.maxCompletionTokens ?? llmConfig.config?.maxTokens ?? config.maxTokens;
      }
      if (!providerOptions) {
        options.providerOptions = defaultLLMProviderOptions();
        options.providerOptions[llm.provider] = llmConfig.options || {};
      }
      // For GPT-5 and newer OpenAI models, use max_completion_tokens instead of maxOutputTokens
      if (this.isGPT5OrNewer(llmConfig.model) && (llmConfig.provider === "openai" || llmConfig.provider === "openai-compatible")) {
        const maxCompletionTokens = llmConfig.config?.maxCompletionTokens ?? llmConfig.config?.maxTokens ?? options.maxOutputTokens ?? config.maxTokens;
        if (maxCompletionTokens) {
          options.providerOptions = options.providerOptions || {};
          options.providerOptions.openai = options.providerOptions.openai || {};
          options.providerOptions.openai.max_completion_tokens = maxCompletionTokens;
          delete options.maxOutputTokens;
        }
        delete options.temperature;
      }
      let _options = options;
      if (llmConfig.handler) {
        _options = await llmConfig.handler(_options, this.context, this.agentContext);
      }
      // Log full LLM context if enabled
      if (config.logLLMContext) {
        Log.info(`[LLM Context] name: ${name}, provider: ${llmConfig.provider}, model: ${llmConfig.model}`);
        Log.info(`[LLM Context] messages:`, JSON.stringify(_options.prompt, null, 2));
        if (_options.tools && _options.tools.length > 0) {
          Log.info(`[LLM Context] tools:`, JSON.stringify(_options.tools.map(t => ({ name: t.name, description: (t as any).description?.substring(0, 100) })), null, 2));
        }
      }
      try {
        let result = (await llm.doGenerate(_options)) as GenerateResult;
        if (Log.isEnableDebug()) {
          Log.debug(
            `LLM nonstream body, name: ${name} => `,
            result.request?.body
          );
        }
        result.llm = name;
        result.llmConfig = llmConfig;
        result.text = result.content.find((c) => c.type === "text")?.text;
        return result;
      } catch (e: any) {
        if (e?.name === "AbortError") {
          throw e;
        }
        
        // Fail immediately on rate limit — no retry, surface clearly in resolver
        if (isRateLimitError(e)) {
          Log.error(`[LLM ${name}] LLM rate limit exceeded (HTTP 429), failing task immediately`);
          throw new Error('LLM rate limit exceeded (HTTP 429)');
        }
        
        lastError = e;
        if (Log.isEnableInfo()) {
          Log.info(`LLM nonstream request, name: ${name} => `, {
            tools: _options.tools,
            messages: _options.prompt,
          });
        }
        Log.error(`LLM error, name: ${name} => `, e);
        // Log LLM errors to progress.json
        logWorkflowError(e);
      }
    }
    return Promise.reject(
      lastError ? lastError : new Error("No LLM available")
    );
  }

  async callStream(request: LLMRequest): Promise<StreamResult> {
    const options: LanguageModelV2CallOptions = {
      prompt: request.messages,
      tools: request.tools,
      toolChoice: request.toolChoice,
      maxOutputTokens: request.maxCompletionTokens ?? request.maxTokens,
      temperature: request.temperature,
      topP: request.topP,
      topK: request.topK,
      stopSequences: request.stopSequences,
      abortSignal: request.abortSignal,
    };
    options.headers = { 'x-correlation-id': request.correlation_id, 'x-llm-call-annotation': request.llm_call_annotation };
    return await this.doStream(options);
  }

  async doStream(options: LanguageModelV2CallOptions): Promise<StreamResult> {
    const maxTokens = options.maxOutputTokens;
    const providerOptions = options.providerOptions;
    const names = [...this.names, ...this.names];
    let lastError;
    let rateLimitExhaustedLLMs = new Set<string>(); // Track LLMs that exhausted rate limit retries
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      
      // Skip LLMs that have already exhausted their rate limit retries
      if (rateLimitExhaustedLLMs.has(name)) {
        Log.info(`[LLM ${name}] Skipping - rate limit retries already exhausted`);
        continue;
      }
      
      const llmConfig = this.llms[name];
      const llm = await this.getLLM(name);
      if (!llm) {
        continue;
      }
      if (!maxTokens) {
        options.maxOutputTokens =
          llmConfig.config?.maxCompletionTokens ?? llmConfig.config?.maxTokens ?? config.maxTokens;
      }
      if (!providerOptions) {
        options.providerOptions = defaultLLMProviderOptions();
        options.providerOptions[llm.provider] = llmConfig.options || {};
      }
      // For GPT-5 and newer OpenAI models, use max_completion_tokens instead of maxOutputTokens
      // and remove temperature as these models only support temperature = 1
      if (this.isGPT5OrNewer(llmConfig.model) && (llmConfig.provider === "openai" || llmConfig.provider === "openai-compatible")) {
        const maxCompletionTokens = llmConfig.config?.maxCompletionTokens ?? llmConfig.config?.maxTokens ?? options.maxOutputTokens ?? config.maxTokens;
        if (maxCompletionTokens) {
          options.providerOptions = options.providerOptions || {};
          options.providerOptions.openai = options.providerOptions.openai || {};
          options.providerOptions.openai.max_completion_tokens = maxCompletionTokens;
          delete options.maxOutputTokens;
        }
        // GPT-5 models only support temperature = 1 (default), remove custom temperature
        delete options.temperature;
      }
      let _options = options;
      if (llmConfig.handler) {
        _options = await llmConfig.handler(_options, this.context, this.agentContext);
      }
      // Log full LLM context if enabled
      if (config.logLLMContext) {
        Log.info(`[LLM Context] name: ${name}, provider: ${llmConfig.provider}, model: ${llmConfig.model}`);
        Log.info(`[LLM Context] messages:`, JSON.stringify(_options.prompt, null, 2));
        if (_options.tools && _options.tools.length > 0) {
          Log.info(`[LLM Context] tools:`, JSON.stringify(_options.tools.map(t => ({ name: t.name, description: (t as any).description?.substring(0, 100) })), null, 2));
        }
      }
      try {
        const controller = new AbortController();
        const signal = _options.abortSignal
          ? AbortSignal.any([_options.abortSignal, controller.signal])
          : controller.signal;
        const result = (await call_timeout(
          async () => await llm.doStream({ ..._options, abortSignal: signal }),
          this.stream_first_timeout,
          (e) => {
            controller.abort();
          }
        )) as StreamResult;
        const stream = result.stream;
        const reader = stream.getReader();
        const { done, value } = await call_timeout(
          async () => await reader.read(),
          this.stream_first_timeout,
          (e) => {
            reader.cancel();
            reader.releaseLock();
            controller.abort();
          }
        );
        if (done) {
          Log.warn(`LLM stream done, name: ${name} => `, { done, value });
          reader.releaseLock();
          continue;
        }
        if (Log.isEnableDebug()) {
          Log.debug(`LLM stream body, name: ${name} => `, result.request?.body);
        }
        let chunk = value as LanguageModelV2StreamPart;
        if (chunk.type == "error") {
          Log.error(`LLM stream error, name: ${name}`, chunk);
          reader.releaseLock();
          continue;
        }
        result.llm = name;
        result.llmConfig = llmConfig;
        result.stream = this.streamWrapper([chunk], reader, controller);
        return result;
      } catch (e: any) {
        if (e?.name === "AbortError") {
          throw e;
        }
        
        // Fail immediately on rate limit — no retry, surface clearly in resolver
        if (isRateLimitError(e)) {
          Log.error(`[LLM ${name}] LLM rate limit exceeded (HTTP 429) (stream), failing task immediately`);
          throw new Error('LLM rate limit exceeded (HTTP 429)');
        }
        
        lastError = e;
        if (Log.isEnableInfo()) {
          Log.info(`LLM stream request, name: ${name} => `, {
            tools: _options.tools,
            messages: _options.prompt,
          });
        }
        Log.error(`LLM error, name: ${name} => `, e);
        // Log LLM stream errors to progress.json
        logWorkflowError(e);
      }
    }
    return Promise.reject(
      lastError ? lastError : new Error("No LLM available")
    );
  }

  private async getLLM(name: string): Promise<LanguageModelV2 | null> {
    const llm = this.llms[name];
    if (!llm) {
      return null;
    }
    let apiKey;
    if (typeof llm.apiKey === "string") {
      apiKey = llm.apiKey;
    } else {
      apiKey = await llm.apiKey();
    }
    let baseURL = undefined;
    if (llm.config?.baseURL) {
      if (typeof llm.config.baseURL === "string") {
        baseURL = llm.config.baseURL;
      } else {
        baseURL = await llm.config.baseURL();
      }
    }
    if (llm.provider == "openai") {
      if (
        !baseURL ||
        baseURL.indexOf("openai.com") > -1 ||
        llm.config?.organization ||
        llm.config?.openai
      ) {
        return createOpenAI({
          apiKey: apiKey,
          baseURL: baseURL,
          fetch: llm.fetch,
          organization: llm.config?.organization,
          project: llm.config?.project,
          headers: llm.config?.headers,
        }).languageModel(llm.model);
      } else {
        // Azure OpenAI or other OpenAI-compatible endpoints
        // Use the Responses API adapter if configured
        // Note: The @ai-sdk/openai-compatible SDK internally appends "/chat/completions" to baseURL
        // so the adapter handles URL transformation when useResponsesApi is enabled
        const useResponsesApi = llm.config?.useResponsesApi === true;
        const apiVersion = llm.config?.apiVersion || '2025-04-01-preview';
        
        const customFetch = llm.fetch || (useResponsesApi ? 
          createResponsesApiAdapter({ debug: true, apiVersion }) as any : undefined);

        return createOpenAICompatible({
          name: llm.model,
          apiKey: apiKey,
          baseURL: baseURL,
          fetch: customFetch,
          headers: llm.config?.headers,
        }).languageModel(llm.model);
      }
    } else if (llm.provider == "anthropic") {
      return createAnthropic({
        apiKey: apiKey,
        baseURL: baseURL,
        fetch: llm.fetch,
        headers: llm.config?.headers,
      }).languageModel(llm.model);
    } else if (llm.provider == "google") {
      return createGoogleGenerativeAI({
        apiKey: apiKey,
        baseURL: baseURL,
        fetch: llm.fetch,
        headers: llm.config?.headers,
      }).languageModel(llm.model);
    } else if (llm.provider == "aws") {
      let keys = apiKey.split("=");
      return createAmazonBedrock({
        accessKeyId: keys[0],
        secretAccessKey: keys[1],
        baseURL: baseURL,
        region: llm.config?.region || "us-west-1",
        fetch: llm.fetch,
        headers: llm.config?.headers,
        sessionToken: llm.config?.sessionToken,
      }).languageModel(llm.model);
    } else if (llm.provider == "openai-compatible") {
      return createOpenAICompatible({
        name: llm.config?.name || llm.model.split("/")[0],
        apiKey: apiKey,
        baseURL: baseURL || "https://openrouter.ai/api/v1",
        fetch: llm.fetch,
        headers: llm.config?.headers,
      }).languageModel(llm.model);
    } else if (llm.provider == "openrouter") {
      return createOpenRouter({
        apiKey: apiKey,
        baseURL: baseURL || "https://openrouter.ai/api/v1",
        fetch: llm.fetch,
        headers: llm.config?.headers,
        compatibility: llm.config?.compatibility,
      }).languageModel(llm.model);
    } else if (llm.provider == "modelscope") {
      return createOpenAICompatible({
        name: llm.config?.name || llm.model.split("/")[0],
        apiKey: apiKey,
        baseURL: baseURL || "https://api-inference.modelscope.cn/v1",
        fetch: llm.fetch,
        headers: llm.config?.headers,
      }).languageModel(llm.model);
    } else if (llm.provider == "qwen-azure") {
      // Qwen on Azure - Qwen models deployed on Azure OpenAI
      // Azure endpoints follow the format: https://<resource-name>.<region>.inference.ml.azure.com/v1
      // User must provide the custom baseURL for their Azure deployment
      if (!baseURL) {
        throw new Error("Qwen Azure provider requires a custom baseURL. Please configure your Azure endpoint URL.");
      }
      // Tool call extraction happens in agent/llm.ts via extractToolCallsFromText()
      return createOpenAICompatible({
        name: llm.config?.name || llm.model,
        apiKey: apiKey,
        baseURL: baseURL,
        fetch: llm.fetch,
        headers: llm.config?.headers,
      }).languageModel(llm.model);
    } else if (llm.provider == "private-anthropic") {
      // private Anthropic provider - connects through websape server's SDF proxy
      // The proxy handles AAD authentication and forwards to SDF endpoint
      if (!baseURL) {
        throw new Error("private-anthropic provider requires baseURL to be set (e.g., http://localhost:8203/sdf/)");
      }
      return createAnthropic({
        apiKey: apiKey || "proxy-managed", // Placeholder, auth is handled by proxy
        baseURL: baseURL,
        fetch: llm.fetch,
        headers: llm.config?.headers,
      }).languageModel(llm.model);
    } else {
      return llm.provider.languageModel(llm.model);
    }
  }

  private streamWrapper(
    parts: LanguageModelV2StreamPart[],
    reader: ReadableStreamDefaultReader<LanguageModelV2StreamPart>,
    abortController: AbortController
  ): ReadableStream<LanguageModelV2StreamPart> {
    let timer: any = null;
    return new ReadableStream<LanguageModelV2StreamPart>({
      start: (controller) => {
        if (parts != null && parts.length > 0) {
          for (let i = 0; i < parts.length; i++) {
            controller.enqueue(parts[i]);
          }
        }
      },
      pull: async (controller) => {
        timer = setTimeout(() => {
          abortController.abort("Streaming request timeout");
        }, this.stream_token_timeout);
        const { done, value } = await reader.read();
        clearTimeout(timer);
        if (done) {
          controller.close();
          reader.releaseLock();
          return;
        }
        controller.enqueue(value);
      },
      cancel: (reason) => {
        timer && clearTimeout(timer);
        reader.cancel(reason);
      },
    });
  }

  private isGPT5OrNewer(model: string): boolean {
    // Check if the model is GPT-5 or newer models that require max_completion_tokens
    // This includes gpt-5, gpt-4o, gpt-4o-mini, and other newer models
    const lowerModel = model.toLowerCase();
    return (
      lowerModel.includes('gpt-5')
    );
  }

  public get Llms(): LLMs {
    return this.llms;
  }

  public get Names(): string[] {
    return this.names;
  }
}
