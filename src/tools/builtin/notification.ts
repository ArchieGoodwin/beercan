import type { ToolDefinition } from "../../schemas.js";
import type { ToolHandler } from "../registry.js";

// ── Send Notification ───────────────────────────────────────
// Desktop notification via macOS osascript. Falls back to console on other platforms.

export const sendNotificationDefinition: ToolDefinition = {
  name: "send_notification",
  description:
    "Send a desktop notification to the user. Use when an important task completes, needs attention, or when you have a summary ready for the user.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Notification title" },
      message: { type: "string", description: "Notification body text" },
    },
    required: ["title", "message"],
  },
};

export const sendNotificationHandler: ToolHandler = async (input) => {
  const title = sanitize(input.title as string);
  const message = sanitize(input.message as string);

  if (process.platform === "darwin") {
    const { execSync } = await import("child_process");
    try {
      execSync(
        `osascript -e 'display notification "${message}" with title "${title}"'`,
        { timeout: 5000 },
      );
      return "Notification sent";
    } catch {
      return `Notification fallback (console): [${title}] ${message}`;
    }
  }

  // Non-macOS fallback
  console.log(`[NOTIFICATION] ${title}: ${message}`);
  return `Notification logged: [${title}] ${message}`;
};

/** Sanitize string for safe use in osascript */
function sanitize(s: string): string {
  return s.replace(/[\\"]/g, " ").replace(/\n/g, " ").slice(0, 200);
}
