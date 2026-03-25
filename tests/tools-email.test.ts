import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendEmailDefinition, sendEmailHandler } from "../src/tools/builtin/email.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("send_email tool definition", () => {
  it("has correct name and required params", () => {
    expect(sendEmailDefinition.name).toBe("send_email");
    expect(sendEmailDefinition.inputSchema.required).toEqual(["to", "subject"]);
  });

  it("has all expected properties in schema", () => {
    const props = Object.keys(sendEmailDefinition.inputSchema.properties as Record<string, unknown>);
    expect(props).toContain("to");
    expect(props).toContain("subject");
    expect(props).toContain("html");
    expect(props).toContain("text");
    expect(props).toContain("from");
    expect(props).toContain("cc");
    expect(props).toContain("bcc");
    expect(props).toContain("reply_to");
    expect(props).toContain("attachments");
  });
});

describe("send_email handler", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.RESEND_FROM_EMAIL = "test@example.com";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("returns config instructions when RESEND_API_KEY is missing", async () => {
    delete process.env.RESEND_API_KEY;
    const result = await sendEmailHandler({ to: "a@b.com", subject: "Test" });
    expect(result).toContain("Resend is not configured");
    expect(result).toContain("RESEND_API_KEY");
  });

  it("returns error when no sender address", async () => {
    delete process.env.RESEND_FROM_EMAIL;
    const result = await sendEmailHandler({ to: "a@b.com", subject: "Test" });
    expect(result).toContain("No sender address");
  });

  it("returns error when no body provided", async () => {
    const result = await sendEmailHandler({ to: "a@b.com", subject: "Test" });
    expect(result).toContain("Provide either");
  });

  it("sends email via Resend API", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ id: "test-email-id" })),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendEmailHandler({
      to: "recipient@example.com",
      subject: "Test Subject",
      html: "<p>Hello</p>",
    });

    expect(result).toContain("Email sent to recipient@example.com");
    expect(result).toContain("test-email-id");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer re_test_key");

    const body = JSON.parse(opts.body);
    expect(body.from).toBe("test@example.com");
    expect(body.to).toEqual(["recipient@example.com"]);
    expect(body.subject).toBe("Test Subject");
    expect(body.html).toBe("<p>Hello</p>");
  });

  it("supports multiple recipients", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ id: "multi-id" })),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendEmailHandler({
      to: ["a@b.com", "c@d.com"],
      subject: "Multi",
      text: "Hello all",
    });

    expect(result).toContain("a@b.com, c@d.com");
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.to).toEqual(["a@b.com", "c@d.com"]);
    expect(body.text).toBe("Hello all");
  });

  it("supports cc, bcc, reply_to", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ id: "cc-id" })),
    });
    vi.stubGlobal("fetch", mockFetch);

    await sendEmailHandler({
      to: "a@b.com",
      subject: "CC test",
      html: "<p>Hi</p>",
      cc: "cc@b.com",
      bcc: ["bcc1@b.com", "bcc2@b.com"],
      reply_to: "reply@b.com",
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.cc).toEqual(["cc@b.com"]);
    expect(body.bcc).toEqual(["bcc1@b.com", "bcc2@b.com"]);
    expect(body.reply_to).toEqual(["reply@b.com"]);
  });

  it("supports from override", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ id: "from-id" })),
    });
    vi.stubGlobal("fetch", mockFetch);

    await sendEmailHandler({
      to: "a@b.com",
      subject: "From test",
      html: "<p>Hi</p>",
      from: "Custom <custom@example.com>",
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.from).toBe("Custom <custom@example.com>");
  });

  it("handles file attachments", async () => {
    // Create a temp file to attach
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, "test-attachment.txt");
    fs.writeFileSync(tmpFile, "attachment content");

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ id: "att-id" })),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendEmailHandler({
      to: "a@b.com",
      subject: "Attachment test",
      html: "<p>See attached</p>",
      attachments: [{ path: tmpFile }],
    });

    expect(result).toContain("1 attachment(s)");
    expect(result).toContain("att-id");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0].filename).toBe("test-attachment.txt");
    expect(body.attachments[0].content).toBe(Buffer.from("attachment content").toString("base64"));

    // Cleanup
    fs.unlinkSync(tmpFile);
  });

  it("returns error for missing attachment file", async () => {
    const result = await sendEmailHandler({
      to: "a@b.com",
      subject: "Bad attachment",
      html: "<p>Hi</p>",
      attachments: [{ path: "/nonexistent/file.pdf" }],
    });

    expect(result).toContain("ERROR: Cannot read attachment");
  });

  it("handles API error response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: () => Promise.resolve(JSON.stringify({ message: "Invalid email" })),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendEmailHandler({
      to: "bad",
      subject: "Error test",
      html: "<p>Hi</p>",
    });

    expect(result).toContain("ERROR: Resend API returned 422");
    expect(result).toContain("Invalid email");
  });

  it("handles network failure", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network timeout"));
    vi.stubGlobal("fetch", mockFetch);

    const result = await sendEmailHandler({
      to: "a@b.com",
      subject: "Timeout test",
      html: "<p>Hi</p>",
    });

    expect(result).toContain("ERROR: Failed to send email: Network timeout");
  });
});
