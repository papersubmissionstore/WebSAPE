import config from "./config";
import Log from "./common/log";
import { Planner } from "./core/plan";
import { RetryLanguageModel } from "./llm";
import { EkoMemory } from "./memory/memory";
import { Eko, EkoDialogue } from "./core/index";
import Chain, { AgentChain } from "./core/chain";
import Context, { AgentContext } from "./core/context";
import { SimpleSseMcpClient, SimpleHttpMcpClient } from "./mcp";

export default Eko;

export {
  Eko,
  EkoDialogue,
  EkoMemory,
  Log,
  config,
  Context,
  Planner,
  AgentContext,
  Chain,
  AgentChain,
  SimpleSseMcpClient,
  SimpleHttpMcpClient,
  RetryLanguageModel,
};

export {
  Agent,
  type AgentParams,
  BaseFileAgent,
  BaseShellAgent,
  BaseComputerAgent,
  BaseBrowserAgent,
  BaseBrowserLabelsAgent,
  BaseBrowserScreenAgent,
  type BrowserSelector,
  setLabelStyle,
  getLabelStyle,
  type LabelStyle,
} from "./agent";

export {
  HumanInteractTool,
  TaskNodeStatusTool,
  VariableStorageTool,
  ForeachTaskTool,
  WatchTriggerTool,
} from "./tools";

export {
  type LLMs,
  type LLMConfig,
  type LLMprovider,
  type Tool,
  type EkoResult,
  type IMcpClient,
  type LLMRequest,
  type StreamCallback,
  type HumanCallback,
  type EkoConfig,
  type Workflow,
  type WorkflowAgent,
  type WorkflowNode,
  type StreamCallbackMessage,
} from "./types";

export {
  mergeTools,
  toImage,
  toFile,
  compressImageData,
  convertToolSchema,
  uuidv4,
  call_timeout,
  generateCorrelationId,
} from "./common/utils";

export {
  parseWorkflow,
  resetWorkflowXml,
  buildSimpleAgentWorkflow,
} from "./common/xml";

export { buildAgentTree } from "./common/tree";

export {
  ExecutionTracer,
  createTracingCallback,
  extractLoginIndicators,
  type TracedEvent,
  type ExecutionTrace,
  type AnalyzedToolCall,
  type ReasoningChain,
} from "./common/execution_tracer";
export { extract_page_content } from "./agent/browser/utils";
export { getCompressTokensThresholdForModel } from "./agent/llm";

export { 
  clearProgress,
  logReasoning,
  logToolCall,
  logToolResult,
  logInferenceTimePageDrift,
  logStatus,
  logPlanningResult,
  logResultSummary,
  logWorkflowError,
  categorizeError,
  getProgressEntries,
  // Debug mode and snapshot accumulation
  setDebugModeEnabled,
  isDebugModeEnabled,
  getAccumulatedSnapshots,
  clearAccumulatedSnapshots,
  // Multi-agent support
  createScopedProgressTracker,
  getScopedProgressTracker,
  mergeScopedTracker,
  getMainProgressTracker,
  logSubTaskStart,
  logSubTaskEnd,
  logParentPlanning,
  type ProgressEntry,
  type ErrorCategory,
  type AccumulatedSnapshot,
  type ParentPlanningData,
} from "./agent/browser/snapshot_uploader";
