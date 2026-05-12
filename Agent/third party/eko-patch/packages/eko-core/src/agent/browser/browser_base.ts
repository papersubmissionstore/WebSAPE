import {
  LanguageModelV2Prompt,
  LanguageModelV2ToolCallPart,
} from "@ai-sdk/provider";
import { Agent } from "../base";
import { sleep } from "../../common/utils";
import { AgentContext } from "../../core/context";
import { ToolExecuter, ToolResult, IMcpClient } from "../../types";
import * as utils from "./utils";

export const AGENT_NAME = "Browser";

export default abstract class BaseBrowserAgent extends Agent {
  protected abstract screenshot(agentContext: AgentContext): Promise<{
    imageBase64: string;
    imageType: "image/jpeg" | "image/png";
  }>;

  protected abstract navigate_to(
    agentContext: AgentContext,
    url: string
  ): Promise<{
    url: string;
    title?: string;
    tabId?: number;
    /**
     * HTTP status code of the main-frame navigation response, when the
     * underlying browser binding can observe it (e.g. chrome.webRequest in the
     * extension build, Playwright Response.status() in nodejs). Undefined when
     * unobservable.
     */
    responseStatus?: number;
    /**
     * Network-level error string from the main-frame navigation, when one
     * occurred (e.g. "net::ERR_CONNECTION_REFUSED"). Undefined on success.
     */
    responseError?: string;
  }>;

  protected abstract get_all_tabs(agentContext: AgentContext): Promise<
    Array<{
      tabId: number;
      url: string;
      title: string;
    }>
  >;

  protected abstract switch_tab(
    agentContext: AgentContext,
    tabId: number
  ): Promise<{
    tabId: number;
    url: string;
    title: string;
  }>;

  protected async go_back(agentContext: AgentContext): Promise<void> {
    try {
      // Get current URL before navigation to detect if navigation completes
      let originalUrl: string | undefined;
      try {
        const currentPage = await this.get_current_page(agentContext);
        originalUrl = currentPage.url;
      } catch {
        // Ignore errors getting current page
      }

      // Execute the back navigation
      await this.execute_script(
        agentContext,
        () => {
          if ((window as any).navigation?.canGoBack) {
            (window as any).navigation.back();
          } else if (window.history.length > 1) {
            window.history.back();
          }
        },
        []
      );
      
      // Wait for navigation with timeout - if a dialog blocks navigation, we timeout and continue
      // We don't auto-dismiss dialogs here to let the user handle them if needed
      const navigationTimeout = 3000; // 3 seconds
      const startTime = Date.now();
      
      while (originalUrl && Date.now() - startTime < navigationTimeout) {
        await sleep(100);
        try {
          const currentPage = await this.get_current_page(agentContext);
          if (currentPage.url !== originalUrl) {
            break; // Navigation completed
          }
        } catch {
          // Tab might be navigating or closed, consider it completed
          break;
        }
      }
      
      await sleep(100);
    } catch (e) {}
  }

  protected async extract_page_content(
    agentContext: AgentContext,
    variable_name?: string
  ): Promise<{
    title: string;
    page_url: string;
    page_content: string;
  }> {
    let content = await this.execute_script(
      agentContext,
      utils.extract_page_content,
      []
    );
    let pageInfo = await this.get_current_page(agentContext);
    let result = `title: ${pageInfo.title}\npage_url: ${pageInfo.url}\npage_content: \n${content}`;
    if (variable_name) {
      agentContext.context.variables.set(variable_name, result);
    }
    return {
      title: pageInfo.title || "",
      page_url: pageInfo.url,
      page_content: content,
    };
  }

  protected async controlMcpTools(
    agentContext: AgentContext,
    messages: LanguageModelV2Prompt,
    loopNum: number
  ): Promise<{ mcpTools: boolean; mcpParams?: Record<string, unknown> }> {
    if (loopNum > 0) {
      let url = null;
      try {
        url = (await this.get_current_page(agentContext)).url;
      } catch (e) {}
      let lastUrl = agentContext.variables.get("lastUrl");
      agentContext.variables.set("lastUrl", url);
      return {
        mcpTools: loopNum == 0 || url != lastUrl,
        mcpParams: {
          environment: "browser",
          browser_url: url,
        },
      };
    } else {
      return {
        mcpTools: true,
        mcpParams: {
          environment: "browser",
        },
      };
    }
  }

