// ── LLM Provider Factory ─────────────────────────────────────
// Creates the appropriate LLMProvider based on config.

import { getConfig } from "../config.js";
import type { LLMProvider } from "./types.js";
import { AnthropicProvider } from "./anthropic.js";

export async function createLLMProvider(): Promise<LLMProvider> {
  const config = getConfig();
  const provider = config.llmProvider;

  switch (provider) {
    case "anthropic": {
      if (!config.anthropicApiKey) {
        throw new Error("ANTHROPIC_API_KEY is not set. Run `beercan setup` to configure.");
      }
      const client = await createAnthropicClient(config.anthropicApiKey);
      return new AnthropicProvider(client);
    }

    case "openai": {
      const apiKey = config.openaiApiKey;
      if (!apiKey) {
        throw new Error("OPENAI_API_KEY is not set. Set the env var or use a different provider.");
      }
      const { OpenAIProvider } = await import("./openai.js");
      return new OpenAIProvider({ apiKey });
    }

    case "openai-compatible": {
      const apiKey = config.llmApiKey || config.openaiApiKey || "not-needed";
      const baseURL = config.llmBaseUrl;
      if (!baseURL) {
        throw new Error(
          "BEERCAN_LLM_BASE_URL is required for openai-compatible provider. " +
          "Set it to your LM Studio/Ollama/OpenRouter endpoint (e.g., http://localhost:1234/v1)."
        );
      }
      const { OpenAIProvider } = await import("./openai.js");
      return new OpenAIProvider({ apiKey, baseURL, name: "openai-compatible" });
    }

    default:
      throw new Error(`Unknown LLM provider: ${provider}. Use: anthropic, openai, openai-compatible`);
  }
}

/** Create Anthropic SDK client with proxy support */
async function createAnthropicClient(apiKey: string): Promise<any> {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;

  if (proxyUrl) {
    try {
      const { HttpsProxyAgent } = await import("https-proxy-agent");
      const nodeFetch = await import("node-fetch");
      const agent = new HttpsProxyAgent(proxyUrl);
      return new Anthropic({
        apiKey,
        fetch: ((url: any, init: any) =>
          nodeFetch.default(url, { ...init, agent })) as unknown as typeof globalThis.fetch,
      });
    } catch {
      console.warn("[beercan] Proxy detected but proxy deps not installed. Trying direct connection.");
    }
  }

  return new Anthropic({ apiKey });
}
