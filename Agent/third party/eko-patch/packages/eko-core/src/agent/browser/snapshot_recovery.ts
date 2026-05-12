/**
 * Helper for capturing the post-tool snapshot consumed by handleMessages.
 *
 * Snapshot capture (screenshot + pseudo-DOM) can throw "Frame with ID 0 is
 * showing error page" when the active tab is on a chrome-error://chromewebdata/
 * frame (e.g. after a failed navigate_to). Without isolation this exception
 * propagates handleMessages -> base.run -> doRunWorkflow and aborts the entire
 * workflow as `execute error`.
 *
 * `tryCaptureSnapshotForHistory` runs the supplied capture and returns either
 * the snapshot or a recovery user-message describing the failure so the agent
 * can issue a corrective action (go_back / new navigate_to) on the next ReAct
 * step.
 */

import { LanguageModelV2Prompt } from "@ai-sdk/provider";

export interface SnapshotResult {
  imageBase64?: string;
  imageType?: "image/jpeg" | "image/png";
  pseudoHtml?: string;
  client_rect?: any;
  double_screenshots?: { imageBase64: string; imageType: "image/jpeg" | "image/png" };
}

export type SnapshotOrRecovery =
  | { ok: true; result: SnapshotResult }
  | { ok: false; recoveryMessage: LanguageModelV2Prompt[number] };

export async function tryCaptureSnapshotForHistory(
  capture: () => Promise<SnapshotResult>
): Promise<SnapshotOrRecovery> {
  try {
    const result = await capture();
    return { ok: true, result };
  } catch (e: any) {
    const errMsg = e?.message || String(e);
    console.warn("[handleMessages] screenshot_and_html failed:", errMsg);
    return {
      ok: false,
      recoveryMessage: {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `Failed to capture page snapshot: ${errMsg}\n\n` +
              `The current page is likely in an unrecoverable state ` +
              `(e.g. a Chrome error page from a failed navigation). ` +
              `Do not assume any DOM is available. Recover by calling ` +
              `go_back or navigate_to with a different URL.`,
          },
        ],
      },
    };
  }
}