  protected toolExecuter(mcpClient: IMcpClient, name: string): ToolExecuter {
    return {
      execute: async (args, agentContext): Promise<ToolResult> => {
        let result = await mcpClient.callTool({
          name: name,
          arguments: args,
          extInfo: {
            taskId: agentContext.context.taskId,
            nodeId: agentContext.agentChain.agent.id,
            environment: "browser",
            agent_name: agentContext.agent.Name,
            browser_url: agentContext.variables.get("lastUrl"),
          },
        }, agentContext.context.controller.signal);
        if (
          result.extInfo &&
          result.extInfo["javascript"] &&
          result.content?.length > 0 &&
          result.content[0].type == "text"
        ) {
          let script = result.content[0].text;
          let params = JSON.stringify(args);
          let runScript = `${script};execute(${params})`;
          let scriptResult = await this.execute_mcp_script(
            agentContext,
            runScript
          );
          let resultText;
          if (
            typeof scriptResult == "string" ||
            typeof scriptResult == "number"
          ) {
            resultText = scriptResult + "";
          } else {
            resultText = scriptResult
              ? JSON.stringify(scriptResult)
              : "Successful";
          }
          return {
            content: [
              {
                type: "text",
                text: resultText,
              },
            ],
          };
        }
        return result;
      },
    };
  }

  protected async get_current_page(agentContext: AgentContext): Promise<{
    url: string;
    title?: string;
    tabId?: number;
  }> {
    return await this.execute_script(
      agentContext,
      () => {
        return {
          url: (window as any).location.href,
          title: (window as any).document.title,
        };
      },
      []
    );
  }

  protected lastToolResult(messages: LanguageModelV2Prompt): {
    id: string;
    toolName: string;
    args: unknown;
    result: unknown;
  } | null {
    let lastMessage = messages[messages.length - 1];
    if (lastMessage.role != "tool") {
      return null;
    }
    let toolResult = lastMessage.content.filter(
      (t) => t.type == "tool-result"
    )[0];
    if (!toolResult) {
      return null;
    }
    let result = (toolResult as any).output?.value ?? (toolResult as any).result;
    for (let i = messages.length - 2; i > 0; i--) {
      if (
        messages[i].role !== "assistant" ||
        typeof messages[i].content == "string"
      ) {
        continue;
      }
      for (let j = 0; j < messages[i].content.length; j++) {
        let content = messages[i].content[j];
        if (typeof content !== "string" && content.type !== "tool-call") {
          continue;
        }
        let toolUse = content as LanguageModelV2ToolCallPart;
        if (toolResult.toolCallId != toolUse.toolCallId) {
          continue;
        }
        return {
          id: toolResult.toolCallId,
          toolName: toolUse.toolName,
          args: toolUse.input,
          result,
        };
      }
    }
    return null;
  }

  protected toolUseNames(messages?: LanguageModelV2Prompt): string[] {
    let toolNames: string[] = [];
    if (!messages) {
      return toolNames;
    }
    for (let i = 0; i < messages.length; i++) {
      let message = messages[i];
      if (message.role == "tool") {
        toolNames.push(message.content[0].toolName);
      }
    }
    return toolNames;
  }

  protected abstract execute_script(
    agentContext: AgentContext,
    func: (...args: any[]) => void,
    args: any[]
  ): Promise<any>;

  /**
   * Get a CDP session for the current page.
   * Returns null if CDP is not available (e.g., in web extension context).
   * Subclasses that support CDP (like nodejs with Playwright) should override this.
   */
  protected async getCDPSession(
    agentContext: AgentContext
  ): Promise<{ send: (method: string, params?: any) => Promise<any>; detach: () => Promise<void> } | null> {
    return null;
  }

  protected async execute_mcp_script(
    agentContext: AgentContext,
    script: string
  ): Promise<string | number | Record<string, any> | undefined> {
    return;
  }
}
export { BaseBrowserAgent };
