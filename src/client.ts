import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "./config.js";

/**
 * Creates an Anthropic client that works in proxy environments.
 * Detects HTTP_PROXY/HTTPS_PROXY and configures node-fetch + https-proxy-agent accordingly.
 * Falls back to default SDK behavior when no proxy is present.
 */
export async function createAnthropicClient(): Promise<Anthropic> {
  const config = getConfig();
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;

  if (proxyUrl) {
    try {
      // Dynamic imports — these are optional deps, only needed behind a proxy
      const { HttpsProxyAgent } = await import("https-proxy-agent");
      const nodeFetch = await import("node-fetch");
      const agent = new HttpsProxyAgent(proxyUrl);

      return new Anthropic({
        apiKey: config.anthropicApiKey,
        fetch: ((url: any, init: any) =>
          nodeFetch.default(url, { ...init, agent })) as unknown as typeof globalThis.fetch,
      });
    } catch {
      // If proxy deps aren't installed, fall back to default
      console.warn("[beercan] Proxy detected but proxy deps not installed. Trying direct connection.");
    }
  }

  return new Anthropic({ apiKey: config.anthropicApiKey });
}
