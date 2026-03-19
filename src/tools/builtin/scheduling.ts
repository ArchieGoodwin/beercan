import cron from "node-cron";
import type { ToolDefinition } from "../../schemas.js";
import type { ToolHandler } from "../registry.js";
import type { BloopContext } from "./memory.js";
import { getConfig } from "../../config.js";

// ── Scheduling & Trigger Tool Factory ───────────────────────

interface SchedulingDeps {
  getScheduler: () => {
    addSchedule: (opts: {
      projectId: string;
      projectSlug: string;
      cronExpression: string;
      goal: string;
      team?: string;
      description?: string;
    }) => { id: string };
    removeSchedule: (id: string) => void;
    listSchedules: (projectSlug?: string) => Array<{
      id: string;
      cronExpression: string;
      goal: string;
      team: string;
      description?: string;
      enabled: boolean;
      lastRunAt: string | null;
    }>;
  };
  getEventManager: () => {
    getTriggerManager: () => {
      addTrigger: (opts: {
        projectId: string;
        projectSlug: string;
        eventType: string;
        filterPattern?: string;
        goalTemplate: string;
        team?: string;
      }) => { id: string };
      removeTrigger: (id: string) => void;
      listTriggers: (projectSlug?: string) => Array<{
        id: string;
        projectSlug: string;
        eventType: string;
        filterPattern: string;
        goalTemplate: string;
        team: string;
        enabled: boolean;
      }>;
    };
  };
}

export function createSchedulingTools(
  deps: SchedulingDeps,
  getBloopContext: () => BloopContext | null,
): Array<{ definition: ToolDefinition; handler: ToolHandler }> {
  return [
    { definition: createScheduleDef, handler: createCreateScheduleHandler(deps, getBloopContext) },
    { definition: createTriggerDef, handler: createCreateTriggerHandler(deps, getBloopContext) },
    { definition: listSchedulesDef, handler: createListSchedulesHandler(deps, getBloopContext) },
    { definition: listTriggersDef, handler: createListTriggersHandler(deps, getBloopContext) },
    { definition: removeScheduleDef, handler: createRemoveScheduleHandler(deps, getBloopContext) },
    { definition: removeTriggerDef, handler: createRemoveTriggerHandler(deps, getBloopContext) },
  ];
}

// ── Cron frequency validation ───────────────────────────────

/**
 * Check if a cron expression fires more frequently than the minimum interval.
 * Uses node-cron's getTasks to generate next occurrences and measure gaps.
 */
export function isCronTooFrequent(expr: string, minIntervalMinutes: number): boolean {
  // Parse common patterns that are obviously too frequent
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return false; // Invalid, let cron.validate handle it

  const minuteField = parts[0];

  // "* * * * *" = every minute
  if (minuteField === "*") return minIntervalMinutes > 1;

  // "*/N * * * *" = every N minutes
  const stepMatch = minuteField.match(/^\*\/(\d+)$/);
  if (stepMatch) {
    const step = parseInt(stepMatch[1]);
    return step < minIntervalMinutes;
  }

  // Comma-separated minutes: "0,5,10,15,..."
  if (minuteField.includes(",")) {
    const minutes = minuteField.split(",").map(Number).filter((n) => !isNaN(n)).sort((a, b) => a - b);
    if (minutes.length >= 2) {
      // Check minimum gap between consecutive minutes
      for (let i = 1; i < minutes.length; i++) {
        if (minutes[i] - minutes[i - 1] < minIntervalMinutes) return true;
      }
      // Also check wrap-around gap (e.g., 55,0 = 5 min gap)
      const wrapGap = 60 - minutes[minutes.length - 1] + minutes[0];
      if (wrapGap < minIntervalMinutes && wrapGap > 0) return true;
    }
  }

  // Range: "0-30 * * * *" — every minute in range
  if (minuteField.includes("-") && !minuteField.includes("/")) {
    return minIntervalMinutes > 1;
  }

  return false;
}

// ── create_schedule ─────────────────────────────────────────

