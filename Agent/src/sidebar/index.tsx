import { createRoot } from "react-dom/client";
import React, { useState, useRef, useEffect, useCallback } from "react";
import { Button, Input, Space, Dropdown, Menu, Typography, Divider, Modal, Card, Switch, Tooltip, Progress, Collapse, Tag, AutoComplete, message } from "antd";
import { config } from "@eko-ai/eko";
import { logger, SessionLog, StructuredLogEntry, PlanStep } from "../utils/logger";
import type { HumanInteractionRequest, HumanInteractionResponse } from "../background/human_interaction";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BUILTIN_DEFAULT_LLM_MODEL, defaultLlmModelFromStored } from "../utils/default-model";

const { Text } = Typography;
const { Panel } = Collapse;

/** Bundled instruction version (standalone, no server versioning) */
const INSTRUCTION_VERSIONS = [
  'outlook',
];

// LLM Provider options
const MODEL_LLMS = [
  { value: "anthropic", label: "Claude" },
  { value: "openai", label: "OpenAI" },
];

// Base URL map per LLM provider
const BASE_URL_MAP: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
};

function baseUrlFor(provider: string): string {
  return BASE_URL_MAP[provider] || '';
}

interface LogMessage {
  time: string;
  log: string;
  level?: "info" | "error" | "success";
}

