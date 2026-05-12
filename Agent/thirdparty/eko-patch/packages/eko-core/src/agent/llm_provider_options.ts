import { SharedV2ProviderOptions } from "@ai-sdk/provider";

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