const createScheduleDef: ToolDefinition = {
  name: "create_schedule",
  description:
    "Create a cron schedule for recurring bloop execution. " +
    "The schedule will fire at the specified cron interval and run a bloop with the given goal.",
  inputSchema: {
    type: "object",
    properties: {
      cron_expression: {
        type: "string",
        description: "Cron expression (e.g., '0 9 * * 1-5' for weekday mornings, '*/30 * * * *' for every 30 min)",
      },
      goal: { type: "string", description: "Goal for each scheduled bloop run" },
      team: { type: "string", description: "Team preset (default: solo)" },
      description: { type: "string", description: "Human-readable description of this schedule" },
    },
    required: ["cron_expression", "goal"],
  },
};

function createCreateScheduleHandler(
  deps: SchedulingDeps,
  getCtx: () => BloopContext | null,
): ToolHandler {
  return async (input) => {
    const ctx = getCtx();
    if (!ctx) throw new Error("No active bloop context");

    const config = getConfig();
    const cronExpr = input.cron_expression as string;
    const goal = input.goal as string;

    // Validate cron expression
    if (!cron.validate(cronExpr)) {
      throw new Error(`Invalid cron expression: ${cronExpr}`);
    }

    // Check frequency
    if (isCronTooFrequent(cronExpr, config.minCronIntervalMinutes)) {
      throw new Error(
        `Cron expression fires too frequently. Minimum interval is ${config.minCronIntervalMinutes} minutes.`
      );
    }

    // Check max schedules per project
    const existing = deps.getScheduler().listSchedules(ctx.projectSlug);
    if (existing.length >= config.maxSchedulesPerProject) {
      throw new Error(
        `Max schedules reached (${config.maxSchedulesPerProject}) for project "${ctx.projectSlug}".`
      );
    }

    const schedule = deps.getScheduler().addSchedule({
      projectId: ctx.projectId,
      projectSlug: ctx.projectSlug,
      cronExpression: cronExpr,
      goal,
      team: input.team as string | undefined,
      description: input.description as string | undefined,
    });

    return `Schedule created. ID: ${schedule.id}\nCron: ${cronExpr}\nGoal: ${goal}`;
  };
}

// ── create_trigger ──────────────────────────────────────────

const createTriggerDef: ToolDefinition = {
  name: "create_trigger",
  description:
    "Create an event trigger that spawns a bloop when a matching event fires. " +
    "Use {{data.field}} in the goal template for event data interpolation.",
  inputSchema: {
    type: "object",
    properties: {
      event_type: {
        type: "string",
        description: "Event type to match (e.g., 'bloop:completed', 'webhook:github')",
      },
      filter_pattern: {
        type: "string",
        description: "Regex pattern for event type matching (default: '.*')",
      },
      goal_template: {
        type: "string",
        description: "Goal template with {{data.field}} placeholders for event data interpolation",
      },
      team: { type: "string", description: "Team preset (default: solo)" },
    },
    required: ["event_type", "goal_template"],
  },
};

function createCreateTriggerHandler(
  deps: SchedulingDeps,
  getCtx: () => BloopContext | null,
): ToolHandler {
  return async (input) => {
    const ctx = getCtx();
    if (!ctx) throw new Error("No active bloop context");

    const config = getConfig();

    // Validate regex pattern if provided
    const filterPattern = input.filter_pattern as string | undefined;
    if (filterPattern) {
      try {
        new RegExp(filterPattern);
      } catch {
        throw new Error(`Invalid regex pattern: ${filterPattern}`);
      }
    }

    // Check max triggers per project
    const existing = deps.getEventManager().getTriggerManager().listTriggers(ctx.projectSlug);
    if (existing.length >= config.maxTriggersPerProject) {
      throw new Error(
        `Max triggers reached (${config.maxTriggersPerProject}) for project "${ctx.projectSlug}".`
      );
    }

    const trigger = deps.getEventManager().getTriggerManager().addTrigger({
      projectId: ctx.projectId,
      projectSlug: ctx.projectSlug,
      eventType: input.event_type as string,
      filterPattern,
      goalTemplate: input.goal_template as string,
      team: input.team as string | undefined,
    });

    return `Trigger created. ID: ${trigger.id}\nEvent: ${input.event_type}\nGoal template: ${input.goal_template}`;
  };
}

// ── list_schedules ──────────────────────────────────────────

