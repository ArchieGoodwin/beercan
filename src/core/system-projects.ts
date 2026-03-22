import type { BeerCanEngine } from "../index.js";

// ── System Project Definitions ────────────────────────────────
// Auto-created projects that make BeerCan self-aware and proactive.
// These go through the normal bloop pipeline (Gatekeeper, job queue,
// memory, skills, reflection) instead of ad-hoc execution paths.

export interface SystemProjectDef {
  slug: string;
  name: string;
  description: string;
  context: Record<string, unknown>;
}

export const SYSTEM_PROJECTS: SystemProjectDef[] = [
  {
    slug: "_heartbeat",
    name: "Heartbeat Monitor",
    description: "Periodic health checks for monitored projects. Accumulates memory about what 'normal' looks like.",
    context: {
      systemProject: true,
      purpose: "heartbeat",
      reflectionEnabled: true,
      allowCrossProjectAccess: true,
    },
  },
  {
    slug: "_triggers",
    name: "Event Reactor",
    description: "Processes matched events from the trigger system. Builds context over time about event patterns.",
    context: {
      systemProject: true,
      purpose: "triggers",
      reflectionEnabled: true,
      allowCrossProjectAccess: true,
    },
  },
  {
    slug: "_maintenance",
    name: "System Maintenance",
    description: "Memory consolidation, stale job cleanup, reflection consolidation, cross-project pattern analysis.",
    context: {
      systemProject: true,
      purpose: "maintenance",
      reflectionEnabled: true,
      allowCrossProjectAccess: true,
    },
  },
  {
    slug: "_calendar",
    name: "Calendar Assistant",
    description: "Schedule-aware automation: morning briefs, upcoming event checks, meeting prep suggestions, reminders.",
    context: {
      systemProject: true,
      purpose: "calendar",
      reflectionEnabled: true,
      allowCrossProjectAccess: true,
    },
  },
];

/**
 * Ensure all system projects exist. Idempotent — safe to call on every init.
 */
export function ensureSystemProjects(engine: BeerCanEngine): void {
  for (const def of SYSTEM_PROJECTS) {
    try {
      const existing = engine.getProject(def.slug);
      if (!existing) {
        engine.createProject({
          name: def.name,
          slug: def.slug,
          description: def.description,
          context: def.context,
          system: true,
        });
      }
    } catch {
      // Silently skip if project creation fails (e.g., slug collision)
    }
  }
}
