/**
 * Navigation retry / failure-classification helpers.
 *
 * Extracted from browser_labels.ts so the navigate_to tool body stays focused on
 * orchestration. This module owns:
 *   - classifying a navigation outcome as success / retriable / fatal based on
 *     the response status code and chrome.webRequest-style net error string,
 *   - retry policy (max attempts, backoff schedule, retriable error sets),
 *   - a small driver (`navigateWithRetry`) that runs the actual navigate +
 *     post-load wait and re-attempts on transient failures only.
 *
 * Non-retriable on purpose:
 *   - 4xx (other than 408/425/429): the URL is wrong, retrying just resurfaces
 *     the same chrome-error tab.
 *   - net::ERR_CONNECTION_REFUSED, net::ERR_NAME_NOT_RESOLVED,
 *     net::ERR_ABORTED, net::ERR_BLOCKED_BY_CLIENT, etc.: deterministic for the
 *     given URL/host, retrying spawns extra error tabs without changing the
 *     outcome.
 *
 * Retriable:
 *   - HTTP 408, 425, 429, 5xx
 *   - net::ERR_TIMED_OUT, ERR_CONNECTION_RESET, ERR_CONNECTION_CLOSED,
 *     ERR_NETWORK_CHANGED, ERR_EMPTY_RESPONSE, ERR_TUNNEL_CONNECTION_FAILED,
 *     ERR_SOCKET_NOT_CONNECTED.
 */

import { sleep } from "../../common/utils";

export interface NavigationOutcome {
  url: string;
  title?: string;
  tabId?: number;
  responseStatus?: number;
  responseError?: string;
}

export const RETRIABLE_NET_ERRORS: ReadonlySet<string> = new Set([
  "net::ERR_TIMED_OUT",
  "net::ERR_CONNECTION_RESET",
  "net::ERR_CONNECTION_CLOSED",
  "net::ERR_NETWORK_CHANGED",
  "net::ERR_EMPTY_RESPONSE",
  "net::ERR_TUNNEL_CONNECTION_FAILED",
  "net::ERR_SOCKET_NOT_CONNECTED",
]);

/** Default retry schedule: up to 3 attempts total, 500ms then 1500ms backoff. */
export const DEFAULT_NAV_MAX_ATTEMPTS = 3;
export const DEFAULT_NAV_BACKOFF_MS: ReadonlyArray<number> = [500, 1500];

/** A navigation outcome is "failed" iff the binding observed a status >= 400 or a net error. */
export function isNavigationFailure(outcome: NavigationOutcome): boolean {
  if (outcome.responseError) return true;
  if (typeof outcome.responseStatus === "number" && outcome.responseStatus >= 400) return true;
  return false;
}

/** Whether a failed navigation outcome is worth retrying. */
export function isRetriableNavigationFailure(outcome: NavigationOutcome): boolean {
  if (outcome.responseError && RETRIABLE_NET_ERRORS.has(outcome.responseError)) return true;
  const s = outcome.responseStatus;
  if (typeof s === "number") {
    if (s === 408 || s === 425 || s === 429) return true;
    if (s >= 500 && s <= 599) return true;
  }
  return false;
}

/** Human-readable reason for log/warning messages. */
export function describeNavigationFailure(outcome: NavigationOutcome): string {
  if (outcome.responseError) return `network error ${outcome.responseError}`;
  if (typeof outcome.responseStatus === "number") return `HTTP ${outcome.responseStatus}`;
  return "unknown error";
}

export interface NavigateWithRetryOptions {
  maxAttempts?: number;
  backoffMs?: ReadonlyArray<number>;
  /** Logger callback for retry attempts. Defaults to console.warn. */
  onRetry?: (attempt: number, maxAttempts: number, reason: string, delayMs: number) => void;
}

export interface NavigateWithRetryResult {
  outcome: NavigationOutcome;
  attempts: number;
}

/**
 * Drive a navigate-then-wait sequence with bounded retry on transient failures.
 *
 * @param navigate    Performs the actual navigation (binding-specific) and returns
 *                    the observed status / error.
 * @param waitForLoad Awaited after each navigate to let the page settle before we
 *                    classify the outcome. Should not throw on error pages.
 */
export async function navigateWithRetry(
  navigate: () => Promise<NavigationOutcome>,
  waitForLoad: () => Promise<void>,
  options: NavigateWithRetryOptions = {}
): Promise<NavigateWithRetryResult> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_NAV_MAX_ATTEMPTS;
  const backoff = options.backoffMs ?? DEFAULT_NAV_BACKOFF_MS;
  const onRetry =
    options.onRetry ??
    ((attempt, max, reason, delayMs) =>
      console.warn(
        `[navigate_to] Transient failure (attempt ${attempt}/${max}): ${reason}. Retrying in ${delayMs}ms...`
      ));

  let attempts = 0;
  let outcome: NavigationOutcome;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempts++;
    outcome = await navigate();
    await waitForLoad();
    if (!isNavigationFailure(outcome)) break;
    if (attempts >= maxAttempts) break;
    if (!isRetriableNavigationFailure(outcome)) break;
    const delayMs = backoff[attempts - 1] ?? backoff[backoff.length - 1] ?? 0;
    onRetry(attempts, maxAttempts, describeNavigationFailure(outcome), delayMs);
    await sleep(delayMs);
  }
  return { outcome, attempts };
}