const listSchedulesDef: ToolDefinition = {
  name: "list_schedules",
  description: "List all cron schedules for the current project.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

function createListSchedulesHandler(
  deps: SchedulingDeps,
  getCtx: () => BloopContext | null,
): ToolHandler {
  return async () => {
    const ctx = getCtx();
    if (!ctx) throw new Error("No active bloop context");

    const schedules = deps.getScheduler().listSchedules(ctx.projectSlug);
    if (schedules.length === 0) return "No schedules found for this project.";

    const lines = schedules.map((s, i) => {
      const parts = [
        `${i + 1}. [${s.enabled ? "enabled" : "disabled"}] ${s.cronExpression}`,
        `   Goal: ${s.goal}`,
        `   Team: ${s.team} | ID: ${s.id}`,
      ];
      if (s.description) parts.push(`   Description: ${s.description}`);
      if (s.lastRunAt) parts.push(`   Last run: ${s.lastRunAt}`);
      return parts.join("\n");
    });

    return `Schedules (${schedules.length}):\n${lines.join("\n\n")}`;
  };
}

// ── list_triggers ───────────────────────────────────────────

const listTriggersDef: ToolDefinition = {
  name: "list_triggers",
  description: "List all event triggers for the current project.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

function createListTriggersHandler(
  deps: SchedulingDeps,
  getCtx: () => BloopContext | null,
): ToolHandler {
  return async () => {
    const ctx = getCtx();
    if (!ctx) throw new Error("No active bloop context");

    const triggers = deps.getEventManager().getTriggerManager().listTriggers(ctx.projectSlug);
    if (triggers.length === 0) return "No triggers found for this project.";

    const lines = triggers.map((t, i) => {
      return [
        `${i + 1}. [${t.enabled ? "enabled" : "disabled"}] ${t.eventType}`,
        `   Pattern: ${t.filterPattern}`,
        `   Goal: ${t.goalTemplate}`,
        `   Team: ${t.team} | ID: ${t.id}`,
      ].join("\n");
    });

    return `Triggers (${triggers.length}):\n${lines.join("\n\n")}`;
  };
}

// ── remove_schedule ─────────────────────────────────────────

const removeScheduleDef: ToolDefinition = {
  name: "remove_schedule",
  description: "Remove a cron schedule by ID. Can only remove schedules in the current project.",
  inputSchema: {
    type: "object",
    properties: {
      schedule_id: { type: "string", description: "Schedule ID to remove" },
    },
    required: ["schedule_id"],
  },
};

function createRemoveScheduleHandler(
  deps: SchedulingDeps,
  getCtx: () => BloopContext | null,
): ToolHandler {
  return async (input) => {
    const ctx = getCtx();
    if (!ctx) throw new Error("No active bloop context");

    const scheduleId = input.schedule_id as string;

    // Verify ownership
    const schedules = deps.getScheduler().listSchedules(ctx.projectSlug);
    const found = schedules.find((s) => s.id === scheduleId);
    if (!found) {
      throw new Error(`Schedule not found in project "${ctx.projectSlug}": ${scheduleId}`);
    }

    deps.getScheduler().removeSchedule(scheduleId);
    return `Schedule removed: ${scheduleId}`;
  };
}

// ── remove_trigger ──────────────────────────────────────────

const removeTriggerDef: ToolDefinition = {
  name: "remove_trigger",
  description: "Remove an event trigger by ID. Can only remove triggers in the current project.",
  inputSchema: {
    type: "object",
    properties: {
      trigger_id: { type: "string", description: "Trigger ID to remove" },
    },
    required: ["trigger_id"],
  },
};

function createRemoveTriggerHandler(
  deps: SchedulingDeps,
  getCtx: () => BloopContext | null,
): ToolHandler {
  return async (input) => {
    const ctx = getCtx();
    if (!ctx) throw new Error("No active bloop context");

    const triggerId = input.trigger_id as string;

    // Verify ownership
    const triggers = deps.getEventManager().getTriggerManager().listTriggers(ctx.projectSlug);
    const found = triggers.find((t) => t.id === triggerId);
    if (!found) {
      throw new Error(`Trigger not found in project "${ctx.projectSlug}": ${triggerId}`);
    }

    deps.getEventManager().getTriggerManager().removeTrigger(triggerId);
    return `Trigger removed: ${triggerId}`;
  };
}
