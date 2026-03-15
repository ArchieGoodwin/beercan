import { z } from "zod";

// ── Agent Role Schema ────────────────────────────────────────

export const AgentRoleSchema = z.object({
  /** Unique role identifier, e.g. "coder", "reviewer", "manager" */
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** System prompt injected when this agent is active */
  systemPrompt: z.string(),
  /** Which tools this role is allowed to use. ["*"] = all project tools */
  allowedTools: z.array(z.string()).default(["*"]),
  /** Model override — some roles need heavier reasoning */
  model: z.string().optional(),
  /** Temperature override */
  temperature: z.number().min(0).max(1).optional(),
  /**
   * When does this agent get invoked in a bloop?
   * - "primary"   → runs the main bloop cycle
   * - "review"    → called after primary produces output
   * - "validate"  → called after review to verify / run tests
   * - "plan"      → called at the start to break down the goal
   * - "summarize" → called at the end to produce final output
   */
  phase: z.enum(["plan", "primary", "review", "validate", "summarize"]).default("primary"),
  /** Max iterations this specific agent can run within its phase */
  maxIterations: z.number().default(20),
});
export type AgentRole = z.infer<typeof AgentRoleSchema>;

// ── Bloop Team Schema ─────────────────────────────────────────
// Defines which agents participate in a bloop and in what order

export const BloopTeamSchema = z.object({
  /**
   * Pipeline defines execution order.
   * Each stage runs its assigned agent(s) before moving to the next.
   * A stage can have multiple agents (they see each other's output).
   */
  pipeline: z.array(
    z.object({
      phase: z.enum(["plan", "primary", "review", "validate", "summarize"]),
      roleId: z.string(),
      /** If true, this phase can send work back to a previous phase */
      canReject: z.boolean().optional(),
      /** Phase to return to on rejection */
      rejectTo: z.enum(["plan", "primary", "review", "validate", "summarize"]).optional(),
    })
  ),
  /** Max full pipeline cycles (plan→primary→review→validate) before forced completion */
  maxCycles: z.number().default(3),
});
export type BloopTeam = z.infer<typeof BloopTeamSchema>;

// ── Built-in Roles ───────────────────────────────────────────

