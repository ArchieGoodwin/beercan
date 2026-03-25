import { Logger, getLogger } from "../core/logger.js";
import type { BeerCanEngine } from "../index.js";
import type { BeerCanDB } from "../storage/database.js";
import type { Config } from "../config.js";
import type { Project } from "../schemas.js";
import {
  TrainingProgressSchema,
  type TrainingProgress,
  type TrainingScenario,
  type ScenarioAttempt,
} from "./types.js";
import { DEFAULT_CURRICULUM, GRADUATION_CRITERIA } from "./curriculum.js";
import { ScenarioEvaluator } from "./evaluator.js";
import { createLLMProvider } from "../providers/factory.js";

// ── Training Sandbox Manager ─────────────────────────────────
// Manages training projects, runs scenarios, tracks progress, and
// evaluates graduation criteria.

export class TrainingSandboxManager {
  private engine: BeerCanEngine;
  private db: BeerCanDB;
  private config: Config;
  private logger: Logger;
  private evaluator: ScenarioEvaluator | null = null;

  constructor(engine: BeerCanEngine, db: BeerCanDB, config: Config) {
    this.engine = engine;
    this.db = db;
    this.config = config;
    this.logger = getLogger();
  }

  /**
   * Lazily initialise the evaluator (requires async provider creation).
   */
  private async getEvaluator(): Promise<ScenarioEvaluator> {
    if (!this.evaluator) {
      const provider = await createLLMProvider();
      this.evaluator = new ScenarioEvaluator(provider);
    }
    return this.evaluator;
  }

  // ── Trainee Creation ────────────────────────────────────

