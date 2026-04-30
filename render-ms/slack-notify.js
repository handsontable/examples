import { CommandError } from "@codesandbox/sdk";

/** Official CodeSandbox status/incidents page for clients when upstream misbehaves. */
export const CODESANDBOX_STATUS_URL = "https://status.codesandbox.io/";

/**
 * Upstream returned HTML (or another non-JSON body) where JSON was expected — usually
 * outage, gateway, or WAF pages. Not actionable as an app bug; do not notify Slack.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isCodesandboxUnavailableError(error) {
  if (!error) return false;
  const msg = String(error?.message ?? error);
  if (error instanceof SyntaxError) {
    if (/not valid JSON/i.test(msg) && /<!DOCTYPE|<html/i.test(msg)) return true;
    if (/Unexpected token/i.test(msg) && /<!DOCTYPE|<html/i.test(msg)) return true;
  }
  return false;
}

/**
 * Errors that are expected client/configuration issues — do not spam Slack.
 * @param {unknown} error
 * @returns {boolean}
 */
export function shouldNotifySlack(error) {
  if (isCodesandboxUnavailableError(error)) {
    return false;
  }
  if (error instanceof CommandError) {
    return false;
  }
  const msg = String(error?.message ?? error);
  if (/command failed with exit code/i.test(msg)) {
    return false;
  }
  if (/failed to fork sandbox/i.test(msg)) {
    return false;
  }
  if (/sandbox not found/i.test(msg)) {
    return false;
  }
  return true;
}
