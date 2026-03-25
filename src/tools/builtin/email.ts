import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { ToolDefinition } from "../../schemas.js";
import type { ToolHandler } from "../registry.js";

// ── Send Email via Resend API ──────────────────────────────────
// Uses native fetch — no extra dependencies.
// Requires RESEND_API_KEY and RESEND_FROM_EMAIL env vars.

const RESEND_API_URL = "https://api.resend.com/emails";

export const sendEmailDefinition: ToolDefinition = {
  name: "send_email",
  description:
    "Send an email via Resend API. Supports HTML and plain text content, file attachments, CC, BCC, and reply-to. Use for notifications, reports, alerts, or any email delivery. Requires RESEND_API_KEY and RESEND_FROM_EMAIL env vars.",
  inputSchema: {
    type: "object",
    properties: {
      to: {
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
        ],
        description: "Recipient email address(es). Single string or array of strings.",
      },
      subject: {
        type: "string",
        description: "Email subject line",
      },
      html: {
        type: "string",
        description: "HTML email body. Takes priority over 'text' if both provided.",
      },
      text: {
        type: "string",
        description: "Plain text email body. Used as fallback if no HTML provided.",
      },
      from: {
        type: "string",
        description:
          "Override sender. Format: 'Name <email>' or just 'email'. Defaults to RESEND_FROM_EMAIL.",
      },
      cc: {
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
        ],
        description: "CC recipient(s)",
      },
      bcc: {
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
        ],
        description: "BCC recipient(s)",
      },
      reply_to: {
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
        ],
        description: "Reply-to address(es)",
      },
      attachments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute file path to attach",
            },
            filename: {
              type: "string",
              description: "Override filename (defaults to basename of path)",
            },
          },
          required: ["path"],
        },
        description: "File attachments. Each needs a 'path' (absolute) and optional 'filename'.",
      },
    },
    required: ["to", "subject"],
  },
};

export const sendEmailHandler: ToolHandler = async (input) => {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL;

  if (!apiKey) {
    return [
      "Resend is not configured.",
      "",
      "Set these environment variables in ~/.beercan/.env:",
      "  RESEND_API_KEY=re_xxxxxxxx",
      "  RESEND_FROM_EMAIL=you@yourdomain.com",
      "",
      "Get your API key at https://resend.com/api-keys",
    ].join("\n");
  }

  const from = (input.from as string) || fromEmail;
  if (!from) {
    return "ERROR: No sender address. Set RESEND_FROM_EMAIL or pass 'from' parameter.";
  }

  const html = input.html as string | undefined;
  const text = input.text as string | undefined;
  if (!html && !text) {
    return "ERROR: Provide either 'html' or 'text' for the email body.";
  }

  // Normalize recipients to arrays
  const to = input.to;
  const toArray = Array.isArray(to) ? to : [to as string];

  // Build payload
  const payload: Record<string, unknown> = {
    from,
    to: toArray,
    subject: input.subject as string,
  };

  if (html) payload.html = html;
  if (text) payload.text = text;

  const cc = input.cc;
  if (cc) payload.cc = Array.isArray(cc) ? cc : [cc as string];

  const bcc = input.bcc;
  if (bcc) payload.bcc = Array.isArray(bcc) ? bcc : [bcc as string];

  const replyTo = input.reply_to;
  if (replyTo) payload.reply_to = Array.isArray(replyTo) ? replyTo : [replyTo as string];

  // Process file attachments
  const attachments = input.attachments as Array<{ path: string; filename?: string }> | undefined;
  if (attachments && attachments.length > 0) {
    const processed: Array<{ filename: string; content: string }> = [];
    for (const att of attachments) {
      try {
        const fileBuffer = readFileSync(att.path);
        const content = fileBuffer.toString("base64");
        const filename = att.filename || basename(att.path);
        processed.push({ filename, content });
      } catch (err: any) {
        return `ERROR: Cannot read attachment "${att.path}": ${err.message}`;
      }
    }
    payload.attachments = processed;
  }

  // Send via Resend API
  try {
    const response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();
    let result: any;
    try {
      result = JSON.parse(responseText);
    } catch {
      result = { raw: responseText };
    }

    if (!response.ok) {
      const errorMsg = result.message || result.error || responseText;
      return `ERROR: Resend API returned ${response.status}: ${errorMsg}`;
    }

    const recipientList = toArray.join(", ");
    const attCount = attachments?.length ? ` with ${attachments.length} attachment(s)` : "";
    return `Email sent to ${recipientList}${attCount}. ID: ${result.id}`;
  } catch (err: any) {
    return `ERROR: Failed to send email: ${err.message}`;
  }
};
