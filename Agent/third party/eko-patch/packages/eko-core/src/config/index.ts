type GlobalConfig = {
  name: string; // product name
  mode: "fast" | "normal" | "expert";
  platform: "windows" | "mac" | "linux";
  maxReactNum: number;
  maxTokens: number;
  maxRetryNum: number;
  agentParallel: boolean;
  compressThreshold: number; // Dialogue context compression threshold (message count)
  compressTokensThreshold: number; // Dialogue context compression threshold (token count)
  /** When true, compute compressTokensThreshold dynamically from the model's context window.
   *  When false, always use the static compressTokensThreshold value. */
  dynamicCompressThreshold: boolean;
  largeTextLength: number;
  fileTextMaxLength: number;
  maxDialogueImgFileNum: number;
  toolResultMultimodal: boolean;
  parallelToolCalls: boolean;
  markImageMode: "dom" | "draw";
  /** Tree building mode: "eko-native" uses build_dom_tree.ts, "a11y" uses accessibility tree via CDP */
  treeBuildMode: "eko-native" | "a11y";
  /** Whether to include non-indexed elements (static text without index) in pseudo DOM */
  includeNonIndexedElements: boolean;
  /** Maximum number of accessibility tree elements to process (prevents hanging on complex pages) */
  maxA11yElements: number;
  /** Viewport expansion in pixels (browser-use style). null = default eko behavior (strict viewport via elementFromPoint).
   *  When set to a number (e.g. 1000), elements within viewport ± this value are included in pseudo DOM. */
  viewportExpansion: number | null;
  /** When true, replace eko's single-point `isTopElement` (rect center hit-test) with a
   *  multi-probe variant (center + 4 inset corners + 4 edge midpoints).
   *  Useful when sticky overlays (e.g. fixed message composers, floating toolbars)
   *  occlude the center of otherwise-visible elements and cause them to be dropped
   *  from the indexed pseudo DOM. Implemented in is_top_element_multi_probe.ts. */
  multiProbeIsTopElement: boolean;
  /** When true, install the action-landing watchdog (see action_landing_watchdog.ts).
   *  The watchdog runs an in-page rescue when `validate_element_interactable`'s
   *  single-point occlusion check fails: it tries `scrollIntoView({block:'center'})`
   *  on the target and re-tests, instead of immediately raising the
   *  "covered by another element" error. Each invocation appends structured
   *  events (occlusion_check / auto_scroll_into_view / occlusion_recheck) into a
   *  page-side buffer that the host drains after the action and attaches to the
   *  tool result as `actionLandingEvents` (visible only in progress.json, never
   *  surfaced to the LLM). */
  actionLandingWatchdog: boolean;
  /** @deprecated please use mode set to expert */
  expertMode: boolean;
  expertModeTodoLoopNum: number;
  /** Enable verbose logging of LLM context (messages, tools) for each LLM call */
  logLLMContext: boolean;
  /**
   * Enable the voluntary `todo_write` tool path: registers the
   * `TodoWriteTool` in the agent's toolset, prepends a system-prompt
   * snippet instructing the agent to track its progress with the tool,
   * skips the forced `doTodoListManager` audit in `onLoopContinue`, and
   * unlocks `tryIncrementalReplan` / `buildTodoSuffix` in the planner.
   *
   * Renamed from the historical `dynamicPlan`. The new name reflects what
   * the flag actually does (voluntary todo-rewrite + incremental replan)
   * after the verification nudge moved to its own `enableEkoPostVerify`
   * sub-flag and the pre-plan exploration step moved out of eko-core
   * entirely (the host now drives it via `plan_ext_prompt`).
   *
   * Default: false.
   */
  enableEkoTodoRewrite: boolean;
  /**
   * Gate the agent-side verification nudge (Pattern 5/B in dynamic_plan).
   *
   * When BOTH this flag AND `enableEkoTodoRewrite` are true, the agent's
   * `onBeforeReturn` hook may inject a `# Verification Required` user
   * message and force one extra ReAct loop iteration before returning a
   * final result — but only when the agent has ≥3 completed todo items
   * and the nudge has not yet fired this run.
   *
   * Depends on `enableEkoTodoRewrite` because the nudge reads completed-todo
   * count from agent context state populated by the `TodoWriteTool`. With
   * `enableEkoTodoRewrite=false` no tool ever writes that state, so even
   * with this flag on the nudge would be a no-op every loop iteration.
   * The hook short-circuits on `!enableEkoTodoRewrite` to keep the per-loop
   * cost zero.
   *
   * Default: false. Hosts must opt-in explicitly because the nudge costs
   * one extra LLM round per agent run, and on long-context tasks that
   * round can land near the wall-clock budget.
   */
  enableEkoPostVerify: boolean;
}

/**
 * Scoped config for multi-agent scenarios.
 * Allows child agents to have isolated configuration without affecting the global config.
 */
export interface ScopedConfig {
  scopeId: string;
  snapshotSessionId?: string;
  enableDebugMode?: boolean;
}

// Map of scoped configs for multi-agent support
const scopedConfigs = new Map<string, ScopedConfig>();

/**
 * Create a scoped config for a child agent
 */
export function createScopedConfig(scopeId: string, overrides?: Partial<ScopedConfig>): ScopedConfig {
  const scopedConfig: ScopedConfig = {
    scopeId,
    snapshotSessionId: overrides?.snapshotSessionId || scopeId,
    enableDebugMode: overrides?.enableDebugMode ?? false,
  };
  scopedConfigs.set(scopeId, scopedConfig);
  return scopedConfig;
}

/**
 * Get a scoped config by ID
 */
export function getScopedConfig(scopeId: string): ScopedConfig | undefined {
  return scopedConfigs.get(scopeId);
}

/**
 * Remove a scoped config when child agent completes
 */
export function removeScopedConfig(scopeId: string): void {
  scopedConfigs.delete(scopeId);
}

/**
 * Get the effective session ID for a given scope (or global if no scope)
 */
export function getEffectiveSessionId(scopeId?: string): string {
  if (scopeId) {
    const scopedConfig = scopedConfigs.get(scopeId);
    if (scopedConfig?.snapshotSessionId) {
      return scopedConfig.snapshotSessionId;
    }
  }
  return '';
}

const config: GlobalConfig = {
  name: "Eko",
  mode: "normal",
  platform: "mac",
  maxReactNum: 500,
  maxTokens: 16000,
  maxRetryNum: 3,
  agentParallel: false,
  compressThreshold: 80,
  compressTokensThreshold: 80000,
  dynamicCompressThreshold: false,
  largeTextLength: 8000,
  fileTextMaxLength: 20000,
  maxDialogueImgFileNum: 1,
  toolResultMultimodal: true,
  parallelToolCalls: true,
  markImageMode: "dom",
  treeBuildMode: "eko-native", // "eko-native" = eko native DOM tree, "a11y" = a11y pseudo accessibility tree via CDP
  includeNonIndexedElements: true, // Whether to include non-indexed elements (static text) in pseudo DOM
  maxA11yElements: 1000, // Maximum number of accessibility tree elements to process
  viewportExpansion: null, // null = eko default (strict viewport), number = expanded viewport in pixels (e.g. 1000)
  multiProbeIsTopElement: false, // when true, use multi-point hit-test for occlusion (rescues partially-overlapped elements)
  actionLandingWatchdog: false, // when true, install in-page watchdog to rescue covered-element actions via scrollIntoView
  expertMode: false,
  expertModeTodoLoopNum: 10,
  logLLMContext: false,
  enableEkoTodoRewrite: false,
  enableEkoPostVerify: false,
};

export default config;