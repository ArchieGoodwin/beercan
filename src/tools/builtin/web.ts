import type { ToolDefinition } from "../../schemas.js";
import type { ToolHandler } from "../registry.js";

// ── Web Fetch ───────────────────────────────────────────────
// Fetches web page content. Uses Cloudflare Browser Rendering API
// if CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID are set,
// otherwise falls back to native fetch.

export const webFetchDefinition: ToolDefinition = {
  name: "web_fetch",
  description:
    "Fetch the text content of a web page. Returns clean text/markdown content. Handles JavaScript-rendered pages when Cloudflare Browser Rendering is configured. Good for reading documentation, articles, API responses.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch" },
      headers: {
        type: "object",
        description: "Optional HTTP headers to include",
      },
      max_length: {
        type: "number",
        description: "Maximum response length in characters (default 50000)",
      },
    },
    required: ["url"],
  },
};

export const webFetchHandler: ToolHandler = async (input) => {
  const url = input.url as string;
  const maxLength = (input.max_length as number) ?? 50000;
  const customHeaders = (input.headers as Record<string, string>) ?? {};

  // Try Cloudflare Browser Rendering first (handles JS-rendered pages)
  const cfToken = process.env.CLOUDFLARE_API_TOKEN;
  const cfAccount = process.env.CLOUDFLARE_ACCOUNT_ID;

  if (cfToken && cfAccount) {
    try {
      return await fetchViaCloudflare(url, cfAccount, cfToken, maxLength);
    } catch (err: any) {
      // Fall back to native fetch on CF error
    }
  }

  // Native fetch fallback
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "BeerCan-Agent/1.0",
        ...customHeaders,
      },
      signal: controller.signal,
      redirect: "follow",
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const text = await response.text();
    if (text.length > maxLength) {
      return text.slice(0, maxLength) + `\n\n--- Truncated at ${maxLength} characters ---`;
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
};

/**
 * Fetch page content via Cloudflare Browser Rendering /crawl API.
 * Two-step: POST starts async crawl job, GET retrieves results.
 * Returns HTML content from the rendered page.
 */
async function fetchViaCloudflare(
  url: string,
  accountId: string,
  apiToken: string,
  maxLength: number,
): Promise<string> {
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/crawl`;
  const headers = {
    "Authorization": `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  };

  // Step 1: Start crawl job
  const startResponse = await fetch(baseUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ url }),
  });

  if (!startResponse.ok) {
    const errBody = await startResponse.text();
    throw new Error(`Cloudflare crawl start failed (${startResponse.status}): ${errBody}`);
  }

  const startData = await startResponse.json() as any;
  if (!startData.success || !startData.result) {
    throw new Error(`Cloudflare crawl start error: ${JSON.stringify(startData.errors)}`);
  }

  const jobId = startData.result;

  // Step 2: Poll for results (max 30s, check every 2s)
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));

    const pollResponse = await fetch(`${baseUrl}/${jobId}`, { headers });
    if (!pollResponse.ok) continue;

    const pollData = await pollResponse.json() as any;
    if (!pollData.success) continue;

    const status = pollData.result?.status;
    if (status === "completed") {
      // Extract HTML from first completed record
      const records = pollData.result?.records ?? [];
      const record = records.find((r: any) => r.status === "completed" && r.html);
      if (record) {
        // Strip HTML tags for cleaner text output
        const text = stripHtml(record.html);
        const title = record.metadata?.title ? `# ${record.metadata.title}\n\n` : "";
        const content = title + text;
        if (content.length > maxLength) {
          return content.slice(0, maxLength) + `\n\n--- Truncated at ${maxLength} characters ---`;
        }
        return content;
      }
      throw new Error("Cloudflare crawl completed but no content in response");
    }

    if (status === "failed") {
      throw new Error("Cloudflare crawl job failed");
    }
    // status is "pending" or "running" — keep polling
  }

  throw new Error("Cloudflare crawl timed out after 30s");
}

/** Simple HTML tag stripper — extracts text content */
function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// ── HTTP Request ────────────────────────────────────────────
// Full HTTP request with method, headers, body control.

export const httpRequestDefinition: ToolDefinition = {
  name: "http_request",
  description:
    "Make an HTTP request with full control over method, headers, and body. Returns status code, response headers, and body. Use for API integrations, webhooks, form submissions.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Request URL" },
      method: {
        type: "string",
        enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
        description: "HTTP method (default GET)",
      },
      headers: { type: "object", description: "HTTP headers" },
      body: { type: "string", description: "Request body (for POST/PUT/PATCH)" },
      timeout_ms: { type: "number", description: "Timeout in milliseconds (default 30000)" },
    },
    required: ["url"],
  },
};

export const httpRequestHandler: ToolHandler = async (input) => {
  const url = input.url as string;
  const method = (input.method as string) ?? "GET";
  const headers = (input.headers as Record<string, string>) ?? {};
  const body = input.body as string | undefined;
  const timeoutMs = (input.timeout_ms as number) ?? 30000;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method,
      headers: {
        "User-Agent": "BeerCan-Agent/1.0",
        ...headers,
      },
      body: body ?? undefined,
      signal: controller.signal,
      redirect: "follow",
    });

    const responseBody = await response.text();
    const truncatedBody = responseBody.length > 100_000
      ? responseBody.slice(0, 100_000) + "\n--- Truncated ---"
      : responseBody;

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => { responseHeaders[key] = value; });

    return `STATUS: ${response.status} ${response.statusText}\nHEADERS: ${JSON.stringify(responseHeaders)}\nBODY:\n${truncatedBody}`;
  } finally {
    clearTimeout(timeout);
  }
};
