/**
 * Send an iMessage via AppleScript (Messages.app automation).
 *
 * The recipient and text are passed as argv items to the `on run argv` handler so
 * the message body is never interpolated into the script source — no escaping bugs,
 * no script injection. First send triggers a macOS Automation permission prompt.
 */

import { execFile } from 'child_process';

const SEND_SCRIPT = `on run argv
  set targetBuddy to item 1 of argv
  set targetText to item 2 of argv
  tell application "Messages"
    set theService to 1st account whose service type = iMessage
    set theBuddy to participant targetBuddy of theService
    send targetText to theBuddy
  end tell
end run`;

export function sendMessage(to: string, text: string): Promise<{ sent: boolean; to: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      'osascript',
      ['-e', SEND_SCRIPT, to, text],
      { timeout: 15000 },
      (err, _stdout, stderr) => {
        if (err) {
          reject(new Error((stderr && stderr.trim()) || err.message));
          return;
        }
        resolve({ sent: true, to });
      },
    );
  });
}
