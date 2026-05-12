import config from "../config";
import Log from "../common/log";
import * as memory from "../memory";
import { RetryLanguageModel } from "../llm";
import { mergeTools } from "../common/utils";
import { ToolWrapper } from "../tools/wrapper";
import { AgentChain, ToolChain } from "../core/chain";
import Context, { AgentContext } from "../core/context";
import { logToolCall, logToolResult, logWorkflowError, clearProgress } from "./browser/snapshot_uploader";
import {
  McpTool,
  ForeachTaskTool,
  WatchTriggerTool,
  VariableStorageTool,
} from "../tools";
import {
  Tool,
  IMcpClient,
  LLMRequest,
  ToolResult,
  ToolSchema,
  ToolExecuter,
  WorkflowAgent,
  HumanCallback,
  StreamCallback,
} from "../types";
import {
  LanguageModelV2Prompt,
  LanguageModelV2FilePart,
  LanguageModelV2TextPart,
  LanguageModelV2ToolCallPart,
  LanguageModelV2ToolResultPart,
} from "@ai-sdk/provider";
import {
  getTool,
  convertTools,
  callAgentLLM,
  convertToolResult,
  defaultMessageProviderOptions,
} from "./llm";
import { doTaskResultCheck } from "../tools/task_result_check";
import { doTodoListManager } from "../tools/todo_list_manager";
import { getDynamicPlanTools, getDynamicPlanPrompt, onLoopContinue, onBeforeReturn } from "../dynamic_plan";
import { getAgentSystemPrompt, getAgentUserPrompt } from "../prompt/agent";

export type AgentParams = {
  name: string;
  description: string;
  tools: Tool[];
  llms?: string[];
  mcpClient?: IMcpClient;
  planDescription?: string;
  requestHandler?: (request: LLMRequest) => void;
};

export class Agent {
  protected name: string;
  protected description: string;
  protected tools: Tool[] = [];
  protected llms?: string[];
  protected mcpClient?: IMcpClient;
  protected planDescription?: string;
  protected requestHandler?: (request: LLMRequest) => void;
  protected callback?: StreamCallback & HumanCallback;
  protected agentContext?: AgentContext;

  constructor(params: AgentParams) {
    this.name = params.name;
    this.description = params.description;
    this.tools = params.tools;
    this.llms = params.llms;
    this.mcpClient = params.mcpClient;
    this.planDescription = params.planDescription;
    this.requestHandler = params.requestHandler;
  }

  public async run(context: Context, agentChain: AgentChain): Promise<string> {
    const mcpClient = this.mcpClient || context.config.defaultMcpClient;
    const agentContext = new AgentContext(context, this, agentChain);
    try {
      this.agentContext = agentContext;
      mcpClient &&
        !mcpClient.isConnected() &&
        (await mcpClient.connect(context.controller.signal));
      return await this.runWithContext(
        agentContext,
        mcpClient,
        config.maxReactNum
      );
    } finally {
      mcpClient && (await mcpClient.close());
    }
  }