  /**
   * Create a new training project for an agent trainee.
   */
  async createTrainee(name: string, workDir?: string): Promise<Project> {
    const slug = `training-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

    // Check for existing project
    const existing = this.engine.getProject(slug);
    if (existing) {
      throw new Error(`Training project already exists: ${slug}`);
    }

    const now = new Date().toISOString();
    const initialProgress: TrainingProgress = {
      projectSlug: slug,
      currentLevel: "novice",
      passedScenarios: [],
      failedScenarios: [],
      scenarioAttempts: [],
      createdTools: [],
      createdSkills: [],
      graduationStatus: "training",
      startedAt: now,
      totalTokensUsed: 0,
      totalBloops: 0,
    };

    const project = this.engine.createProject({
      name: `Training: ${name}`,
      slug,
      description: `Training sandbox for agent: ${name}`,
      workDir,
      system: false,
      context: {
        isTrainee: true,
        reflectionEnabled: true,
        allowCrossProjectAccess: false,
        trainingProgress: initialProgress,
      },
    });

    this.logger.info("training", `Created trainee project: ${slug}`, { name });
    return project;
  }

  // ── Progress Management ──────────────────────────────────

  /**
   * Read training progress from the project's context.
   */
  async getProgress(projectSlug: string): Promise<TrainingProgress> {
    const project = this.engine.getProject(projectSlug);
    if (!project) {
      throw new Error(`Project not found: ${projectSlug}`);
    }

    const rawProgress = project.context?.trainingProgress;
    if (!rawProgress) {
      throw new Error(`Project ${projectSlug} is not a training project`);
    }

    return TrainingProgressSchema.parse(rawProgress);
  }

  /**
   * Persist updated progress to the project context.
   */
  async updateProgress(projectSlug: string, progress: TrainingProgress): Promise<void> {
    const project = this.engine.getProject(projectSlug);
    if (!project) {
      throw new Error(`Project not found: ${projectSlug}`);
    }

    const now = new Date().toISOString();
    const updatedProject = {
      ...project,
      context: {
        ...project.context,
        trainingProgress: progress,
      },
      updatedAt: now,
    };

    this.db.updateProject(updatedProject);
    this.logger.info("training", `Updated progress for ${projectSlug}`, {
      currentLevel: progress.currentLevel,
      passed: progress.passedScenarios.length,
      graduationStatus: progress.graduationStatus,
    });
  }

  // ── Scenario Selection ───────────────────────────────────

  /**
   * Pick the next scenario based on prerequisites and current level.
   * Returns null if no scenarios are available (all done or prerequisites not met).
   */
  async getNextScenario(projectSlug: string): Promise<TrainingScenario | null> {
    const progress = await this.getProgress(projectSlug);

    // Find all scenarios that:
    // 1. Haven't been passed yet
    // 2. Haven't exhausted max attempts
    // 3. Have all prerequisites satisfied
    // 4. Are at the current level or below (allow retrying earlier levels)
    const LEVELS: TrainingScenario["difficulty"][] = ["novice", "apprentice", "journeyman", "expert"];
    const currentLevelIdx = LEVELS.indexOf(progress.currentLevel);

    for (const scenario of DEFAULT_CURRICULUM) {
      const scenarioLevelIdx = LEVELS.indexOf(scenario.difficulty);

      // Skip scenarios above current level
      if (scenarioLevelIdx > currentLevelIdx) continue;

      // Skip already-passed scenarios
      if (progress.passedScenarios.includes(scenario.id)) continue;

      // Check max attempts
      const failRecord = progress.failedScenarios.find((f: { id: string; attempts: number }) => f.id === scenario.id);
      if (failRecord && failRecord.attempts >= scenario.maxAttempts) continue;

      // Check prerequisites
      const prereqsMet = scenario.prerequisites.every((prereqId: string) =>
        progress.passedScenarios.includes(prereqId)
      );
      if (!prereqsMet) continue;

      return scenario;
    }

    // Try advancing to next level only if current level meets minimum pass rate
    const nextLevelIdx = currentLevelIdx + 1;
    if (nextLevelIdx < LEVELS.length) {
      const currentLevel = LEVELS[currentLevelIdx];
      const currentLevelScenarios = DEFAULT_CURRICULUM.filter((s) => s.difficulty === currentLevel);
      const passedInCurrentLevel = currentLevelScenarios.filter((s) =>
        progress.passedScenarios.includes(s.id)
      ).length;
      const currentPassRate = currentLevelScenarios.length > 0
        ? passedInCurrentLevel / currentLevelScenarios.length
        : 0;
      const requiredRate = GRADUATION_CRITERIA.minPassRateByLevel[currentLevel] ?? 0;

      // Only advance if current level meets its graduation pass rate
      if (currentPassRate >= requiredRate) {
        const nextLevel = LEVELS[nextLevelIdx];
        const nextLevelScenarios = DEFAULT_CURRICULUM.filter((s) => s.difficulty === nextLevel);

        for (const scenario of nextLevelScenarios) {
          if (progress.passedScenarios.includes(scenario.id)) continue;
          const failRecord = progress.failedScenarios.find((f: { id: string; attempts: number }) => f.id === scenario.id);
          if (failRecord && failRecord.attempts >= scenario.maxAttempts) continue;
          const prereqsMet = scenario.prerequisites.every((prereqId: string) =>
            progress.passedScenarios.includes(prereqId)
          );
          if (!prereqsMet) continue;

          // Advance level
          progress.currentLevel = nextLevel;
          await this.updateProgress(projectSlug, progress);
          return scenario;
        }
      }
    }

    return null;
  }

  /**
   * Get a specific scenario by ID.
   */
  getScenario(scenarioId: string): TrainingScenario | null {
    return DEFAULT_CURRICULUM.find((s) => s.id === scenarioId) ?? null;
  }

  // ── Scenario Execution ───────────────────────────────────

  /**
   * Run a training scenario (or the next available one).
   * Executes the bloop, evaluates the result, updates progress.
   */
  async runScenario(
    projectSlug: string,
    scenarioId?: string,
  ): Promise<ScenarioAttempt> {
    const progress = await this.getProgress(projectSlug);

    // Resolve which scenario to run
    let scenario: TrainingScenario | null = null;
    if (scenarioId) {
      scenario = this.getScenario(scenarioId);
      if (!scenario) {
        throw new Error(`Scenario not found: ${scenarioId}`);
      }
    } else {
      scenario = await this.getNextScenario(projectSlug);
      if (!scenario) {
        throw new Error("No scenarios available — all done or prerequisites not met");
      }
    }

    // Check attempt count
    const failRecord = progress.failedScenarios.find((f: { id: string; attempts: number }) => f.id === scenario.id);
    const attemptNumber = (failRecord?.attempts ?? 0) + 1;
    if (failRecord && failRecord.attempts >= scenario.maxAttempts) {
      throw new Error(
        `Scenario ${scenario.id} has reached max attempts (${scenario.maxAttempts})`
      );
    }

    // Build training context for the bloop
    const extraContext = [
      `--- Training Scenario ---`,
      `Name: ${scenario.name}`,
      `Difficulty: ${scenario.difficulty}`,
      `Category: ${scenario.category}`,
      `This tests: ${scenario.teaches.join(", ")}`,
      `Attempt: ${attemptNumber} of ${scenario.maxAttempts}`,
      scenario.requiredTools.length > 0
        ? `Expected tools: ${scenario.requiredTools.join(", ")}`
        : "",
      ``,
      `Demonstrate your capability clearly and completely.`,
      `Show your work — use the relevant tools and explain what you are doing.`,
    ].filter(Boolean).join("\n");

    this.logger.info("training", `Running scenario: ${scenario.id}`, {
      projectSlug,
      scenarioId: scenario.id,
      attempt: attemptNumber,
    });

    const startTime = Date.now();
    let bloopId = "";
    let bloopResult = "";
    let toolCalls: import("../schemas.js").ToolCallRecord[] = [];
    let tokensUsed = 0;
    let bloopStatus: "pass" | "fail" | "error" = "error";

    try {
      const bloop = await this.engine.runBloop({
        projectSlug,
        goal: scenario.goal,
        team: "auto",
        extraContext,
      });

      bloopId = bloop.id;
      tokensUsed = bloop.tokensUsed;
      toolCalls = bloop.toolCalls;

      if (bloop.result) {
        bloopResult = typeof bloop.result === "string"
          ? bloop.result
          : JSON.stringify(bloop.result);
      }

      if (bloop.status === "failed") {
        bloopStatus = "error";
      } else {
        // Evaluate the result
        const evaluator = await this.getEvaluator();
        const evaluation = await evaluator.evaluate(scenario, bloopResult, toolCalls);

        bloopStatus = evaluation.passed ? "pass" : "fail";
        const attempt: ScenarioAttempt = {
          scenarioId: scenario.id,
          bloopId,
          status: bloopStatus,
          score: evaluation.score,
          feedback: evaluation.feedback,
          tokensUsed,
          durationMs: Date.now() - startTime,
          attemptNumber,
          timestamp: new Date().toISOString(),
        };

        // Update progress with this attempt result
        await this.recordAttempt(projectSlug, scenario, attempt, progress);

        this.logger.info("training", `Scenario ${scenario.id}: ${bloopStatus}`, {
          score: evaluation.score,
          feedback: evaluation.feedback.slice(0, 100),
        });

        return attempt;
      }
    } catch (err: any) {
      this.logger.error("training", `Scenario ${scenario.id} execution failed`, {
        error: err.message,
      });
    }

    // Build a failure/error attempt
    const attempt: ScenarioAttempt = {
      scenarioId: scenario.id,
      bloopId: bloopId || "unknown",
      status: bloopStatus,
      score: 0,
      feedback: bloopStatus === "error"
        ? "Bloop failed to complete."
        : "Scenario did not meet passing criteria.",
      tokensUsed,
      durationMs: Date.now() - startTime,
      attemptNumber,
      timestamp: new Date().toISOString(),
    };

    await this.recordAttempt(projectSlug, scenario, attempt, progress);
    return attempt;
  }

  // ── Graduation ───────────────────────────────────────────

  /**
   * Check if the trainee meets graduation criteria.
   * Updates graduation status if criteria are met.
   */
  async checkGraduation(projectSlug: string): Promise<boolean> {
    const progress = await this.getProgress(projectSlug);

    if (progress.graduationStatus === "graduated") return true;

    const LEVELS: TrainingScenario["difficulty"][] = ["novice", "apprentice", "journeyman", "expert"];
    const criteria = GRADUATION_CRITERIA;

    // Check required scenarios
    for (const reqId of criteria.requiredScenarioIds) {
      if (!progress.passedScenarios.includes(reqId)) {
        return false;
      }
    }

    // Check pass rate per level
    for (const level of LEVELS) {
      const minRate = criteria.minPassRateByLevel[level] ?? 0;
      if (minRate === 0) continue;

      const levelScenarios = DEFAULT_CURRICULUM.filter((s) => s.difficulty === level);
      if (levelScenarios.length === 0) continue;

      const passedInLevel = levelScenarios.filter((s) =>
        progress.passedScenarios.includes(s.id)
      ).length;
      const passRate = passedInLevel / levelScenarios.length;

      if (passRate < minRate) return false;
    }

    // Check tools and skills
    if (progress.createdTools.length < criteria.minToolsCreated) return false;
    if (progress.createdSkills.length < criteria.minSkillsCreated) return false;

    // Graduate!
    progress.graduationStatus = "graduated";
    progress.graduatedAt = new Date().toISOString();
    await this.updateProgress(projectSlug, progress);

    this.logger.info("training", `Agent graduated: ${projectSlug}`, {
      passedScenarios: progress.passedScenarios.length,
      totalTokens: progress.totalTokensUsed,
    });

    return true;
  }

  // ── Status ───────────────────────────────────────────────

  /**
   * Get a human-readable status summary for a training project.
   */
  async getStatus(projectSlug: string): Promise<{
    progress: TrainingProgress;
    nextScenario: TrainingScenario | null;
    summary: string;
  }> {
    const progress = await this.getProgress(projectSlug);
    const nextScenario = await this.getNextScenario(projectSlug);

    const LEVELS: TrainingScenario["difficulty"][] = ["novice", "apprentice", "journeyman", "expert"];

    const lines: string[] = [
      `Training Status: ${projectSlug}`,
      `Graduation: ${progress.graduationStatus}`,
      `Current Level: ${progress.currentLevel}`,
      ``,
      `Progress by Level:`,
    ];

    for (const level of LEVELS) {
      const levelScenarios = DEFAULT_CURRICULUM.filter((s) => s.difficulty === level);
      const passed = levelScenarios.filter((s) => progress.passedScenarios.includes(s.id));
      const minRate = GRADUATION_CRITERIA.minPassRateByLevel[level] ?? 0;
      const required = Math.ceil(levelScenarios.length * minRate);
      lines.push(`  ${level}: ${passed.length}/${levelScenarios.length} passed (need ${required})`);
    }

    lines.push(``, `Total Bloops: ${progress.totalBloops}`);
    lines.push(`Total Tokens: ${progress.totalTokensUsed.toLocaleString()}`);

    if (nextScenario) {
      lines.push(``, `Next Scenario: ${nextScenario.name} (${nextScenario.difficulty})`);
      lines.push(`  Category: ${nextScenario.category}`);
      lines.push(`  Tests: ${nextScenario.teaches.slice(0, 3).join(", ")}`);
    } else if (progress.graduationStatus === "training") {
      lines.push(``, `No more scenarios available — check prerequisites or max attempts.`);
    } else {
      lines.push(``, `Graduation complete!`);
    }

    return {
      progress,
      nextScenario,
      summary: lines.join("\n"),
    };
  }

  // ── Internal ─────────────────────────────────────────────

  private async recordAttempt(
    projectSlug: string,
    scenario: TrainingScenario,
    attempt: ScenarioAttempt,
    progress: TrainingProgress,
  ): Promise<void> {
    // Add attempt to history
    progress.scenarioAttempts.push(attempt);
    progress.totalBloops += 1;
    progress.totalTokensUsed += attempt.tokensUsed;

    if (attempt.status === "pass") {
      // Add to passed list (avoid duplicates)
      if (!progress.passedScenarios.includes(scenario.id)) {
        progress.passedScenarios.push(scenario.id);
      }
      // Remove from failed list if present
      progress.failedScenarios = progress.failedScenarios.filter(
        (f: { id: string; attempts: number }) => f.id !== scenario.id
      );
    } else {
      // Increment failed attempt counter
      const failRecord = progress.failedScenarios.find((f: { id: string; attempts: number }) => f.id === scenario.id);
      if (failRecord) {
        failRecord.attempts += 1;
      } else {
        progress.failedScenarios.push({ id: scenario.id, attempts: 1 });
      }
    }

    await this.updateProgress(projectSlug, progress);

    // Check graduation after each successful attempt
    if (attempt.status === "pass") {
      await this.checkGraduation(projectSlug);
    }
  }
}
