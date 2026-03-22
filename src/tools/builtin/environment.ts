import type { ToolDefinition } from "../../schemas.js";
import type { ToolHandler } from "../registry.js";
import { hostname, platform, arch, release, cpus, totalmem, freemem, userInfo, networkInterfaces, uptime } from "os";

// ── Environment Tools ────────────────────────────────────────
// Give agents awareness of their runtime environment: time, location, system info.

// ── Get Current DateTime ─────────────────────────────────────

export const getDateTimeDefinition: ToolDefinition = {
  name: "get_datetime",
  description:
    "Get the current date, time, timezone, and locale information. Use this whenever you need to know what time or day it is, calculate relative dates (tomorrow, next week), or format dates for the user's timezone.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

export const getDateTimeHandler: ToolHandler = async () => {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offsetMin = now.getTimezoneOffset();
  const offsetSign = offsetMin <= 0 ? "+" : "-";
  const offsetH = String(Math.floor(Math.abs(offsetMin) / 60)).padStart(2, "0");
  const offsetM = String(Math.abs(offsetMin) % 60).padStart(2, "0");
  const utcOffset = `UTC${offsetSign}${offsetH}:${offsetM}`;

  const locale = Intl.DateTimeFormat().resolvedOptions().locale;

  return JSON.stringify({
    iso: now.toISOString(),
    local: now.toLocaleString(),
    date: now.toLocaleDateString("en-CA"), // YYYY-MM-DD
    time: now.toLocaleTimeString("en-GB"), // HH:MM:SS
    dayOfWeek: now.toLocaleDateString("en-US", { weekday: "long" }),
    timezone: tz,
    utcOffset,
    locale,
    unix: Math.floor(now.getTime() / 1000),
  }, null, 2);
};

// ── Get System Info ──────────────────────────────────────────

export const getSystemInfoDefinition: ToolDefinition = {
  name: "get_system_info",
  description:
    "Get information about the system this agent is running on: OS, architecture, hostname, CPU, memory, uptime. Useful for understanding the execution environment and capabilities.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

export const getSystemInfoHandler: ToolHandler = async () => {
  const user = userInfo();
  const cpuList = cpus();

  return JSON.stringify({
    hostname: hostname(),
    platform: platform(),
    os: `${platform()} ${release()}`,
    arch: arch(),
    cpus: cpuList.length,
    cpuModel: cpuList[0]?.model ?? "unknown",
    totalMemoryGB: +(totalmem() / (1024 ** 3)).toFixed(1),
    freeMemoryGB: +(freemem() / (1024 ** 3)).toFixed(1),
    uptimeHours: +(uptime() / 3600).toFixed(1),
    user: user.username,
    homeDir: user.homedir,
    shell: user.shell || process.env.SHELL || "unknown",
    nodeVersion: process.version,
    pid: process.pid,
  }, null, 2);
};

// ── Get Network Info ─────────────────────────────────────────

export const getNetworkInfoDefinition: ToolDefinition = {
  name: "get_network_info",
  description:
    "Get network interface information: local IP addresses, interface names. Also attempts to detect the public IP via an external service.",
  inputSchema: {
    type: "object",
    properties: {
      include_public_ip: {
        type: "boolean",
        description: "Attempt to detect public IP via external service (default true)",
      },
    },
    required: [],
  },
};

export const getNetworkInfoHandler: ToolHandler = async (input) => {
  const includePublic = input.include_public_ip !== false;

  // Local interfaces
  const ifaces = networkInterfaces();
  const localAddresses: { interface: string; address: string; family: string; internal: boolean }[] = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      localAddresses.push({
        interface: name,
        address: addr.address,
        family: addr.family,
        internal: addr.internal,
      });
    }
  }

  // Primary local IP (first non-internal IPv4)
  const primaryIP = localAddresses.find(a => a.family === "IPv4" && !a.internal)?.address ?? "unknown";

  const result: Record<string, unknown> = {
    primaryLocalIP: primaryIP,
    interfaces: localAddresses,
  };

  // Public IP detection
  if (includePublic) {
    try {
      const resp = await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(5000) });
      const data = await resp.json() as { ip: string };
      result.publicIP = data.ip;
    } catch {
      result.publicIP = "unavailable (network error or timeout)";
    }
  }

  return JSON.stringify(result, null, 2);
};

// ── Get Environment Variables ────────────────────────────────

export const getEnvInfoDefinition: ToolDefinition = {
  name: "get_env_info",
  description:
    "Get relevant environment information: working directory, PATH, key environment variables. Sensitive values (API keys, tokens, secrets) are redacted for safety.",
  inputSchema: {
    type: "object",
    properties: {
      keys: {
        type: "array",
        items: { type: "string" },
        description: "Specific env var names to check (optional — returns a curated set by default)",
      },
    },
    required: [],
  },
};

const SENSITIVE_PATTERNS = /key|token|secret|password|passphrase|credential/i;

export const getEnvInfoHandler: ToolHandler = async (input) => {
  const keys = input.keys as string[] | undefined;

  const result: Record<string, unknown> = {
    cwd: process.cwd(),
    lang: process.env.LANG || process.env.LANGUAGE || "unknown",
    term: process.env.TERM || "unknown",
    editor: process.env.EDITOR || process.env.VISUAL || "unknown",
  };

  if (keys && keys.length > 0) {
    const requested: Record<string, string> = {};
    for (const key of keys) {
      const val = process.env[key];
      if (val === undefined) {
        requested[key] = "(not set)";
      } else if (SENSITIVE_PATTERNS.test(key)) {
        requested[key] = "(set, redacted)";
      } else {
        requested[key] = val;
      }
    }
    result.requested = requested;
  }

  // Curated non-sensitive vars
  const curated: Record<string, string> = {};
  const safeKeys = ["HOME", "USER", "SHELL", "LANG", "TZ", "NODE_ENV", "BEERCAN_DATA_DIR", "BEERCAN_DEFAULT_MODEL", "BEERCAN_LOG_LEVEL"];
  for (const key of safeKeys) {
    if (process.env[key]) curated[key] = process.env[key]!;
  }
  result.environment = curated;

  return JSON.stringify(result, null, 2);
};