  public async runWithContext(
    agentContext: AgentContext,
    mcpClient?: IMcpClient,
    maxReactNum: number = 100,
    historyMessages: LanguageModelV2Prompt = []
  ): Promise<string> {
    Log.info(`[Task ${agentContext.context.taskId}][${agentContext.agent.Name}] Starting agent run.`);
    // const config = agentContext.context.config;
    let loopNum = 0;
    let checkNum = 0;
    this.agentContext = agentContext;
    const context = agentContext.context;
    const agentNode = agentContext.agentChain.agent;
    const tools = [...this.tools, ...this.system_auto_tools(agentNode), ...getDynamicPlanTools()];
    const systemPrompt = await this.buildSystemPrompt(agentContext, tools);
    const userPrompt = await this.buildUserPrompt(agentContext, tools);
    const messages: LanguageModelV2Prompt = [
      {
        role: "system",
        content: systemPrompt,
        providerOptions: defaultMessageProviderOptions(),
      },
      ...historyMessages,
      {
        role: "user",
        content: userPrompt,
        providerOptions: defaultMessageProviderOptions(),
      },
    ];
    agentContext.messages = messages;
    const rlm = new RetryLanguageModel(context.config.llms, this.llms);
    rlm.setContext(agentContext);
    let agentTools = tools;
    while (loopNum < maxReactNum) {
      await context.checkAborted();
      if (mcpClient) {
        const controlMcp = await this.controlMcpTools(
          agentContext,
          messages,
          loopNum
        );
        if (controlMcp.mcpTools) {
          const mcpTools = await this.listTools(
            context,
            mcpClient,
            agentNode,
            controlMcp.mcpParams
          );
          const usedTools = memory.extractUsedTool(messages, agentTools);
          const _agentTools = mergeTools(tools, usedTools);
          agentTools = mergeTools(_agentTools, mcpTools);
        }
      }
      await this.handleMessages(agentContext, messages, tools);
      const llm_tools = convertTools(agentTools);
      // Log.info(`[Task ${agentContext.context.taskId}][${agentContext.agent.Name}] Loop ${loopNum} - Current Messages:`, messages);
      Log.info(`[Task ${agentContext.context.taskId}][${agentContext.agent.Name}] Calling LLM with tools: ${llm_tools.map(tool => tool.name).join(", ")}`);
      const results = await callAgentLLM(
        agentContext,
        rlm,
        messages,
        llm_tools,
        false,
        undefined,
        0,
        this.callback,
        this.requestHandler
      );
      const forceStop = agentContext.variables.get("forceStop");
      if (forceStop) {
        return forceStop;
      }
      const finalResult = await this.handleCallResult(
        agentContext,
        messages,
        agentTools,
        results
      );
      loopNum++;
      if (!finalResult) {
        const dpHandled = await onLoopContinue(agentContext, rlm, messages, llm_tools, loopNum);
        if (!dpHandled && (config.mode == "expert" || config.expertMode) && loopNum % config.expertModeTodoLoopNum == 0) {
          await doTodoListManager(agentContext, rlm, messages, llm_tools);
        }
        continue;
      }
      const dpVerified = await onBeforeReturn(agentContext, rlm, messages, llm_tools);
      if (!dpVerified) {
        continue;
      }
      if ((config.mode == "expert" || config.expertMode) && checkNum == 0) {
        checkNum++;
        const { completionStatus } = await doTaskResultCheck(
          agentContext,
          rlm,
          messages,
          llm_tools
        );
        if (completionStatus == "incomplete") {
          continue;
        }
      }
      return finalResult;
    }
    return "Unfinished";
  }

  protected async handleCallResult(
    agentContext: AgentContext,
    messages: LanguageModelV2Prompt,
    agentTools: Tool[],
    results: Array<LanguageModelV2TextPart | LanguageModelV2ToolCallPart>
  ): Promise<string | null> {
    const user_messages: LanguageModelV2Prompt = [];
    const toolResults: LanguageModelV2ToolResultPart[] = [];
    // results = memory.removeDuplicateToolUse(results);
    messages.push({
      role: "assistant",
      content: results,
    });
    if (results.length == 0) {
      return null;
    }
    if (results.every((s) => s.type == "text")) {
      return results.map((s) => s.text).join("\n\n");
    }
    const toolCalls = results.filter((s) => s.type == "tool-call");
    Log.info(`[Task ${agentContext.context.taskId}][${agentContext.agent.Name}] Tool calls from LLM: ${toolCalls.length} calls`, 
      toolCalls.map((tc: any) => ({ toolName: tc.toolName, toolCallId: tc.toolCallId, input: tc.input }))
    );
    if (
      toolCalls.length > 1 &&
      this.canParallelToolCalls(toolCalls) &&
      toolCalls.every(
        (s) => agentTools.find((t) => t.name == s.toolName)?.supportParallelCalls
      )
    ) {
      const results = await Promise.all(
        toolCalls.map((toolCall) =>
          this.callToolCall(agentContext, agentTools, toolCall, user_messages, true)
        )
      );
      for (let i = 0; i < results.length; i++) {
        toolResults.push(results[i]);
      }
    } else {
      for (let i = 0; i < toolCalls.length; i++) {
        const toolCall = toolCalls[i];
        const toolResult = await this.callToolCall(
          agentContext,
          agentTools,
          toolCall,
          user_messages
        );
        toolResults.push(toolResult);
      }
    }
    if (toolResults.length > 0) {
      messages.push({
        role: "tool",
        content: toolResults,
      });
      user_messages.forEach((message) => messages.push(message));
      return null;
    } else {
      return results
        .filter((s) => s.type == "text")
        .map((s) => s.text)
        .join("\n\n");
    }
  }