const AppRun = () => {
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<LogMessage[]>([]);
  const [structuredLogs, setStructuredLogs] = useState<StructuredLogEntry[]>([]);
  const [streamLog, setStreamLog] = useState<LogMessage | null>();
  const [mode, setMode] = useState<"fast" | "normal" | "expert">(config.mode);
  const [markImageMode, setMarkImageMode] = useState<"dom" | "draw">(
    config.markImageMode
  );
  const [treeBuildMode, setTreeBuildMode] = useState<"eko-native" | "a11y">(
    "a11y"
  );
  // Whether to include non-indexed elements (static text without highlight index) in pseudo DOM
  // Default to false to reduce noise in DOM output
  const [includeNonIndexedElements, setIncludeNonIndexedElements] = useState<boolean>(false);
  // Maximum number of accessibility tree elements to process (prevents hanging on complex pages)
  const [maxA11yElements, setMaxA11yElements] = useState<number>(1000);
  // Viewport expansion in pixels (browser-use style). null = default eko behavior (strict viewport).
  const [viewportExpansion, setViewportExpansionState] = useState<number | null>(1000);
  // Multi-probe isTopElement override (rescues partially-occluded elements like rows under sticky composers)
  const [multiProbeIsTopElement, setMultiProbeIsTopElementState] = useState<boolean>(false);
  // Action-landing watchdog: rescues click/hover when the target's center is
  // covered by another element by trying scrollIntoView+recheck before erroring.
  // Emits actionLandingEvents into progress.json (never visible to LLM).
  const [actionLandingWatchdog, setActionLandingWatchdogState] = useState<boolean>(false);
  const [sessions, setSessions] = useState<SessionLog[]>([]);
  const [showSessionHistory, setShowSessionHistory] = useState(false);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const [prompt, setPrompt] = useState(
    'Search for laptop on Amazon'
  );
  
  // Plan tracking state
  const [currentPlanSteps, setCurrentPlanSteps] = useState<PlanStep[]>([]);
  const [expandedPlan, setExpandedPlan] = useState(true);
  
  // Human interaction state
  const [pendingInteraction, setPendingInteraction] = useState<HumanInteractionRequest | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [selectedOptions, setSelectedOptions] = useState<string[]>([]);

  const [showServerSettings, setShowServerSettings] = useState(false);
  const [showDebugPanel, setShowDebugPanel] = useState(false);

  // Debug mode state (enables snapshot upload for screenshots and DOM HTML)
  const [debugModeEnabled, setDebugModeEnabled] = useState(false);

  // Snapshot link shown after query execution completes (when debug mode is on)
  const [lastSnapshotUrl, setLastSnapshotUrl] = useState<string | null>(null);

  // Log LLM context state (logs full message context for each LLM call)
  const [logLLMContext, setLogLLMContext] = useState(false);

  // Disable human_interact tool (prevents agent from asking user for input/confirmation)
  const [disableHumanInteract, setDisableHumanInteract] = useState(false);

  // Dynamic compress threshold (auto-detect context length per model)
  const [dynamicCompressThreshold, setDynamicCompressThreshold] = useState(false);

  // Label style: "noocclude" (outlined, smart-positioned) vs "legacy" (solid background, fixed position)
  const [labelStyle, setLabelStyleState] = useState<'noocclude' | 'legacy'>('legacy');

  // Feature toggles
  const [useInstructions, setUseInstructions] = useState(false);
  const [useExperience, setUseExperience] = useState(false);


  // LLM Config state
  const [llmProvider, setLlmProvider] = useState('anthropic');
  const [llmModel, setLlmModel] = useState('claude-opus-4-7');
  const [llmApiKey, setLlmApiKey] = useState('');
  const [llmApiType, setLlmApiType] = useState<'responses-api' | 'chat-completion'>('chat-completion');
  const [anthropicEndpoint, setAnthropicEndpoint] = useState('https://api.anthropic.com/v1');
  const [openaiEndpoint, setOpenaiEndpoint] = useState('https://api.openai.com/v1');


  // Experience version selection
  const [experienceVersions, setExperienceVersions] = useState<{ name: string; epoch?: number; updatedAt?: string }[]>([]);
  const [selectedExperienceVersion, setSelectedExperienceVersion] = useState<string>('none');

  // Instructions version selection
  const [instructionVersions, setInstructionVersions] = useState<string[]>([]);
  const [selectedInstructionsVersion, setSelectedInstructionsVersion] = useState<string>(INSTRUCTION_VERSIONS[0]);
  const [instructionsVersionTouched, setInstructionsVersionTouched] = useState(false);

  // Tools version selection
  const [toolVersions, setToolVersions] = useState<string[]>([]);
  const [selectedToolsVersion, setSelectedToolsVersion] = useState<string>('');
  const [toolsVersionTouched, setToolsVersionTouched] = useState(false);

  // Handle sending interaction response back to background
  const sendInteractionResponse = useCallback((response: HumanInteractionResponse) => {
    chrome.runtime.sendMessage({
      type: 'human_interaction_response',
      response,
    });
    setPendingInteraction(null);
    setInputValue('');
    setSelectedOptions([]);
  }, []);

  // Handle confirm/help - user clicks Yes
  const handleConfirmYes = useCallback(() => {
    if (pendingInteraction) {
      sendInteractionResponse({
        id: pendingInteraction.id,
        confirmed: true,
      });
    }
  }, [pendingInteraction, sendInteractionResponse]);

  // Handle confirm/help - user clicks No/Skip
  const handleConfirmNo = useCallback(() => {
    if (pendingInteraction) {
      sendInteractionResponse({
        id: pendingInteraction.id,
        confirmed: false,
        cancelled: true,
      });
    }
  }, [pendingInteraction, sendInteractionResponse]);

  // Handle input submit
  const handleInputSubmit = useCallback(() => {
    if (pendingInteraction) {
      sendInteractionResponse({
        id: pendingInteraction.id,
        input: inputValue,
      });
    }
  }, [pendingInteraction, inputValue, sendInteractionResponse]);

  // Handle input cancel
  const handleInputCancel = useCallback(() => {
    if (pendingInteraction) {
      sendInteractionResponse({
        id: pendingInteraction.id,
        cancelled: true,
      });
    }
  }, [pendingInteraction, sendInteractionResponse]);

  // Handle select submit
  const handleSelectSubmit = useCallback(() => {
    if (pendingInteraction) {
      sendInteractionResponse({
        id: pendingInteraction.id,
        selections: selectedOptions,
      });
    }
  }, [pendingInteraction, selectedOptions, sendInteractionResponse]);

  // Toggle option selection
  const toggleOption = useCallback((option: string) => {
    setSelectedOptions(prev => {
      if (pendingInteraction?.multiple) {
        return prev.includes(option)
          ? prev.filter(o => o !== option)
          : [...prev, option];
      } else {
        return [option];
      }
    });
  }, [pendingInteraction?.multiple]);

  // Standalone: Initialize instruction versions from bundled list only
  useEffect(() => {
    setInstructionVersions(INSTRUCTION_VERSIONS);
  }, []);

  // Standalone: Use bundled experience
  useEffect(() => {
    setExperienceVersions([
      { name: 'outlook', updatedAt: 'Bundled' }
    ]);
  }, []);

  // Standalone: No remote tools available
  useEffect(() => {
    setToolVersions([]);
  }, []);

  useEffect(() => {
    logger.info("SIDEBAR_INIT", "Sidebar component initialized");
    
    // Load saved state
    chrome.storage.local.get(["running", "prompt"], (result) => {
      logger.debug("SIDEBAR_STATE", "Loading saved state", {
        running: result.running,
        hasPrompt: !!result.prompt,
      });
      if (result.running !== undefined) {
        setRunning(result.running);
      }
      if (result.prompt !== undefined) {
        setPrompt(result.prompt);
      }
    });

    // Load debug mode setting from storage
    chrome.storage.sync.get(["debugModeEnabled"], (result) => {
      const enabled = result.debugModeEnabled ?? false;
      setDebugModeEnabled(enabled);
      logger.debug("SIDEBAR_STATE", "Loaded debug mode setting", { enabled });
    });

    // Load log LLM context setting from storage
    chrome.storage.sync.get(["logLLMContext"], (result) => {
      const enabled = result.logLLMContext ?? false;
      setLogLLMContext(enabled);
      logger.debug("SIDEBAR_STATE", "Loaded logLLMContext setting", { enabled });
    });

    // Load disableHumanInteract setting from storage
    chrome.storage.sync.get(["disableHumanInteract"], (result) => {
      const enabled = result.disableHumanInteract ?? false;
      setDisableHumanInteract(enabled);
      logger.debug("SIDEBAR_STATE", "Loaded disableHumanInteract setting", { enabled });
    });

    // Load dynamicCompressThreshold setting from storage
    chrome.storage.sync.get(["dynamicCompressThreshold"], (result) => {
      const enabled = result.dynamicCompressThreshold ?? false;
      setDynamicCompressThreshold(enabled);
      logger.debug("SIDEBAR_STATE", "Loaded dynamicCompressThreshold setting", { enabled });
    });

    // Load labelStyle setting from storage
    chrome.storage.sync.get(["labelStyle"], (result) => {
      const style = result.labelStyle ?? 'legacy';
      setLabelStyleState(style);
      logger.debug("SIDEBAR_STATE", "Loaded labelStyle setting", { style });
    });

    // Load maxA11yElements setting from storage (0 means unlimited)
    chrome.storage.sync.get(["maxA11yElements"], (result) => {
      const value = result.maxA11yElements !== undefined ? result.maxA11yElements : 1000;
      setMaxA11yElements(value);
      logger.debug("SIDEBAR_STATE", "Loaded maxA11yElements setting", { value, unlimited: value === 0 });
    });

    // Load viewportExpansion setting from storage (1000 = default)
    chrome.storage.sync.get(["viewportExpansion"], (result) => {
      const value = result.viewportExpansion !== undefined ? result.viewportExpansion : 1000;
      setViewportExpansionState(value);
      logger.debug("SIDEBAR_STATE", "Loaded viewportExpansion setting", { value });
    });

    // Load multiProbeIsTopElement setting from storage (false = default)
    chrome.storage.sync.get(["multiProbeIsTopElement"], (result) => {
      const value = result.multiProbeIsTopElement ?? false;
      setMultiProbeIsTopElementState(value);
      logger.debug("SIDEBAR_STATE", "Loaded multiProbeIsTopElement setting", { value });
    });

    // Load actionLandingWatchdog setting from storage (false = default)
    chrome.storage.sync.get(["actionLandingWatchdog"], (result) => {
      const value = result.actionLandingWatchdog ?? false;
      setActionLandingWatchdogState(value);
      logger.debug("SIDEBAR_STATE", "Loaded actionLandingWatchdog setting", { value });
    });

    // Load persisted mode settings (treeBuildMode, mode, markImageMode, includeNonIndexedElements)
    chrome.storage.sync.get(["treeBuildMode", "mode", "markImageMode", "includeNonIndexedElements"], (result) => {
      if (result.treeBuildMode)              setTreeBuildMode(result.treeBuildMode);
      if (result.mode)                       setMode(result.mode);
      if (result.markImageMode)              setMarkImageMode(result.markImageMode);
      if (result.includeNonIndexedElements !== undefined) setIncludeNonIndexedElements(result.includeNonIndexedElements);
      logger.debug("SIDEBAR_STATE", "Loaded persisted mode settings", {
        treeBuildMode: result.treeBuildMode ?? "(default: a11y)",
        mode: result.mode,
        markImageMode: result.markImageMode,
        includeNonIndexedElements: result.includeNonIndexedElements,
      });
    });

    // Load feature toggles from storage
    chrome.storage.sync.get(["useInstructions", "useExperience", "instructionsVersion", "toolsVersion", "experienceVersion"], (result) => {
      setUseInstructions(result.useInstructions ?? false);
      setUseExperience(result.useExperience ?? false);
      const persistedExperienceVersion = result.experienceVersion ?? 'none';
      setSelectedExperienceVersion(persistedExperienceVersion);
      if (result.instructionsVersion) {
        setSelectedInstructionsVersion(result.instructionsVersion);
        setInstructionsVersionTouched(true);
      } else {
        // First install: persist default version to storage so background script can read it
        chrome.storage.sync.set({ instructionsVersion: INSTRUCTION_VERSIONS[0], useInstructions: true });
        setUseInstructions(true);
      }
      if (result.toolsVersion) {
        setSelectedToolsVersion(result.toolsVersion);
        setToolsVersionTouched(true);
      }
      logger.debug("SIDEBAR_STATE", "Loaded feature toggles", { 
        useInstructions: result.useInstructions ?? false, 
        experienceVersion: persistedExperienceVersion,
        instructionsVersion: result.instructionsVersion ?? '',
        toolsVersion: result.toolsVersion ?? '',
      });
    });

    // Load LLM config from storage
    chrome.storage.sync.get(["llmConfig", "defaultLlmModel"], (result) => {
      const fallbackModel = defaultLlmModelFromStored(result.defaultLlmModel);
      if (result.llmConfig) {
        setLlmProvider(result.llmConfig.llm || 'private-anthropic-remote');
        setLlmModel(result.llmConfig.modelName || fallbackModel);
        setLlmApiKey(result.llmConfig.apiKey || '');
        setLlmApiType(result.llmConfig.apiType || 'responses-api');
        logger.debug("SIDEBAR_STATE", "Loaded LLM config", { 
          llm: result.llmConfig.llm,
          modelName: result.llmConfig.modelName,
          apiType: result.llmConfig.apiType,
        });
      }
    });

    // Load session history
    loadSessionHistory();
    
    // Check for any pending human interactions (may exist if sidebar was reopened)
    chrome.runtime.sendMessage({ type: 'get_pending_interactions' }, (response) => {
      if (response?.interactions?.length > 0) {
        logger.info("SIDEBAR_INIT", "Found pending human interaction on load", {
          count: response.interactions.length,
          firstId: response.interactions[0]?.id,
        });
        // Show the most recent pending interaction
        const mostRecent = response.interactions.sort(
          (a: HumanInteractionRequest, b: HumanInteractionRequest) => b.timestamp - a.timestamp
        )[0];
        setPendingInteraction(mostRecent);
      }
    });
    
    const messageListener = (message: any) => {
      if (!message) {
        return;
      }
      
      // Only log non-routine messages to avoid flooding logs
      // "log" and "structured_log" messages are routine and happen very frequently
      if (message.type !== "log" && message.type !== "structured_log") {
        logger.debug("SIDEBAR_MESSAGE", `Received message: ${message.type}`, {
          messageType: message.type,
        });
      }
      
      if (message.type === "stop") {
        logger.logUserAction("Workflow stopped");
        setRunning(false);
        chrome.storage.local.set({ running: false });
        // Clear any pending interaction when workflow stops
        setPendingInteraction(null);
        // Show snapshot link if debug mode was on and snapshots were uploaded
        if (message.snapshotUrl) {
          setLastSnapshotUrl(message.snapshotUrl);
        }
      } else if (message.type === "human_interaction_request") {
        // Handle human interaction requests from background
        logger.info("HUMAN_INTERACTION", "Received interaction request", {
          type: message.request?.type,
          id: message.request?.id,
        });
        setPendingInteraction(message.request);
        setInputValue('');
        setSelectedOptions([]);
      } else if (message.type === "structured_log") {
        // Handle structured log entries for consolidated display
        const entry = message.entry as StructuredLogEntry;
        if (entry) {
          setStructuredLogs(prev => [...prev, entry]);
          // Update plan steps if this is a plan-related entry
          if (entry.type === 'plan' && entry.planSteps) {
            setCurrentPlanSteps(entry.planSteps);
          } else if (entry.type === 'plan_step' && entry.planSteps) {
            setCurrentPlanSteps(entry.planSteps);
          }
        }
      } else if (message.type === "snapshot_saved") {
        // Handle snapshot saved notifications (only when debug mode is on)
        if (debugModeEnabled) {
          const snapshotEntry: StructuredLogEntry = {
            id: `snapshot_${Date.now()}`,
            timestamp: new Date().toISOString(),
            type: 'snapshot',
            snapshotType: message.snapshotType,
            snapshotPath: message.path,
            level: 'info',
          };
          setStructuredLogs(prev => [...prev, snapshotEntry]);
        }
      } else if (message.type === "log") {
        // Filter out empty or undefined log messages
        if (!message.log || message.log.trim() === "") {
          return;
        }
        
        const time = new Date().toLocaleTimeString();
        const log_message = {
          time,
          log: message.log,
          level: message.level || "info",
        };
        if (message.stream) {
          setStreamLog(log_message);
        } else {
          setStreamLog(null);
          setLogs((prev) => [...prev, log_message]);
        }
      }
    };
    chrome.runtime.onMessage.addListener(messageListener);

    return () => {
      chrome.runtime.onMessage.removeListener(messageListener);
    };
  }, []);

  useEffect(() => {
    window.scrollTo({
      behavior: "smooth",
      top: document.body.scrollHeight + 10,
    });
  }, [logs, streamLog, structuredLogs]);

  const loadSessionHistory = () => {
    try {
      const allSessions = logger.getAllSessions();
      setSessions(allSessions);
    } catch (e) {
      console.error("Failed to load session history:", e);
    }
  };


  const handleClick = () => {
    if (running) {
      logger.logUserAction("User clicked stop button");
      // End current session as aborted
      logger.endSession('aborted');
      setRunning(false);
      chrome.storage.local.set({ running: false, prompt });
      chrome.runtime.sendMessage({ type: "stop" });
      loadSessionHistory(); // Refresh session list
      return;
    }
    if (!prompt.trim()) {
      logger.warning("USER_INPUT", "Empty prompt provided");
      return;
    }
    logger.logUserAction("User clicked run button", {
      promptLength: prompt.length,
      promptPreview: prompt.substring(0, 100),
    });
    setLogs([]);
    setStructuredLogs([]);  // Clear structured logs for new run
    setCurrentPlanSteps([]); // Clear plan steps for new run
    setLastSnapshotUrl(null); // Clear previous snapshot link
    setRunning(true);
    chrome.storage.local.set({ running: true, prompt });
    
    // Generate quicktrial folder prefix with date for organizing snapshots
    // Format: quicktrial_YYYYMMDD (e.g., quicktrial_20260116)
    // Groups all quick trials from the same day together
    const now = new Date();
    const quickTrialFolderPrefix = `quicktrial_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    
    // Check if resolver set run overrides via window variable (synchronous, no race).
    const windowOverrides = (window as any).__websape_runOverrides as {
      localOutputDir?: string;
      resolverTaskId?: string;
      dataset?: string;
      taskId?: string;
      timeoutMs?: number;
    } | undefined;

    // Consume immediately (one-shot)
    if (windowOverrides) {
      delete (window as any).__websape_runOverrides;
    }

    chrome.runtime.sendMessage({
      type: "run",
      prompt: prompt.trim(),
      quickTrialFolderPrefix,
      dataset: windowOverrides?.dataset || "custom",
      mode,
      markImageMode,
      treeBuildMode,
      includeNonIndexedElements,
      maxA11yElements,
      localOutputDir: windowOverrides?.localOutputDir,
      ...(windowOverrides?.resolverTaskId ? { resolverTaskId: windowOverrides.resolverTaskId } : {}),
      ...(windowOverrides?.taskId ? { taskId: windowOverrides.taskId } : {}),
      ...(windowOverrides?.timeoutMs ? { timeoutMs: windowOverrides.timeoutMs } : {}),
    });
  };

  const handleExportCurrentSession = () => {
    try {
      const currentSessionId = logger.getCurrentSessionId();
      if (currentSessionId) {
        logger.downloadSessionData(currentSessionId);
        logger.logUserAction("Exported current session data", { sessionId: currentSessionId });
      } else {
        // Export all current logs if no active session
        const data = {
          exportTimestamp: new Date().toISOString(),
          logs: logs,
          currentPrompt: prompt
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `websape-logs-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        logger.logUserAction("Exported current logs");
      }
    } catch (e) {
      console.error("Failed to export session data:", e);
      logger.error("EXPORT_ERROR", "Failed to export session data", { error: e.toString() });
    }
  };

  const handleExportAllSessions = () => {
    try {
      logger.downloadSessionData();
      logger.logUserAction("Exported all session data");
    } catch (e) {
      console.error("Failed to export all sessions:", e);
      logger.error("EXPORT_ERROR", "Failed to export all sessions", { error: e.toString() });
    }
  };

  const handleExportSession = (sessionId: string) => {
    try {
      logger.downloadSessionData(sessionId);
      logger.logUserAction("Exported specific session", { sessionId });
    } catch (e) {
      console.error(`Failed to export session ${sessionId}:`, e);
      logger.error("EXPORT_ERROR", "Failed to export session", { sessionId, error: e.toString() });
    }
  };

  const handleClearSessions = () => {
    if (window.confirm("Are you sure you want to clear all session history? This action cannot be undone.")) {
      logger.clearSessions();
      setSessions([]);
      logger.logUserAction("Cleared all session history");
    }
  };

  const formatDuration = (startTime: string, endTime?: string) => {
    const start = new Date(startTime).getTime();
    const end = endTime ? new Date(endTime).getTime() : Date.now();
    const duration = Math.round((end - start) / 1000);
    
    if (duration < 60) return `${duration}s`;
    if (duration < 3600) return `${Math.floor(duration / 60)}m ${duration % 60}s`;
    return `${Math.floor(duration / 3600)}h ${Math.floor((duration % 3600) / 60)}m`;
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed': return '#52c41a';
      case 'failed': return '#ff4d4f';
      case 'aborted': return '#faad14';
      case 'running': return '#1890ff';
      default: return '#666';
    }
  };

  const exportMenu = (
    <Menu>
      <Menu.Item key="current" onClick={handleExportCurrentSession}>
        Export Current Session
      </Menu.Item>
      <Menu.Item key="all" onClick={handleExportAllSessions}>
        Export All Sessions
      </Menu.Item>
      <Menu.Divider />
      <Menu.Item key="clear" onClick={handleClearSessions} style={{ color: '#ff4d4f' }}>
        Clear All Sessions
      </Menu.Item>
    </Menu>
  );

  const getLogStyle = (level: string) => {
    switch (level) {
      case "error":
        return { color: "#ff4d4f" };
      case "success":
        return { color: "#52c41a" };
      default:
        return { color: "#1890ff" };
    }
  };

  // Render a single structured log entry
  const renderStructuredLogEntry = (entry: StructuredLogEntry, allLogs: StructuredLogEntry[]) => {
    const time = new Date(entry.timestamp).toLocaleTimeString();
    
    switch (entry.type) {
      case 'experience':
        return (
          <div key={entry.id} style={{
            margin: "6px 0",
            padding: "8px 10px",
            backgroundColor: "#f9f0ff",
            borderLeft: "3px solid #722ed1",
            borderRadius: "0 4px 4px 0",
          }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: "4px", flexWrap: 'wrap' }}>
              <span style={{ fontSize: "11px", color: "#999" }}>{time}</span>
              <Tag color="purple" style={{ marginLeft: "8px", fontSize: "10px" }}>🧠 Experience</Tag>
              <Text type="secondary" style={{ marginLeft: "8px", fontSize: "10px" }}>
                {typeof entry.experienceReadCount === 'number' ? ` | read=${entry.experienceReadCount}` : ''}
                {typeof entry.experienceSelectedCount === 'number' ? ` | selected=${entry.experienceSelectedCount}` : ''}
              </Text>
            </div>
            {entry.experiencePreview && (
              <div style={{
                fontFamily: "monospace",
                fontSize: "10px",
                backgroundColor: "#fff",
                border: "1px solid #d3adf7",
                padding: "6px",
                borderRadius: "3px",
                maxHeight: "220px",
                overflow: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}>
                {entry.experiencePreview}
              </div>
            )}
          </div>
        );

      case 'reasoning':
        return (
          <div key={entry.id} style={{
            margin: "6px 0",
            padding: "8px 10px",
            backgroundColor: "#f0f5ff",
            borderLeft: "3px solid #1890ff",
            borderRadius: "0 4px 4px 0",
          }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: "4px" }}>
              <span style={{ fontSize: "11px", color: "#999" }}>{time}</span>
              {entry.agentPrefix && (
                <Tag color="purple" style={{ marginLeft: "8px", fontSize: "10px" }}>{entry.agentPrefix.trim()}</Tag>
              )}
              <Tag color="blue" style={{ marginLeft: "8px", fontSize: "10px" }}>💭 Reasoning</Tag>
            </div>
            <div style={{ 
              fontSize: "12px", 
              lineHeight: "1.5",
              whiteSpace: "pre-wrap",
              color: "#333"
            }}>
              {entry.reasoning}
            </div>
          </div>
        );
      
      case 'tool_call':
        // Find the matching tool_result that comes after this tool_call
        const entryIndex = allLogs.indexOf(entry);
        const matchingResult = allLogs.slice(entryIndex + 1).find(
          log => log.type === 'tool_result' && log.toolName === entry.toolName
        );
        
        return (
          <div key={entry.id} style={{
            margin: "6px 0",
            padding: "8px 10px",
            backgroundColor: "#fff7e6",
            borderLeft: "3px solid #fa8c16",
            borderRadius: "0 4px 4px 0",
          }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: "4px", flexWrap: "wrap" }}>
              <span style={{ fontSize: "11px", color: "#999" }}>{time}</span>
              {entry.agentPrefix && (
                <Tag color="purple" style={{ marginLeft: "8px", fontSize: "10px" }}>{entry.agentPrefix.trim()}</Tag>
              )}
              <Tag color="orange" style={{ marginLeft: "8px", fontSize: "10px" }}>🔧 Tool</Tag>
              <Text strong style={{ marginLeft: "4px", fontSize: "12px" }}>
                {entry.agentName} → {entry.toolName}
              </Text>
              {matchingResult && (
                <Tag color="green" style={{ marginLeft: "8px", fontSize: "9px" }}>✓</Tag>
              )}
              {entry.toolId && (
                <Text type="secondary" style={{ marginLeft: "8px", fontSize: "9px", fontFamily: "monospace" }}>
                  ID: {entry.toolId}
                </Text>
              )}
            </div>
            <div style={{ 
              fontSize: "11px", 
              fontFamily: "monospace",
              backgroundColor: "#fffbe6",
              padding: "4px 6px",
              borderRadius: "3px",
              overflow: "auto",
              maxHeight: "80px"
            }}>
              {JSON.stringify(entry.toolParams, null, 2)}
            </div>
            {/* Show param source validation failures if any */}
            {entry.paramSourceValidation?.failures && entry.paramSourceValidation.failures.length > 0 && (
              <div style={{
                marginTop: "6px",
                padding: "6px 8px",
                backgroundColor: "#fff2f0",
                border: "1px solid #ffccc7",
                borderRadius: "4px",
              }}>
                <Tag color="error" style={{ fontSize: "9px", marginBottom: "4px" }}>⚠️ Param Source Validation Failed</Tag>
                {entry.paramSourceValidation.failures.map((failure: any, idx: number) => (
                  <div key={idx} style={{ fontSize: "10px", color: "#cf1322", marginTop: "2px" }}>
                    <strong>{failure.paramName}</strong>: Invalid tool_call ID "{failure.invalidToolCallId}"
                    <div style={{ fontSize: "9px", color: "#8c8c8c", marginLeft: "8px" }}>
                      Valid IDs: {failure.validToolCallIds?.slice(0, 3).join(", ") || "none"}
                      {failure.validToolCallIds?.length > 3 ? ` (+${failure.validToolCallIds.length - 3} more)` : ""}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {/* Show param sources if available */}
            {entry.paramSources && Object.keys(entry.paramSources).length > 0 && (
              <div style={{
                marginTop: "4px",
                fontSize: "10px",
                color: "#8c8c8c",
              }}>
                <details>
                  <summary style={{ cursor: "pointer" }}>📋 Param Sources</summary>
                  <div style={{
                    marginTop: "4px",
                    fontFamily: "monospace",
                    fontSize: "9px",
                    backgroundColor: "#fafafa",
                    padding: "4px",
                    borderRadius: "2px",
                    maxHeight: "60px",
                    overflow: "auto"
                  }}>
                    {Object.entries(entry.paramSources).map(([key, source]) => (
                      <div key={key}><strong>{key}</strong>: {String(source)}</div>
                    ))}
                  </div>
                </details>
              </div>
            )}
            {/* Show result inline if available */}
            {matchingResult && (
              <div style={{ marginTop: "6px", borderTop: "1px dashed #d9d9d9", paddingTop: "6px" }}>
                <details>
                  <summary style={{ cursor: "pointer", fontSize: "10px", color: "#8c8c8c" }}>
                    📄 Result: {matchingResult.toolResult?.substring(0, 60)}...
                  </summary>
                  <div style={{
                    marginTop: "4px",
                    fontFamily: "monospace",
                    fontSize: "10px",
                    backgroundColor: "#f6ffed",
                    border: "1px solid #b7eb8f",
                    padding: "6px",
                    borderRadius: "3px",
                    maxHeight: "200px",
                    overflow: "auto",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word"
                  }}>
                    {matchingResult.toolResult}
                  </div>
                </details>
                {matchingResult.pageStateChange && (
                  <div style={{
                    marginTop: "6px",
                    padding: "6px 8px",
                    backgroundColor: "#fffbe6",
                    border: "1px solid #ffe58f",
                    borderRadius: "4px",
                  }}>
                    <Tag color="orange" style={{ fontSize: "9px", marginBottom: "4px" }}>📍 Page State</Tag>
                    <div style={{ fontSize: "11px", fontWeight: 500, color: "#d46b08" }}>
                      {matchingResult.pageStateChange.type}
                    </div>
                    {matchingResult.pageStateChange.details && (
                      <div style={{ fontSize: "10px", color: "#8c8c8c", marginTop: "2px" }}>
                        {matchingResult.pageStateChange.details}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      
      case 'tool_result':
        // Skip rendering - tool_result is now shown inline with tool_call
        return null;
      
      case 'plan':
        return (
          <div key={entry.id} style={{
            margin: "8px 0",
            padding: "10px",
            backgroundColor: "#e6f7ff",
            border: "1px solid #91d5ff",
            borderRadius: "4px",
          }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: "8px" }}>
              <Tag color="cyan" style={{ fontSize: "10px" }}>📋 Plan</Tag>
              <Text type="secondary" style={{ fontSize: "10px", marginLeft: "auto" }}>
                {entry.planSteps?.length || 0} steps
              </Text>
            </div>
            {entry.planSteps && entry.planSteps.length > 0 ? (
              <div style={{ fontSize: "12px" }}>
                {entry.planSteps.map((step, idx) => (
                  <div key={idx} style={{
                    display: "flex",
                    alignItems: "center",
                    padding: "4px 0",
                    borderBottom: idx < entry.planSteps!.length - 1 ? "1px solid #e8e8e8" : "none",
                  }}>
                    <span style={{
                      width: "20px",
                      height: "20px",
                      borderRadius: "50%",
                      backgroundColor: step.status === 'completed' ? '#52c41a' : 
                                      step.status === 'in-progress' ? '#1890ff' : 
                                      step.status === 'failed' ? '#ff4d4f' : '#d9d9d9',
                      color: "white",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "10px",
                      marginRight: "8px",
                      flexShrink: 0,
                    }}>
                      {step.status === 'completed' ? '✓' : 
                       step.status === 'in-progress' ? '▶' : 
                       step.status === 'failed' ? '✗' : idx + 1}
                    </span>
                    <Text style={{ 
                      fontSize: "11px",
                      color: step.status === 'completed' ? '#52c41a' : 
                             step.status === 'in-progress' ? '#1890ff' : '#666'
                    }}>
                      {step.description.substring(0, 80)}{step.description.length > 80 ? '...' : ''}
                    </Text>
                  </div>
                ))}
              </div>
            ) : (
              <Text type="secondary" style={{ fontSize: "11px", fontStyle: "italic" }}>
                Plan parsing in progress...
              </Text>
            )}
          </div>
        );
      
      case 'plan_step':
        if (!entry.currentStep) return null;
        const completedCount = entry.planSteps?.filter(s => s.status === 'completed').length || 0;
        const totalSteps = entry.planSteps?.length || 0;
        return (
          <div key={entry.id} style={{
            margin: "4px 0",
            padding: "6px 10px",
            backgroundColor: "#f9f0ff",
            borderLeft: "3px solid #722ed1",
            borderRadius: "0 4px 4px 0",
          }}>
            <div style={{ display: "flex", alignItems: "center" }}>
              <Progress 
                percent={Math.round((completedCount / totalSteps) * 100)} 
                size="small" 
                style={{ width: "60px", marginRight: "8px" }}
                showInfo={false}
              />
              <Text style={{ fontSize: "11px" }}>
                Step {entry.currentStep.index + 1}/{totalSteps}: 
              </Text>
              <Text strong style={{ fontSize: "11px", marginLeft: "4px" }}>
                {entry.currentStep.description.substring(0, 50)}...
              </Text>
            </div>
          </div>
        );
      
      case 'snapshot':
        return (
          <div key={entry.id} style={{
            margin: "4px 0",
            padding: "4px 10px",
            backgroundColor: "#fff1f0",
            borderLeft: "3px solid #eb2f96",
            borderRadius: "0 4px 4px 0",
            fontSize: "11px",
          }}>
            <Tag color="magenta" style={{ fontSize: "9px" }}>
              {entry.snapshotType === 'dom' ? '📄' : '📸'} {entry.snapshotType?.toUpperCase()}
            </Tag>
            {entry.snapshotPath && (
              <Text code style={{ fontSize: "10px" }}>
                {entry.snapshotPath}
              </Text>
            )}
            {entry.snapshotUrl && (
              <a 
                href={entry.snapshotUrl} 
                target="_blank" 
                rel="noopener noreferrer"
                style={{ marginLeft: "8px", fontSize: "10px" }}
              >
                View
              </a>
            )}
          </div>
        );
      
      case 'token_usage':
        return (
          <div key={entry.id} style={{
            margin: "6px 0",
            padding: "8px 10px",
            backgroundColor: "#f5f5f5",
            border: "1px solid #d9d9d9",
            borderRadius: "4px",
            fontSize: "11px",
          }}>
            <Tag color="default" style={{ fontSize: "9px" }}>📊 Tokens</Tag>
            <Text style={{ marginLeft: "8px" }}>
              {entry.tokenUsage?.input.toLocaleString()} input + {entry.tokenUsage?.output.toLocaleString()} output = {entry.tokenUsage?.total.toLocaleString()} total
            </Text>
            <Text type="secondary" style={{ marginLeft: "8px" }}>
              ({entry.tokenUsage?.callCount} calls)
            </Text>
          </div>
        );
      
      case 'instruction':
        return (
          <div key={entry.id} style={{
            margin: "6px 0",
            padding: "8px 12px",
            backgroundColor: "#e6f7ff",
            border: "1px solid #91d5ff",
            borderRadius: "4px",
            fontSize: "12px",
          }}>
            <Tag color="blue" style={{ fontSize: "9px" }}>📖 Navigation Guide</Tag>
            <Text strong style={{ marginLeft: "8px", color: "#1890ff" }}>
              {entry.instruction?.displayName || entry.instruction?.domain}
            </Text>
            <Text type="secondary" style={{ marginLeft: "8px", fontSize: "11px" }}>
              ({Math.round((entry.instruction?.contentLength || 0) / 1024 * 10) / 10} KB)
            </Text>
            <br />
            <Text type="secondary" style={{ fontSize: "10px", marginTop: "4px", display: "block" }}>
              Matched domain: {entry.instruction?.domain}{entry.instruction?.version ? ` (${entry.instruction.version})` : ''}
            </Text>
          </div>
        );
      
      case 'status':
        return (
          <div key={entry.id} style={{
            margin: "4px 0",
            padding: "6px 10px",
            backgroundColor: entry.level === 'error' ? '#fff1f0' : 
                            entry.level === 'success' ? '#f6ffed' : '#fafafa',
            borderLeft: `3px solid ${entry.level === 'error' ? '#ff4d4f' : 
                                     entry.level === 'success' ? '#52c41a' : '#1890ff'}`,
            borderRadius: "0 4px 4px 0",
            fontSize: "12px",
          }}>
            <span style={{ color: "#999", fontSize: "11px" }}>{time}</span>
            <Text style={{ marginLeft: "8px", ...getLogStyle(entry.level) }}>
              {entry.message}
            </Text>
          </div>
        );
      
      case 'error':
        return (
          <div key={entry.id} style={{
            margin: "4px 0",
            padding: "6px 10px",
            backgroundColor: "#fff1f0",
            borderLeft: "3px solid #ff4d4f",
            borderRadius: "0 4px 4px 0",
          }}>
            <Tag color="red" style={{ fontSize: "9px" }}>❌ Error</Tag>
            <Text type="danger" style={{ fontSize: "12px" }}>
              {entry.message}
            </Text>
          </div>
        );
      
      case 'text_response':
        return (
          <div key={entry.id} style={{
            margin: "8px 0",
            padding: "12px 16px",
            backgroundColor: "#f6ffed",
            border: "1px solid #b7eb8f",
            borderRadius: "8px",
          }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: "10px" }}>
              <Tag color="green" style={{ fontSize: "10px" }}>📝 Response</Tag>
              <Text type="secondary" style={{ fontSize: "10px", marginLeft: "auto" }}>
                {time}
              </Text>
            </div>
            <div className="markdown-content" style={{
              fontSize: "13px",
              lineHeight: "1.6",
              color: "#333",
            }}>
              <ReactMarkdown 
                remarkPlugins={[remarkGfm]}
                components={{
                  h1: ({node, ...props}) => <h1 style={{fontSize: '18px', fontWeight: 'bold', margin: '16px 0 8px', borderBottom: '1px solid #e8e8e8', paddingBottom: '4px'}} {...props} />,
                  h2: ({node, ...props}) => <h2 style={{fontSize: '16px', fontWeight: 'bold', margin: '14px 0 6px', borderBottom: '1px solid #e8e8e8', paddingBottom: '4px'}} {...props} />,
                  h3: ({node, ...props}) => <h3 style={{fontSize: '14px', fontWeight: 'bold', margin: '12px 0 4px'}} {...props} />,
                  p: ({node, ...props}) => <p style={{margin: '8px 0'}} {...props} />,
                  ul: ({node, ...props}) => <ul style={{margin: '8px 0', paddingLeft: '20px'}} {...props} />,
                  ol: ({node, ...props}) => <ol style={{margin: '8px 0', paddingLeft: '20px'}} {...props} />,
                  li: ({node, ...props}) => <li style={{margin: '4px 0'}} {...props} />,
                  table: ({node, ...props}) => <table style={{borderCollapse: 'collapse', width: '100%', margin: '12px 0', fontSize: '12px'}} {...props} />,
                  th: ({node, ...props}) => <th style={{border: '1px solid #d9d9d9', padding: '8px 12px', backgroundColor: '#fafafa', fontWeight: 'bold', textAlign: 'left'}} {...props} />,
                  td: ({node, ...props}) => <td style={{border: '1px solid #d9d9d9', padding: '8px 12px'}} {...props} />,
                  hr: ({node, ...props}) => <hr style={{border: 'none', borderTop: '1px solid #e8e8e8', margin: '16px 0'}} {...props} />,
                  strong: ({node, ...props}) => <strong style={{fontWeight: 'bold'}} {...props} />,
                  code: ({node, inline, ...props}: any) => (
                    inline 
                      ? <code style={{backgroundColor: '#f5f5f5', padding: '2px 4px', borderRadius: '3px', fontSize: '12px'}} {...props} />
                      : <code style={{display: 'block', backgroundColor: '#f5f5f5', padding: '12px', borderRadius: '4px', fontSize: '12px', overflow: 'auto'}} {...props} />
                  ),
                  blockquote: ({node, ...props}) => <blockquote style={{borderLeft: '4px solid #1890ff', paddingLeft: '12px', margin: '8px 0', color: '#666'}} {...props} />,
                }}
              >
                {entry.textContent || ''}
              </ReactMarkdown>
            </div>
          </div>
        );
      
      default:
        return null;
    }
  };

  // Render the plan progress bar at the top
  const renderPlanProgress = () => {
    // Find the plan entry in structured logs to show raw plan if no steps parsed
    const planEntry = structuredLogs.find(log => log.type === 'plan');
    
    // If no plan steps and no plan entry, return nothing
    if (currentPlanSteps.length === 0 && !planEntry) return null;
    
    // If we have steps, show progress view
    if (currentPlanSteps.length > 0) {
      const completedCount = currentPlanSteps.filter(s => s.status === 'completed').length;
      const inProgressIndex = currentPlanSteps.findIndex(s => s.status === 'in-progress');
      const currentStep = inProgressIndex >= 0 ? currentPlanSteps[inProgressIndex] : null;
      
      return (
        <div style={{
          marginBottom: "12px",
          padding: "10px",
          backgroundColor: "#fafafa",
          border: "1px solid #e8e8e8",
          borderRadius: "6px",
        }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: "8px" }}>
            <Text strong style={{ fontSize: "12px" }}>📋 Plan Progress</Text>
            <Text type="secondary" style={{ marginLeft: "auto", fontSize: "11px" }}>
              {completedCount}/{currentPlanSteps.length} completed
            </Text>
            <Button 
              type="text" 
              size="small" 
              onClick={() => setExpandedPlan(!expandedPlan)}
              style={{ marginLeft: "8px", fontSize: "10px" }}
            >
              {expandedPlan ? '▲' : '▼'}
            </Button>
          </div>
          
          <Progress 
            percent={Math.round((completedCount / currentPlanSteps.length) * 100)}
            size="small"
            status={completedCount === currentPlanSteps.length ? "success" : "active"}
          />
          
          {currentStep && (
            <div style={{ marginTop: "8px", fontSize: "11px" }}>
              <Text type="secondary">Current: </Text>
              <Text strong style={{ color: "#1890ff" }}>
                Step {inProgressIndex + 1}: {currentStep.description.substring(0, 60)}...
              </Text>
            </div>
          )}
          
          {expandedPlan && (
            <div style={{ marginTop: "10px", borderTop: "1px solid #e8e8e8", paddingTop: "8px" }}>
              {currentPlanSteps.map((step, idx) => (
                <div key={idx} style={{
                  display: "flex",
                  alignItems: "flex-start",
                  padding: "4px 0",
                  opacity: step.status === 'completed' ? 0.7 : 1,
                }}>
                  <span style={{
                    width: "18px",
                    height: "18px",
                    borderRadius: "50%",
                    backgroundColor: step.status === 'completed' ? '#52c41a' : 
                                    step.status === 'in-progress' ? '#1890ff' : 
                                    step.status === 'failed' ? '#ff4d4f' : '#d9d9d9',
                    color: "white",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "9px",
                    marginRight: "8px",
                    marginTop: "2px",
                    flexShrink: 0,
                  }}>
                    {step.status === 'completed' ? '✓' : 
                     step.status === 'in-progress' ? '▶' : 
                     step.status === 'failed' ? '✗' : idx + 1}
                  </span>
                  <Text style={{ 
                    fontSize: "11px",
                    textDecoration: step.status === 'completed' ? 'line-through' : 'none',
                    color: step.status === 'completed' ? '#999' : 
                           step.status === 'in-progress' ? '#1890ff' : '#666'
                  }}>
                    {step.description}
                  </Text>
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }
    
    // Fallback: Show raw plan if we couldn't parse steps
    if (planEntry && planEntry.plan) {
      return (
        <div style={{
          marginBottom: "12px",
          padding: "10px",
          backgroundColor: "#e6f7ff",
          border: "1px solid #91d5ff",
          borderRadius: "6px",
        }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: "8px" }}>
            <Text strong style={{ fontSize: "12px" }}>📋 Plan</Text>
            <Button 
              type="text" 
              size="small" 
              onClick={() => setExpandedPlan(!expandedPlan)}
              style={{ marginLeft: "auto", fontSize: "10px" }}
            >
              {expandedPlan ? '▲' : '▼'}
            </Button>
          </div>
          {expandedPlan && (
            <pre style={{
              fontSize: "11px",
              fontFamily: "monospace",
              whiteSpace: "pre-wrap",
              margin: 0,
              maxHeight: "200px",
              overflow: "auto",
              backgroundColor: "#f0f5ff",
              padding: "8px",
              borderRadius: "4px",
            }}>
              {planEntry.plan}
            </pre>
          )}
        </div>
      );
    }
    
    return null;
  };

  return (
    <div
      style={{
        minHeight: "80px",
        padding: "8px",
        position: "relative",
      }}
    >
      {/* Header with Settings icon */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        marginBottom: "12px",
        paddingBottom: "8px",
        borderBottom: "1px solid #f0f0f0",
        position: "relative",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flex: 1 }}>
          <span style={{ fontSize: "32px" }}>🏄</span>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: "20px", fontWeight: 700, color: "#1a1a2e", letterSpacing: "-0.5px" }}>WebSAPE</div>
            <div style={{ fontSize: "11px", color: "#666", marginTop: "1px", fontStyle: "italic", letterSpacing: "0.2px" }}>the right link, at the right moment</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: "4px" }}>
          <Tooltip title="Settings">
            <Button
              size="small"
              type="text"
              icon={<span style={{ fontSize: "14px" }}>{showServerSettings ? '✕' : '⚙'}</span>}
              onClick={() => setShowServerSettings(!showServerSettings)}
              style={{ color: showServerSettings ? '#1890ff' : '#8c8c8c' }}
            />
          </Tooltip>
          <Tooltip title="Debug Options">
            <Button
              size="small"
              type="text"
              icon={<span style={{ fontSize: "14px" }}>{showDebugPanel ? '✕' : '🔧'}</span>}
              onClick={() => setShowDebugPanel(!showDebugPanel)}
              style={{ color: showDebugPanel ? '#1890ff' : '#8c8c8c' }}
            />
          </Tooltip>
        </div>
      </div>

      {/* Main content - always visible in standalone mode (no login required) */}
      <>
      {/* Human Interaction Panel - Shows when there's a pending interaction */}
      {/* Uses sticky positioning to stay visible while logs scroll */}
      {pendingInteraction && (
        <Card
          size="small"
          style={{
            position: "sticky",
            top: 0,
            zIndex: 1000,
            marginBottom: "12px",
            border: "2px solid #1890ff",
            backgroundColor: "#e6f7ff",
            boxShadow: "0 2px 8px rgba(0, 0, 0, 0.15)",
          }}
        >
          <div style={{ marginBottom: "8px" }}>
            {pendingInteraction.type === 'help' && pendingInteraction.helpType === 'request_login' && (
              <Text strong style={{ color: "#fa8c16", fontSize: "14px" }}>
                🔐 LOGIN REQUIRED
              </Text>
            )}
            {pendingInteraction.type === 'help' && pendingInteraction.helpType === 'request_assistance' && (
              <Text strong style={{ color: "#1890ff", fontSize: "14px" }}>
                🙋 ASSISTANCE NEEDED
              </Text>
            )}
            {pendingInteraction.type === 'confirm' && (
              <Text strong style={{ color: "#722ed1", fontSize: "14px" }}>
                ❓ CONFIRMATION REQUIRED
              </Text>
            )}
            {pendingInteraction.type === 'input' && (
              <Text strong style={{ color: "#13c2c2", fontSize: "14px" }}>
                ✏️ INPUT REQUIRED
              </Text>
            )}
            {pendingInteraction.type === 'select' && (
              <Text strong style={{ color: "#52c41a", fontSize: "14px" }}>
                📋 SELECTION REQUIRED
              </Text>
            )}
          </div>
          
          <div style={{ 
            marginBottom: "12px", 
            padding: "8px",
            backgroundColor: "white",
            borderRadius: "4px",
            whiteSpace: "pre-wrap",
            fontSize: "13px"
          }}>
            {pendingInteraction.prompt}
          </div>

          {/* Confirm/Help type - Yes/No buttons */}
          {(pendingInteraction.type === 'confirm' || pendingInteraction.type === 'help') && (
            <Space>
              <Button type="primary" onClick={handleConfirmYes}>
                {pendingInteraction.type === 'help' ? "Done ✓" : "Yes"}
              </Button>
              <Button onClick={handleConfirmNo}>
                {pendingInteraction.type === 'help' ? "Skip →" : "No"}
              </Button>
            </Space>
          )}

          {/* Input type - Text input with submit */}
          {pendingInteraction.type === 'input' && (
            <div>
              <Input
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onPressEnter={handleInputSubmit}
                placeholder="Enter your response..."
                style={{ marginBottom: "8px" }}
              />
              <Space>
                <Button type="primary" onClick={handleInputSubmit}>
                  Submit
                </Button>
                <Button onClick={handleInputCancel}>
                  Cancel
                </Button>
              </Space>
            </div>
          )}

          {/* Select type - Option buttons */}
          {pendingInteraction.type === 'select' && pendingInteraction.options && (
            <div>
              <div style={{ marginBottom: "8px" }}>
                {pendingInteraction.options.map((option, index) => (
                  <Button
                    key={index}
                    type={selectedOptions.includes(option) ? "primary" : "default"}
                    onClick={() => toggleOption(option)}
                    style={{ marginRight: "4px", marginBottom: "4px" }}
                    size="small"
                  >
                    {option}
                  </Button>
                ))}
              </div>
              <Space>
                <Button 
                  type="primary" 
                  onClick={handleSelectSubmit}
                  disabled={selectedOptions.length === 0}
                >
                  Confirm Selection
                </Button>
                <Button onClick={handleInputCancel}>
                  Cancel
                </Button>
              </Space>
            </div>
          )}
        </Card>
      )}

      {/* Settings Panel */}
      {showServerSettings && (
        <div style={{
          marginBottom: "12px",
          padding: "12px",
          backgroundColor: "#fff",
          borderRadius: "8px",
          border: "1px solid #e8e8e8",
        }}>

          {/* Model Config */}
          <div style={{ marginBottom: "14px" }}>
            <div style={{ fontSize: "13px", fontWeight: 600, color: "#333", marginBottom: "10px" }}>Model</div>
            <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
              <select 
                value={llmProvider} 
                onChange={(e) => {
                  const newProvider = e.target.value;
                  setLlmProvider(newProvider);
                  const newModel = '';
                  setLlmModel(newModel);
                  const newConfig = {
                    llm: newProvider,
                    apiKey: llmApiKey,
                    modelName: newModel,
                    apiType: llmApiType,
                    options: { baseURL: baseUrlFor(newProvider) }
                  };
                  chrome.storage.sync.set({ llmConfig: newConfig });
                }}
                style={{ flex: 1, fontSize: "12px", padding: "6px 8px", borderRadius: "6px", border: "1px solid #d9d9d9", backgroundColor: "#fff", cursor: "pointer" }}
              >
                {MODEL_LLMS.map(llm => (
                  <option key={llm.value} value={llm.value}>{llm.label}</option>
                ))}
              </select>
              <Input
                size="small"
                type="text"
                placeholder="Enter model name (e.g., claude-opus-4-7)"
                value={llmModel}
                onChange={(e) => {
                  setLlmModel(e.target.value);
                  const newConfig = {
                    llm: llmProvider,
                    apiKey: llmApiKey,
                    modelName: e.target.value,
                    apiType: llmApiType,
                    options: { baseURL: llmProvider === 'anthropic' ? anthropicEndpoint : openaiEndpoint }
                  };
                  chrome.storage.sync.set({ llmConfig: newConfig });
                }}
                style={{ borderRadius: "6px" }}
              />
            </div>
            <Input
              size="small"
              type="password"
              placeholder="API Key"
              value={llmApiKey}
              onChange={(e) => {
                setLlmApiKey(e.target.value);
                const newConfig = {
                  llm: llmProvider,
                  apiKey: e.target.value,
                  modelName: llmModel,
                  apiType: llmApiType,
                  options: { baseURL: llmProvider === 'anthropic' ? anthropicEndpoint : openaiEndpoint }
                };
                chrome.storage.sync.set({ llmConfig: newConfig });
              }}
              style={{ borderRadius: "6px" }}
            />
            <div style={{ marginTop: "8px" }}>
              <div style={{ fontSize: "10px", color: "#8c8c8c", marginBottom: "4px" }}>
                {llmProvider === 'anthropic' ? 'Claude Endpoint' : 'OpenAI Endpoint'}
              </div>
              <Input
                size="small"
                type="text"
                placeholder={llmProvider === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1'}
                value={llmProvider === 'anthropic' ? anthropicEndpoint : openaiEndpoint}
                onChange={(e) => {
                  const newEndpoint = e.target.value;
                  if (llmProvider === 'anthropic') {
                    setAnthropicEndpoint(newEndpoint);
                  } else {
                    setOpenaiEndpoint(newEndpoint);
                  }
                  const newConfig = {
                    llm: llmProvider,
                    apiKey: llmApiKey,
                    modelName: llmModel,
                    apiType: llmApiType,
                    options: { baseURL: newEndpoint }
                  };
                  chrome.storage.sync.set({ llmConfig: newConfig });
                }}
                style={{ borderRadius: "6px" }}
              />
            </div>
            <div style={{ marginTop: "8px" }}>
              <div style={{ fontSize: "10px", color: "#8c8c8c", marginBottom: "4px" }}>API Type</div>
              <select
                value={llmApiType}
                onChange={(e) => {
                  const newApiType = e.target.value as 'responses-api' | 'chat-completion';
                  setLlmApiType(newApiType);
                  const newConfig = {
                    llm: llmProvider,
                    apiKey: llmApiKey,
                    modelName: llmModel,
                    apiType: newApiType,
                    options: { baseURL: llmProvider === 'anthropic' ? anthropicEndpoint : openaiEndpoint }
                  };
                  chrome.storage.sync.set({ llmConfig: newConfig });
                }}
                style={{ width: "100%", fontSize: "12px", padding: "6px 8px", borderRadius: "6px", border: "1px solid #d9d9d9", backgroundColor: "#fff", cursor: "pointer" }}
              >
                <option value="responses-api">Responses API</option>
                <option value="chat-completion">Chat Completion</option>
              </select>
            </div>
          </div>

          {/* Enhancements */}
          <div style={{ marginBottom: "14px" }}>
            <div style={{ fontSize: "13px", fontWeight: 600, color: "#333", marginBottom: "10px" }}>Enhancements</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <Tooltip title="Enable site-specific guidance for better navigation accuracy">
                  <span style={{ fontSize: "12px", color: "#595959" }}>Instructions</span>
                </Tooltip>
                <select
                  value={selectedInstructionsVersion || '__none__'}
                  onChange={(e) => {
                    const version = e.target.value;
                    if (version === '__none__') {
                      setSelectedInstructionsVersion('');
                      setUseInstructions(false);
                      setInstructionsVersionTouched(true);
                      chrome.storage.sync.set({ instructionsVersion: '', useInstructions: false });
                    } else {
                      setSelectedInstructionsVersion(version);
                      setUseInstructions(true);
                      setInstructionsVersionTouched(true);
                      chrome.storage.sync.set({ instructionsVersion: version, useInstructions: true });
                    }
                  }}
                  style={{ fontSize: "11px", padding: "4px 6px", borderRadius: "4px", border: "1px solid #d9d9d9", maxWidth: "160px" }}
                >
                  <option value="__none__">None</option>
                  {INSTRUCTION_VERSIONS.map(v => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              </div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <Tooltip title="Learn from past interactions to improve task completion">
                  <span style={{ fontSize: "12px", color: "#595959" }}>Experience</span>
                </Tooltip>
                <select
                  value={selectedExperienceVersion || 'none'}
                  onChange={(e) => {
                    const version = e.target.value;
                    if (version === 'none') {
                      setSelectedExperienceVersion('none');
                      setUseExperience(false);
                      chrome.storage.sync.set({ useExperience: false, experienceVersion: 'none' });
                    } else {
                      setSelectedExperienceVersion(version);
                      setUseExperience(true);
                      chrome.storage.sync.set({ useExperience: true, experienceVersion: version });
                    }
                  }}
                  style={{ fontSize: "11px", padding: "4px 6px", borderRadius: "4px", border: "1px solid #d9d9d9", maxWidth: "160px" }}
                >
                  <option value="none">None</option>
                  {experienceVersions.map((f) => (
                    <option key={f.name} value={f.name}>{f.name}</option>
                  ))}
                </select>
              </div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <Tooltip title="Select a versioned set of generated tools/skills for the agent to use">
                  <span style={{ fontSize: "12px", color: "#595959" }}>Tools</span>
                </Tooltip>
                <select
                  value={selectedToolsVersion || '__none__'}
                  onChange={(e) => {
                    const version = e.target.value;
                    if (version === '__none__') {
                      setSelectedToolsVersion('');
                      setToolsVersionTouched(true);
                      chrome.storage.sync.set({ toolsVersion: '' });
                    } else {
                      setSelectedToolsVersion(version);
                      setToolsVersionTouched(true);
                      chrome.storage.sync.set({ toolsVersion: version });
                    }
                  }}
                  style={{ fontSize: "11px", padding: "4px 6px", borderRadius: "4px", border: "1px solid #d9d9d9", maxWidth: "160px" }}
                >
                  <option value="__none__">None</option>
                  {toolVersions.map(v => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <Divider style={{ margin: "12px 0 8px 0" }} />

          {/* Mode Settings */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <select
                title="Mode"
                value={mode}
                onChange={(e) => { const v = e.target.value as "fast" | "normal" | "expert"; setMode(v); chrome.storage.sync.set({ mode: v }); }}
                style={{ fontSize: "12px" }}
              >
                <option value="fast">fast</option>
                <option value="normal">normal</option>
                <option value="expert">expert</option>
              </select>
              <select
                title="Mark Image Mode"
                value={markImageMode}
                onChange={(e) => { const v = e.target.value as "dom" | "draw"; setMarkImageMode(v); chrome.storage.sync.set({ markImageMode: v }); }}
                style={{ fontSize: "12px" }}
              >
                <option value="dom">dom</option>
                <option value="draw">draw</option>
              </select>
              <select
                title="Tree Build Mode"
                value={treeBuildMode}
                onChange={(e) => { const v = e.target.value as "eko-native" | "a11y"; setTreeBuildMode(v); chrome.storage.sync.set({ treeBuildMode: v }); }}
                style={{ fontSize: "12px" }}
              >
                <option value="eko-native">eko native</option>
                <option value="a11y">a11y pseudo</option>
              </select>
              <Tooltip title="Max A11y Elements: Maximum number of accessibility tree elements to process. Select ∞ to disable the cap entirely (no auto-switch regardless of tree size).">
                <span style={{ display: "inline-flex", alignItems: "center", gap: "2px" }}>
                  <span style={{ fontSize: "10px", color: "#666" }}>Max:</span>
                  <select
                    title="Max A11y Elements"
                    value={maxA11yElements}
                    onChange={(e) => {
                      const value = parseInt(e.target.value);
                      setMaxA11yElements(value);
                      chrome.storage.sync.set({ maxA11yElements: value });
                    }}
                    style={{ fontSize: "11px", width: "55px", padding: "2px" }}
                  >
                    <option value={500}>500</option>
                    <option value={1000}>1000</option>
                    <option value={2000}>2000</option>
                    <option value={3000}>3000</option>
                    <option value={5000}>5000</option>
                    <option value={0}>∞</option>
                  </select>
                </span>
              </Tooltip>
              <Tooltip title="Viewport Expansion: Include interactive elements within this many pixels beyond the visible viewport (browser-use style). 'Off' = strict viewport only (eko default).">
                <span style={{ display: "inline-flex", alignItems: "center", gap: "2px" }}>
                  <span style={{ fontSize: "10px", color: "#666" }}>VP±:</span>
                  <select
                    title="Viewport Expansion"
                    value={viewportExpansion === null ? "null" : viewportExpansion}
                    onChange={(e) => {
                      const raw = e.target.value;
                      const value = raw === "null" ? null : parseInt(raw);
                      setViewportExpansionState(value);
                      chrome.storage.sync.set({ viewportExpansion: value });
                    }}
                    style={{ fontSize: "11px", width: "55px", padding: "2px" }}
                  >
                    <option value="null">Off</option>
                    <option value={500}>500</option>
                    <option value={1000}>1000</option>
                    <option value={2000}>2000</option>
                    <option value={5000}>5000</option>
                  </select>
                </span>
              </Tooltip>
            </div>
            <Tooltip title="Debug Mode: Store screenshots and DOM HTML for troubleshooting">
              <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                <span style={{ fontSize: "11px", color: "#666" }}>Debug</span>
                <Switch
                  size="small"
                  checked={debugModeEnabled}
                  onChange={(checked) => {
                    setDebugModeEnabled(checked);
                    chrome.storage.sync.set({ debugModeEnabled: checked });
                    logger.info("CONFIG_UPDATE", "Debug mode toggled", { enabled: checked });
                  }}
                />
              </span>
            </Tooltip>
            <Tooltip title="Log LLM Context: Print full messages and tools for each LLM call to console">
              <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                <span style={{ fontSize: "11px", color: "#666" }}>Log LLM</span>
                <Switch
                  size="small"
                  checked={logLLMContext}
                  onChange={(checked) => {
                    setLogLLMContext(checked);
                    chrome.storage.sync.set({ logLLMContext: checked });
                    logger.info("CONFIG_UPDATE", "Log LLM Context toggled", { enabled: checked });
                  }}
                />
              </span>
            </Tooltip>
            <Tooltip title="No Human: Disable human_interact tool so the agent never asks for user input/confirmation">
              <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                <span style={{ fontSize: "11px", color: "#666" }}>No Human</span>
                <Switch
                  size="small"
                  checked={disableHumanInteract}
                  onChange={(checked) => {
                    setDisableHumanInteract(checked);
                    chrome.storage.sync.set({ disableHumanInteract: checked });
                    logger.info("CONFIG_UPDATE", "Disable human_interact toggled", { enabled: checked });
                  }}
                />
              </span>
            </Tooltip>
            <Tooltip title="Dynamic Compress: Auto-detect context length per model instead of using static 80K token threshold">
              <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                <span style={{ fontSize: "11px", color: "#666" }}>Dynamic Ctx</span>
                <Switch
                  size="small"
                  checked={dynamicCompressThreshold}
                  onChange={(checked) => {
                    setDynamicCompressThreshold(checked);
                    chrome.storage.sync.set({ dynamicCompressThreshold: checked });
                    logger.info("CONFIG_UPDATE", "Dynamic compress threshold toggled", { enabled: checked });
                  }}
                />
              </span>
            </Tooltip>
            <Tooltip title="Label Style: 'noocclude' uses outlined text with smart positioning to avoid covering content; 'legacy' uses solid background labels at fixed positions">
              <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                <span style={{ fontSize: "11px", color: "#666" }}>NoOcclude</span>
                <Switch
                  size="small"
                  checked={labelStyle === 'noocclude'}
                  onChange={(checked) => {
                    const style = checked ? 'noocclude' : 'legacy';
                    setLabelStyleState(style);
                    chrome.storage.sync.set({ labelStyle: style });
                    logger.info("CONFIG_UPDATE", "Label style toggled", { labelStyle: style });
                  }}
                />
              </span>
            </Tooltip>
            <Tooltip title="Multi-probe isTopElement: when on, sample 9 points (center + corners + edges) instead of just the rect center, so elements partially occluded by sticky overlays (e.g. fixed message composers) still get indexed in the pseudo DOM.">
              <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                <span style={{ fontSize: "11px", color: "#666" }}>MultiProbe</span>
                <Switch
                  size="small"
                  checked={multiProbeIsTopElement}
                  onChange={(checked) => {
                    setMultiProbeIsTopElementState(checked);
                    chrome.storage.sync.set({ multiProbeIsTopElement: checked });
                    logger.info("CONFIG_UPDATE", "Multi-probe isTopElement toggled", { multiProbeIsTopElement: checked });
                  }}
                />
              </span>
            </Tooltip>
            <Tooltip title="Action-Landing Watchdog: when on, click/hover failures with 'covered by another element' first try scrollIntoView({block:'center'}) and re-check before erroring. Events are recorded as actionLandingEvents on each tool_result in progress.json (never seen by the LLM).">
              <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                <span style={{ fontSize: "11px", color: "#666" }}>ActionLanding</span>
                <Switch
                  size="small"
                  checked={actionLandingWatchdog}
                  onChange={(checked) => {
                    setActionLandingWatchdogState(checked);
                    chrome.storage.sync.set({ actionLandingWatchdog: checked });
                    logger.info("CONFIG_UPDATE", "Action-landing watchdog toggled", { actionLandingWatchdog: checked });
                  }}
                />
              </span>
            </Tooltip>
          </div>
          {/* Help improve */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: "10px", borderTop: "1px solid #f0f0f0" }}>
            <Tooltip title="Share non-PII logs to help improve the experience">
              <span style={{ fontSize: "12px", color: "#8c8c8c" }}>Help us improve</span>
            </Tooltip>
            <Switch size="small" checked={debugModeEnabled} onChange={(checked) => { setDebugModeEnabled(checked); chrome.storage.sync.set({ debugModeEnabled: checked }); }} />
          </div>
        </div>
      )}

      {/* Debug Panel */}
      {showDebugPanel && (
        <div style={{
          marginBottom: "12px",
          padding: "12px",
          backgroundColor: "#fff",
          borderRadius: "8px",
          border: "1px solid #e8e8e8",
        }}>
          <div style={{ fontSize: "13px", fontWeight: 600, color: "#333", marginBottom: "10px" }}>Agent Options</div>
          
          {/* Agent Mode Dropdowns */}
          <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: "10px", color: "#8c8c8c", marginBottom: "4px" }}>Speed</div>
              <select value={mode} onChange={(e) => { const v = e.target.value as any; setMode(v); chrome.storage.sync.set({ mode: v }); }} style={{ width: "100%", fontSize: "12px", padding: "6px 8px", borderRadius: "6px", border: "1px solid #d9d9d9", backgroundColor: "#fff", cursor: "pointer" }}>
                <option value="fast">Fast</option>
                <option value="normal">Normal</option>
                <option value="expert">Expert</option>
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: "10px", color: "#8c8c8c", marginBottom: "4px" }}>Marker</div>
              <select value={markImageMode} onChange={(e) => { const v = e.target.value as any; setMarkImageMode(v); chrome.storage.sync.set({ markImageMode: v }); }} style={{ width: "100%", fontSize: "12px", padding: "6px 8px", borderRadius: "6px", border: "1px solid #d9d9d9", backgroundColor: "#fff", cursor: "pointer" }}>
                <option value="dom">DOM</option>
                <option value="draw">Draw</option>
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: "10px", color: "#8c8c8c", marginBottom: "4px" }}>Tree</div>
              <select value={treeBuildMode} onChange={(e) => { const v = e.target.value as any; setTreeBuildMode(v); chrome.storage.sync.set({ treeBuildMode: v }); }} style={{ width: "100%", fontSize: "12px", padding: "6px 8px", borderRadius: "6px", border: "1px solid #d9d9d9", backgroundColor: "#fff", cursor: "pointer" }}>
                <option value="eko-native">Eko</option>
                <option value="a11y">A11y</option>
              </select>
            </div>
          </div>

          {/* Log LLM Toggle */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
            <Tooltip title="Print full messages and tools for each LLM call to console">
              <span style={{ fontSize: "12px", color: "#595959" }}>Log LLM Context</span>
            </Tooltip>
            <Switch size="small" checked={logLLMContext} onChange={(checked) => { setLogLLMContext(checked); chrome.storage.sync.set({ logLLMContext: checked }); }} />
          </div>

          {/* Export and History buttons */}
          <div style={{ display: "flex", gap: "8px" }}>
            <Dropdown overlay={exportMenu} trigger={['click']}>
              <Button size="small" style={{ flex: 1, borderRadius: "6px" }}>
                Export Logs
              </Button>
            </Dropdown>
            <Button
              size="small"
              style={{ flex: 1, borderRadius: "6px" }}
              onClick={() => {
                setShowSessionHistory(!showSessionHistory);
                if (!showSessionHistory) loadSessionHistory();
              }}
            >
              {showSessionHistory ? 'Hide' : 'Show'} History
            </Button>
          </div>
        </div>
      )}

      {/* Quick Trial */}
      <div style={{ marginBottom: "8px" }}>
        <div style={{ marginBottom: "6px" }}>
          <span style={{ fontSize: "13px", fontWeight: 600, color: "#333" }}>Prompt:</span>
        </div>
        <div style={{ textAlign: "center" }}>
          <Input.TextArea
            ref={textAreaRef}
            rows={4}
            value={prompt}
            disabled={running}
            placeholder="Your workflow"
            onChange={(e) => setPrompt(e.target.value)}
          />

          <Button
            type="primary"
            onClick={handleClick}
            style={{
              marginTop: "8px",
              background: running ? "#6666" : "#1677ff",
            }}
          >
            {running ? "Running..." : "Run"}
          </Button>
        </div>
      </div>

      {(logs.length > 0 || structuredLogs.length > 0) && (
        <div
          style={{
            marginTop: "16px",
            textAlign: "left",
            border: "1px solid #d9d9d9",
            borderRadius: "4px",
            padding: "8px",
            overflowY: "auto",
            backgroundColor: "#f5f5f5",
          }}
        >
          {/* Log header */}
          <div style={{ 
            display: "flex", 
            justifyContent: "space-between", 
            alignItems: "center",
            marginBottom: "8px",
            paddingBottom: "6px",
            borderBottom: "1px solid #e8e8e8"
          }}>
            <span style={{ fontWeight: "bold" }}>Logs:</span>
          </div>
          
          {/* Plan Progress */}
          {renderPlanProgress()}
          
          {/* Structured Log View */}
          <div>
            {structuredLogs
              .filter(entry => entry.type !== 'plan' && entry.type !== 'tool_result') // Plan shown separately, tool_result shown inline with tool_call
              .map(entry => renderStructuredLogEntry(entry, structuredLogs))}
            {streamLog && (
              <div style={{
                margin: "4px 0",
                padding: "6px 10px",
                backgroundColor: "#fafafa",
                borderLeft: "3px solid #1890ff",
                borderRadius: "0 4px 4px 0",
                fontSize: "12px",
                fontStyle: "italic",
                color: "#666"
              }}>
                {streamLog.log}
              </div>
            )}
          </div>
        </div>
      )}
      
      {/* Session History */}
      {showSessionHistory && (
        <div style={{
          marginTop: "16px",
          border: "1px solid #d9d9d9",
          borderRadius: "4px",
          padding: "8px",
          backgroundColor: "#fafafa",
          maxHeight: "300px",
          overflowY: "auto"
        }}>
          <div style={{ fontWeight: "bold", marginBottom: "8px" }}>
            Session History ({sessions.length} sessions)
          </div>
          {sessions.length === 0 ? (
            <Text type="secondary">No sessions available</Text>
          ) : (
            sessions.map((session) => (
              <div key={session.sessionId} style={{
                border: "1px solid #e8e8e8",
                borderRadius: "4px",
                padding: "6px",
                marginBottom: "6px",
                backgroundColor: "white",
                fontSize: "12px"
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <Text strong style={{ color: getStatusColor(session.status) }}>
                      {session.status.toUpperCase()}
                    </Text>
                    <Text type="secondary" style={{ marginLeft: "8px" }}>
                      {new Date(session.startTime).toLocaleString()}
                    </Text>
                  </div>
                  <Button
                    size="small"
                    type="link"
                    style={{ padding: "0 4px", fontSize: "10px" }}
                    onClick={() => handleExportSession(session.sessionId)}
                  >
                    Export
                  </Button>
                </div>
                <div style={{ marginTop: "4px" }}>
                  <Text ellipsis style={{ fontSize: "11px", color: "#666" }}>
                    "{session.prompt.length > 50 ? session.prompt.substring(0, 50) + "..." : session.prompt}"
                  </Text>
                </div>
                <div style={{ marginTop: "2px", fontSize: "10px", color: "#999" }}>
                  Duration: {formatDuration(session.startTime, session.endTime)} |
                  Logs: {session.logs?.length || 0}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {running && (
        <div>
          <Button
            type="default"
            onClick={handleClick}
            style={{
              marginTop: "4px",
            }}
          >
            Stop
          </Button>
        </div>
      )}

      {/* Snapshot Link (shown at bottom after execution when debug mode was on) */}
      {lastSnapshotUrl && !running && (
        <div style={{
          marginTop: "10px",
          padding: "10px 14px",
          backgroundColor: "#e6f7ff",
          border: "1px solid #91d5ff",
          borderRadius: "6px",
          display: "flex",
          alignItems: "center",
          gap: "8px",
        }}>
          <span style={{ fontSize: "14px" }}>📸</span>
          <span style={{ fontSize: "12px", color: "#333" }}>Snapshot uploaded: </span>
          <a
            href={lastSnapshotUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: "12px", color: "#1890ff", textDecoration: "underline", wordBreak: "break-all" }}
          >
            View query snapshot
          </a>
        </div>
      )}

      </>
    </div>
  );
};

const root = createRoot(document.getElementById("root")!);

root.render(
  <React.StrictMode>
    <AppRun />
  </React.StrictMode>
);