export const BUILTIN_ROLES: Record<string, AgentRole> = {
  manager: {
    id: "manager",
    name: "Manager",
    description: "Breaks down goals into tasks, coordinates work, decides when done.",
    systemPrompt: `You are the Manager agent in the BeerCan system. Your responsibilities:

1. PLANNING: Break down the user's goal into concrete, actionable sub-tasks.
2. DELEGATION: Decide which tasks need coding, research, or other specialist work.
3. EVALUATION: Review outputs from other agents and decide if the goal is met.
4. COMPLETION: When satisfied, produce a clear summary of what was accomplished.

You think strategically. You don't write code yourself — you describe what needs to be built,
what files to create/modify, and what the acceptance criteria are.

When evaluating work from other agents:
- If the work meets the goal → respond with <decision>APPROVE</decision>
- If changes are needed → respond with <decision>REVISE</decision> and explain what to fix
- If the approach is fundamentally wrong → respond with <decision>REJECT</decision> and re-plan

Be concise. Be decisive. Don't waffle.`,
    allowedTools: ["read_file", "list_directory", "memory_search", "memory_query_graph", "memory_scratch"],
    phase: "plan",
    maxIterations: 10,
  },

  coder: {
    id: "coder",
    name: "Coder",
    description: "Writes, modifies, and debugs code. Has full filesystem and exec access.",
    systemPrompt: `You are the Coder agent in the BeerCan system. Your responsibilities:

1. Write clean, well-structured TypeScript/JavaScript code.
2. Follow the plan provided by the Manager agent.
3. Create files, modify existing code, run commands as needed.
4. After making changes, verify they work by running relevant commands.

Rules:
- Write production-quality code with proper error handling.
- Use TypeScript with strict types. No 'any' unless absolutely necessary.
- Keep files focused — one concern per file.
- Add brief JSDoc comments on exported functions.
- If something is unclear in the plan, make a reasonable decision and document it.
- After writing code, always try to verify it compiles/runs.

You have access to: read_file, write_file, list_directory, exec_command, web_fetch, http_request.`,
    allowedTools: ["read_file", "write_file", "list_directory", "exec_command", "web_fetch", "http_request", "memory_search", "memory_store", "memory_update", "memory_link", "memory_scratch"],
    phase: "primary",
    maxIterations: 20,
  },

  reviewer: {
    id: "reviewer",
    name: "Reviewer",
    description: "Reviews code for quality, bugs, security issues, and adherence to plan.",
    systemPrompt: `You are the Reviewer agent in the BeerCan system. Your responsibilities:

1. Read the code produced by the Coder agent.
2. Check for: bugs, security issues, edge cases, code quality, adherence to the plan.
3. Verify the code is well-structured and maintainable.
4. Check that error handling is proper and types are correct.

Your output format:
- Start with an overall assessment: PASS, NEEDS_CHANGES, or FAIL
- List specific issues found (if any) with file paths and line references
- Suggest concrete fixes, not vague complaints

If PASS: respond with <decision>APPROVE</decision>
If NEEDS_CHANGES: respond with <decision>REVISE</decision> and list required changes
If FAIL: respond with <decision>REJECT</decision> and explain why

Be thorough but pragmatic. Don't nitpick style if functionality is correct.
Focus on things that would actually cause problems.`,
    allowedTools: ["read_file", "list_directory", "exec_command", "memory_search", "memory_query_graph"],
    phase: "review",
    maxIterations: 5,
  },

  tester: {
    id: "tester",
    name: "Tester",
    description: "Validates code by running tests, checking builds, verifying behavior.",
    systemPrompt: `You are the Tester agent in the BeerCan system. Your responsibilities:

1. Verify the code produced by the Coder agent actually works.
2. Run build commands, execute scripts, check for runtime errors.
3. Write and run simple validation tests if appropriate.
4. Check edge cases and error conditions.

Your process:
1. Read the relevant files to understand what was built
2. Run any build/compile commands
3. Execute the code or tests
4. Report results

If everything passes: respond with <decision>APPROVE</decision>
If tests fail: respond with <decision>REVISE</decision> with exact error output
If fundamentally broken: respond with <decision>REJECT</decision>

Always include the actual command output in your response.`,
    allowedTools: ["read_file", "write_file", "list_directory", "exec_command", "memory_search", "memory_scratch"],
    phase: "validate",
    maxIterations: 10,
  },

  solo: {
    id: "solo",
    name: "Solo",
    description: "General-purpose single agent. Does everything — plan, code, review, test.",
    systemPrompt: `You are a general-purpose agent in the BeerCan system. You handle all aspects of the task:
planning, implementation, review, and validation.

Work methodically:
1. Understand the goal
2. Plan your approach
3. Implement it using the tools available
4. Verify your work
5. Summarize what you did

When your goal is achieved, clearly state DONE and provide a summary.`,
    allowedTools: ["*"],
    phase: "primary",
    maxIterations: 30,
  },
};

// ── Preset Teams ─────────────────────────────────────────────

export const PRESET_TEAMS: Record<string, BloopTeam> = {
  /** Solo agent — simplest setup, one agent does everything */
  solo: {
    pipeline: [
      { phase: "primary", roleId: "solo" },
    ],
    maxCycles: 1,
  },

  /** Coder + Reviewer — write then review */
  code_review: {
    pipeline: [
      { phase: "primary", roleId: "coder" },
      { phase: "review", roleId: "reviewer", canReject: true, rejectTo: "primary" },
    ],
    maxCycles: 3,
  },

  /** Full team — plan, code, review, test */
  full_team: {
    pipeline: [
      { phase: "plan", roleId: "manager" },
      { phase: "primary", roleId: "coder" },
      { phase: "review", roleId: "reviewer", canReject: true, rejectTo: "primary" },
      { phase: "validate", roleId: "tester", canReject: true, rejectTo: "primary" },
    ],
    maxCycles: 3,
  },

  /** Manager + Coder — planned execution without formal review */
  managed: {
    pipeline: [
      { phase: "plan", roleId: "manager" },
      { phase: "primary", roleId: "coder" },
      { phase: "summarize", roleId: "manager" },
    ],
    maxCycles: 2,
  },
};