  protected async callToolCall(
    agentContext: AgentContext,
    agentTools: Tool[],
    result: LanguageModelV2ToolCallPart,
    user_messages: LanguageModelV2Prompt = [],
    isParallel: boolean = false
  ): Promise<LanguageModelV2ToolResultPart> {
    const context = agentContext.context;
    const toolChain = new ToolChain(
      result,
      agentContext.agentChain.agentRequest as LLMRequest
    );
    agentContext.agentChain.push(toolChain);
    let toolResult: ToolResult;
    
    // Log param_sources validation failures but continue with tool execution
    const callback = this.callback || context.config.callback;
    if (callback?.getValidationFailures) {
      const validationFailures = callback.getValidationFailures(result.toolCallId);
      if (validationFailures && validationFailures.length > 0) {
        // Log validation failures but don't skip tool execution
        const errorMessage = callback.formatValidationFailures 
          ? callback.formatValidationFailures(validationFailures, result.toolCallId)
          : `Validation warning: Invalid tool_call ID references in param_sources for parameters: ${validationFailures.map(f => f.paramName).join(', ')}`;
        Log.warn("param_sources validation failure (continuing execution):", result.toolName, result.toolCallId, errorMessage);
      }
    }
    
    try {
      const args =
        typeof result.input == "string"
          ? JSON.parse(result.input || "{}")
          : result.input || {};
      toolChain.params = args;
      
      // Get agent prefix for multi-agent scenarios (e.g., "[Child #1]")
      const agentPrefix = agentContext.variables.get("agentPrefix") as string | undefined;
      
      // Log tool call to progress tracker
      logToolCall(
        agentContext.agent.Name,
        result.toolName,
        result.toolCallId,
        args,
        agentPrefix
      );
      
      let tool = getTool(agentTools, result.toolName);
      if (!tool) {
        throw new Error(result.toolName + " tool does not exist");
      }
      
      // Call hook for before tool execution (e.g., drift detection)
      await this.onBeforeToolExecute(agentContext, result, isParallel);
      
      toolResult = await tool.execute(args, agentContext, result);
      toolChain.updateToolResult(toolResult);
      agentContext.consecutiveErrorNum = 0;
      
      // Log tool result to progress tracker
      const resultText = toolResult.content
        ?.filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n') || '';
      logToolResult(
        agentContext.agent.Name,
        result.toolName,
        result.toolCallId,
        resultText,
        !!toolResult.isError,
        agentPrefix
      );
    } catch (e) {
      Log.error("tool call error: ", result.toolName, result.input, e);
      toolResult = {
        content: [
          {
            type: "text",
            text: e + "",
          },
        ],
        isError: true,
      };
      toolChain.updateToolResult(toolResult);
      
      // Log error to progress tracker (both as tool result and as categorized workflow error)
      const agentPrefixForError = agentContext.variables.get("agentPrefix") as string | undefined;
      logToolResult(
        agentContext.agent.Name,
        result.toolName,
        result.toolCallId,
        e + "",
        true,
        agentPrefixForError
      );
      
      // Also log as workflow error with categorization for easier filtering
      logWorkflowError(e, agentContext.agent.Name, result.toolName, result.toolCallId);
      
      if (++agentContext.consecutiveErrorNum >= 10) {
        throw e;
      }
    }
    
    // Call hook for after tool execution (e.g., for screenshot upload)
    await this.onAfterToolExecute(agentContext, result, toolResult, isParallel);
    
    if (callback) {
      await callback.onMessage(
        {
          taskId: context.taskId,
          agentName: agentContext.agent.Name,
          nodeId: agentContext.agentChain.agent.id,
          type: "tool_result",
          toolId: result.toolCallId,
          toolName: result.toolName,
          params: result.input || {},
          toolResult: toolResult,
        },
        agentContext
      );
    }
    
    // Sanitize tool result before adding to message history (can be overridden by subclasses)
    const sanitizedResult = this.sanitizeToolResultForHistory(toolResult);
    return convertToolResult(result, sanitizedResult, user_messages);
  }

