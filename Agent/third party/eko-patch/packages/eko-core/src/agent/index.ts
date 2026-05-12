import { Agent, AgentParams } from "./base";
import BaseFileAgent from "./file";
import BaseShellAgent from "./shell";
import BaseComputerAgent from "./computer";
import {
  BaseBrowserAgent,
  BaseBrowserLabelsAgent,
  BaseBrowserScreenAgent,
  type BrowserSelector,
  setLabelStyle,
  getLabelStyle,
  type LabelStyle,
} from "./browser";

export {
  Agent,
  BaseFileAgent,
  BaseShellAgent,
  BaseComputerAgent,
  BaseBrowserAgent,
  BaseBrowserLabelsAgent,
  BaseBrowserScreenAgent,
  type AgentParams,
  type BrowserSelector,
  setLabelStyle,
  getLabelStyle,
  type LabelStyle,
};
