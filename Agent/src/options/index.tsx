import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { Form, Input, Button, message, Card, Select, AutoComplete, Switch, InputNumber, Collapse, Tooltip } from "antd";
import { BUILTIN_DEFAULT_LLM_MODEL, defaultLlmModelFromStored } from "../utils/default-model";

const { Option } = Select;
const { Panel } = Collapse;

// Simple question circle icon component (avoids @ant-design/icons dependency)
const QuestionCircleIcon = () => (
  <span style={{ 
    display: 'inline-flex', 
    alignItems: 'center', 
    justifyContent: 'center',
    width: '14px', 
    height: '14px', 
    borderRadius: '50%', 
    border: '1px solid #1890ff', 
    fontSize: '10px', 
    color: '#1890ff',
    marginLeft: '4px',
    cursor: 'help'
  }}>?</span>
);

// Agent mode types
type AgentMode = "single" | "multi";

// Multi-agent configuration interface
interface MultiAgentConfig {
  maxSubTaskSteps: number;
  maxSubTasks: number;
  maxIterations: number;
  maxHistorySummaries: number;
}

const DEFAULT_MULTI_AGENT_CONFIG: MultiAgentConfig = {
  maxSubTaskSteps: 10,
  maxSubTasks: 5,
  maxIterations: 10,
  maxHistorySummaries: 5,
};