  protected system_auto_tools(agentNode: WorkflowAgent): Tool[] {
    let tools: Tool[] = [];
    let agentNodeXml = agentNode.xml;
    let hasVariable =
      agentNodeXml.indexOf("input=") > -1 ||
      agentNodeXml.indexOf("output=") > -1;
    if (hasVariable) {
      tools.push(new VariableStorageTool());
    }
    let hasForeach = agentNodeXml.indexOf("</forEach>") > -1;
    if (hasForeach) {
      tools.push(new ForeachTaskTool());
    }
    let hasWatch = agentNodeXml.indexOf("</watch>") > -1;
    if (hasWatch) {
      tools.push(new WatchTriggerTool());
    }
    let toolNames = this.tools.map((tool) => tool.name);
    return tools.filter((tool) => toolNames.indexOf(tool.name) == -1);
  }

  protected async buildSystemPrompt(
    agentContext: AgentContext,
    tools: Tool[]
  ): Promise<string> {
    return getAgentSystemPrompt(
      this,
      agentContext.agentChain.agent,
      agentContext.context,
      tools,
      await this.extSysPrompt(agentContext, tools)
    );
  }

  protected async buildUserPrompt(
    agentContext: AgentContext,
    tools: Tool[]
  ): Promise<Array<LanguageModelV2TextPart | LanguageModelV2FilePart>> {
    return [
      {
        type: "text",
        text: getAgentUserPrompt(
          this,
          agentContext.agentChain.agent,
          agentContext.context,
          tools
        ),
      },
    ];
  }

  protected async extSysPrompt(
    agentContext: AgentContext,
    tools: Tool[]
  ): Promise<string> {
    let ext = "";
    // Inject website navigation guide if provided via context variables
    const guide = agentContext.context.variables.get("websiteNavigationGuide");
    if (typeof guide === "string" && guide.trim()) {
      ext += guide;
    }
    // Inject dynamic plan prompt when enabled
    ext += getDynamicPlanPrompt();
    return ext;
  }

  /**
   * Hook method called before each tool execution starts.
   * Override in subclasses to perform pre-execution checks (e.g., page drift detection).
   * @param agentContext The agent context
   * @param toolCall The tool call about to be executed
   * @param isParallel Whether this tool is executing as part of a parallel batch
   */
  protected async onBeforeToolExecute(
    agentContext: AgentContext,
    toolCall: LanguageModelV2ToolCallPart,
    isParallel: boolean = false
  ): Promise<void> {
    // Default implementation does nothing
    // Override in subclasses to add custom behavior
  }

  /**
   * Hook method called after each tool execution completes.
   * Override in subclasses to perform additional actions (e.g., screenshot upload).
   * @param agentContext The agent context
   * @param toolCall The tool call that was executed
   * @param toolResult The result of the tool execution
   * @param isParallel Whether this tool executed as part of a parallel batch
   */
  protected async onAfterToolExecute(
    agentContext: AgentContext,
    toolCall: LanguageModelV2ToolCallPart,
    toolResult: ToolResult,
    isParallel: boolean = false
  ): Promise<void> {
    // Default implementation does nothing
    // Override in subclasses to add custom behavior
  }

