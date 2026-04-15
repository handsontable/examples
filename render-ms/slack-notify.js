import { CommandError } from "@codesandbox/sdk";

/**
 * Errors that are expected client/configuration issues — do not spam Slack.
 * @param {unknown} error
 * @returns {boolean}
 */
export function shouldNotifySlack(error) {
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
