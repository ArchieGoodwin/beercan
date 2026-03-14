import { describe, it, expect } from "vitest";
import { webFetchHandler, httpRequestHandler } from "../src/tools/builtin/web.js";
import { sendNotificationHandler } from "../src/tools/builtin/notification.js";

describe("web_fetch tool", () => {
  it("fetches a URL and returns text", async () => {
    const result = await webFetchHandler({ url: "https://example.com" });
    expect(result).toContain("Example Domain");
  });

  it("respects max_length truncation", async () => {
    const result = await webFetchHandler({ url: "https://example.com", max_length: 100 });
    expect(result.length).toBeLessThanOrEqual(200); // 100 + truncation message
    expect(result).toContain("Truncated");
  });

  it("throws on invalid URL", async () => {
    await expect(webFetchHandler({ url: "https://nonexistent.invalid.domain.example" })).rejects.toThrow();
  });
});

describe("http_request tool", () => {
  it("makes a GET request and returns status + body", async () => {
    const result = await httpRequestHandler({ url: "https://httpbin.org/get" });
    expect(result).toContain("STATUS: 200");
    expect(result).toContain("BODY:");
  });

  it("makes a POST request with body", async () => {
    const result = await httpRequestHandler({
      url: "https://httpbin.org/post",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ test: true }),
    });
    expect(result).toContain("STATUS: 200");
    expect(result).toContain("test");
  });

  it("returns error status for 404", async () => {
    const result = await httpRequestHandler({ url: "https://httpbin.org/status/404" });
    expect(result).toContain("STATUS: 404");
  });
});

describe("send_notification tool", () => {
  it("sends a notification without crashing", async () => {
    const result = await sendNotificationHandler({
      title: "Test",
      message: "Unit test notification",
    });
    // Should either send or log
    expect(result).toContain("Notification");
  });

  it("sanitizes special characters", async () => {
    const result = await sendNotificationHandler({
      title: 'Test "quotes" & \'apostrophes\'',
      message: "Line 1\nLine 2",
    });
    expect(result).toContain("Notification");
  });
});