  /**
   * Hook method to sanitize tool results before adding to message history.
   * Override in subclasses to remove expensive fields that shouldn't be in history.
   * @param toolResult The original tool result
   * @returns The sanitized tool result for message history
   */
  protected sanitizeToolResultForHistory(toolResult: ToolResult): ToolResult {
    // Default implementation returns the result unchanged
    // Override in subclasses to remove fields like 'interactive_elements'
    return toolResult;
  }

  private async listTools(
    context: Context,
    mcpClient: IMcpClient,
    agentNode?: WorkflowAgent,
    mcpParams?: Record<string, unknown>
  ): Promise<Tool[]> {
    try {
      if (!mcpClient.isConnected()) {
        await mcpClient.connect(context.controller.signal);
      }
      let list = await mcpClient.listTools(
        {
          taskId: context.taskId,
          nodeId: agentNode?.id,
          environment: config.platform,
          agent_name: agentNode?.name || this.name,
          params: {},
          prompt: agentNode?.task || context.chain.taskPrompt,
          ...(mcpParams || {}),
        },
        context.controller.signal
      );
      let mcpTools: Tool[] = [];
      for (let i = 0; i < list.length; i++) {
        let toolSchema: ToolSchema = list[i];
        let execute = this.toolExecuter(mcpClient, toolSchema.name);
        let toolWrapper = new ToolWrapper(toolSchema, execute);
        mcpTools.push(new McpTool(toolWrapper));
      }
      return mcpTools;
    } catch (e) {
      Log.error("Mcp listTools error", e);
      return [];
    }
  }

  protected async controlMcpTools(
    agentContext: AgentContext,
    messages: LanguageModelV2Prompt,
    loopNum: number
  ): Promise<{
    mcpTools: boolean;
    mcpParams?: Record<string, unknown>;
  }> {
    return {
      mcpTools: loopNum == 0,
    };
  }

  protected toolExecuter(mcpClient: IMcpClient, name: string): ToolExecuter {
    return {
      execute: async function (args, agentContext): Promise<ToolResult> {
        return await mcpClient.callTool(
          {
            name: name,
            arguments: args,
            extInfo: {
              taskId: agentContext.context.taskId,
              nodeId: agentContext.agentChain.agent.id,
              environment: config.platform,
              agent_name: agentContext.agent.Name,
            },
          },
          agentContext.context.controller.signal
        );
      },
    };
  }

  protected async handleMessages(
    agentContext: AgentContext,
    messages: LanguageModelV2Prompt,
    tools: Tool[]
  ): Promise<void> {
    // Only keep the last image / file, large tool-text-result
    memory.handleLargeContextMessages(messages);
  }

  protected async callInnerTool(fun: () => Promise<any>): Promise<ToolResult> {
    let result = await fun();
    return {
      content: [
        {
          type: "text",
          text: result
            ? typeof result == "string"
              ? result
              : JSON.stringify(result)
            : "Successful",
        },
      ],
    };
  }

  public async loadTools(context: Context): Promise<Tool[]> {
    if (this.mcpClient) {
      let mcpTools = await this.listTools(context, this.mcpClient);
      if (mcpTools && mcpTools.length > 0) {
        return mergeTools(this.tools, mcpTools);
      }
    }
    return this.tools;
  }

  public addTool(tool: Tool) {
    this.tools.push(tool);
  }

  protected async onTaskStatus(
    status: "pause" | "abort" | "resume-pause",
    reason?: string
  ) {
    if (status == "abort" && this.agentContext) {
      this.agentContext?.variables.clear();
    }
  }

  public canParallelToolCalls(
    toolCalls?: LanguageModelV2ToolCallPart[]
  ): boolean {
    return config.parallelToolCalls;
  }

  get Llms(): string[] | undefined {
    return this.llms;
  }

  get Name(): string {
    return this.name;
  }

  get Description(): string {
    return this.description;
  }

  get Tools(): Tool[] {
    return this.tools;
  }

  get PlanDescription() {
    return this.planDescription;
  }

  get McpClient() {
    return this.mcpClient;
  }

  get AgentContext(): AgentContext | undefined {
    return this.agentContext;
  }
}
