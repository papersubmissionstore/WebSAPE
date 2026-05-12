/**
 * Resolve the default LLM model name used by `private-anthropic-*`
 * providers (and any provider whose dropdown the user hasn't touched).
 *
 * Mirrors `utils/sdf-endpoint.ts`: a chrome.storage.sync key
 * (`defaultLlmModel`) lets the resolver — or a power user — pin the
 * default model without code changes. When unset, helpers fall back to
 * `BUILTIN_DEFAULT_LLM_MODEL` so the extension still works for first-
 * time users.
 */

/** Last-resort default when neither storage nor caller specifies a model. */
export const BUILTIN_DEFAULT_LLM_MODEL = 'claude-opus-4-7';

export async function getDefaultLlmModel(): Promise<string> {
  try {
    const { defaultLlmModel } = await chrome.storage.sync.get(['defaultLlmModel']);
    if (typeof defaultLlmModel === 'string' && defaultLlmModel.trim()) {
      return defaultLlmModel.trim();
    }
  } catch {
    // chrome.storage may be unavailable in some test contexts.
  }
  return BUILTIN_DEFAULT_LLM_MODEL;
}

export function defaultLlmModelFromStored(
  value: string | undefined | null,
): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return BUILTIN_DEFAULT_LLM_MODEL;
}