const OptionsPage = () => {
  const [form] = Form.useForm();

  const [config, setConfig] = useState({
    llm: "anthropic",
    apiKey: "",
    // Will be replaced from chrome.storage on mount; safe sentinel for first paint.
    modelName: BUILTIN_DEFAULT_LLM_MODEL,
    apiType: "chat-completion",
    options: {
      // Will be replaced from chrome.storage on mount; safe fallback for first paint.
      baseURL: "https://api.anthropic.com/v1",
    },
  });

  // Agent mode state (separate from LLM config)
  const [agentMode, setAgentMode] = useState<AgentMode>("single");
  const [multiAgentConfig, setMultiAgentConfig] = useState<MultiAgentConfig>(DEFAULT_MULTI_AGENT_CONFIG);

  useEffect(() => {
    // Load LLM config
    chrome.storage.sync.get(["llmConfig", "defaultLlmModel"], (result) => {
      if (result.llmConfig) {
        if (result.llmConfig.llm === "") {
          result.llmConfig.llm = "anthropic";
        }
        // Backfill modelName from defaultLlmModel storage key if the
        // persisted llmConfig is missing one.
        if (!result.llmConfig.modelName) {
          result.llmConfig.modelName = defaultLlmModelFromStored(result.defaultLlmModel);
        }
        setConfig(result.llmConfig);
        form.setFieldsValue(result.llmConfig);
      } else if (result.defaultLlmModel) {
        // No persisted llmConfig yet; reflect the resolver-pinned default
        // model in the form's initial state.
        setConfig((prev) => ({ ...prev, modelName: defaultLlmModelFromStored(result.defaultLlmModel) }));
        form.setFieldsValue({ modelName: defaultLlmModelFromStored(result.defaultLlmModel) });
      }
    });

    // Load agent mode config
    chrome.storage.sync.get(["agentModeConfig"], (result) => {
      if (result.agentModeConfig) {
        setAgentMode(result.agentModeConfig.mode || "single");
        setMultiAgentConfig({
          ...DEFAULT_MULTI_AGENT_CONFIG,
          ...result.agentModeConfig.multiAgentConfig,
        });
      }
    });
  }, []);

  const handleSave = () => {
    form
      .validateFields()
      .then((values) => {
        setConfig(values);
        chrome.storage.sync.set(
          {
            llmConfig: values,
          },
          () => {
            message.success("LLM Config Saved!");
          }
        );
      })
      .catch(() => {
        message.error("Please check the form field");
      });
  };

  // Save agent mode configuration
  const handleAgentModeChange = (checked: boolean) => {
    const newMode: AgentMode = checked ? "multi" : "single";
    setAgentMode(newMode);
    chrome.storage.sync.set({
      agentModeConfig: {
        mode: newMode,
        multiAgentConfig: multiAgentConfig,
      },
    }, () => {
      message.success(`Agent mode set to: ${newMode === "multi" ? "Multi-Agent" : "Single-Agent"}`);
    });
  };

  // Save multi-agent configuration
  const handleMultiAgentConfigChange = (key: keyof MultiAgentConfig, value: number) => {
    const newConfig = { ...multiAgentConfig, [key]: value };
    setMultiAgentConfig(newConfig);
    chrome.storage.sync.set({
      agentModeConfig: {
        mode: agentMode,
        multiAgentConfig: newConfig,
      },
    });
  };

  const modelLLMs = [
    { value: "anthropic", label: "Claude" },
    { value: "openai", label: "OpenAI" },
  ];

  const modelOptions = {
    anthropic: [
      { value: "claude-opus-4-7", label: "Claude Opus 4.7" },
      { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { value: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
    ],
    openai: [
      { value: "gpt-4-turbo", label: "GPT-4 Turbo" },
      { value: "gpt-4", label: "GPT-4" },
      { value: "gpt-3.5-turbo", label: "GPT-3.5 Turbo" },
    ],
  };

  const handleLLMChange = (value: string) => {
    const baseURLMap: Record<string, string> = {
      openai: "https://api.openai.com/v1",
      anthropic: "https://api.anthropic.com/v1",
    };
    const newConfig = {
      llm: value,
      apiKey: "",
      modelName: modelOptions[value][0].value,
      apiType: "chat-completion",
      options: {
        baseURL: baseURLMap[value]
      },
    };
    setConfig(newConfig);
    form.setFieldsValue(newConfig);
  };

  return (
    <div className="p-6 max-w-xl mx-auto">
      <Card title="Browser Extension" className="shadow-md">
        <div style={{ padding: '12px', background: '#f6ffed', borderRadius: '6px', border: '1px solid #b7eb8f' }}>
          <span style={{ color: '#52c41a' }}>✅ Extension is installed. Use the sidebar panel to configure settings and run tasks.</span>
        </div>
      </Card>

      {/* Agent Mode Configuration Card */}
      <Card title="Agent Mode" className="shadow-md" style={{ marginTop: '16px' }}>
        <Form layout="vertical">
          <Form.Item 
            label={
              <span>
                Enable Multi-Agent Mode{' '}
                <Tooltip title="Multi-agent mode decomposes complex tasks into sub-tasks, each executed by a fresh agent with clean context. This helps prevent context overflow during long-running tasks.">
                  <QuestionCircleIcon />
                </Tooltip>
              </span>
            }
          >
            <Switch
              checked={agentMode === "multi"}
              onChange={handleAgentModeChange}
              checkedChildren="Multi-Agent"
              unCheckedChildren="Single-Agent"
            />
          </Form.Item>

          {agentMode === "multi" && (
            <Collapse ghost>
              <Panel header="Advanced Multi-Agent Settings" key="1">
                <Form.Item 
                  label={
                    <span>
                      Max Steps per Sub-task{' '}
                      <Tooltip title="Maximum number of browser actions each child agent can perform per sub-task">
                        <QuestionCircleIcon />
                      </Tooltip>
                    </span>
                  }
                >
                  <InputNumber
                    min={1}
                    max={50}
                    value={multiAgentConfig.maxSubTaskSteps}
                    onChange={(value) => handleMultiAgentConfigChange('maxSubTaskSteps', value || 10)}
                  />
                </Form.Item>

                <Form.Item 
                  label={
                    <span>
                      Max Sub-tasks per Iteration{' '}
                      <Tooltip title="Maximum number of sub-tasks the planner can create in each planning iteration">
                        <QuestionCircleIcon />
                      </Tooltip>
                    </span>
                  }
                >
                  <InputNumber
                    min={1}
                    max={10}
                    value={multiAgentConfig.maxSubTasks}
                    onChange={(value) => handleMultiAgentConfigChange('maxSubTasks', value || 5)}
                  />
                </Form.Item>

                <Form.Item 
                  label={
                    <span>
                      Max Planning Iterations{' '}
                      <Tooltip title="Maximum number of plan-execute cycles before giving up">
                        <QuestionCircleIcon />
                      </Tooltip>
                    </span>
                  }
                >
                  <InputNumber
                    min={1}
                    max={30}
                    value={multiAgentConfig.maxIterations}
                    onChange={(value) => handleMultiAgentConfigChange('maxIterations', value || 10)}
                  />
                </Form.Item>

                <Form.Item 
                  label={
                    <span>
                      History Summaries to Keep{' '}
                      <Tooltip title="Number of recent sub-task summaries to pass to the planner (higher = more context, lower = less memory)">
                        <QuestionCircleIcon />
                      </Tooltip>
                    </span>
                  }
                >
                  <InputNumber
                    min={1}
                    max={20}
                    value={multiAgentConfig.maxHistorySummaries}
                    onChange={(value) => handleMultiAgentConfigChange('maxHistorySummaries', value || 5)}
                  />
                </Form.Item>
              </Panel>
            </Collapse>
          )}

          <div style={{ padding: '12px', background: agentMode === 'multi' ? '#f6ffed' : '#f5f5f5', borderRadius: '6px', border: `1px solid ${agentMode === 'multi' ? '#b7eb8f' : '#d9d9d9'}`, marginTop: '12px' }}>
            {agentMode === 'multi' ? (
              <span style={{ color: '#52c41a' }}>
                🔀 <strong>Multi-Agent Mode:</strong> Tasks are decomposed into sub-tasks. Each sub-task runs with fresh context, helping prevent context overflow during complex tasks.
              </span>
            ) : (
              <span style={{ color: '#595959' }}>
                🔹 <strong>Single-Agent Mode (Default):</strong> Traditional single-agent execution. Best for simple tasks or when you need full context continuity.
              </span>
            )}
          </div>
        </Form>
      </Card>
    </div>
  );
};

const root = createRoot(document.getElementById("root")!);

root.render(
  <React.StrictMode>
    <OptionsPage />
  </React.StrictMode>
);
