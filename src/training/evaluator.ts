import { getConfig } from "../config.js";
import type { LLMProvider, LLMTool, LLMToolUseBlock } from "../providers/types.js";
import type { TrainingScenario, ScenarioAttempt } from "./types.js";
import type { ToolCallRecord } from "../schemas.js";

// ── Grade Tool (structured output) ──────────────────────────

const GRADE_SCENARIO_TOOL: LLMTool = {
  name: "grade_scenario",
  description: "Grade a training scenario result. You MUST call this tool.",
  inputSchema: {
    type: "object" as const,
    properties: {
      score: {
        type: "number",
        description: "Score between 0.0 and 1.0. 1.0 = perfect, 0.0 = completely wrong.",
        minimum: 0,
        maximum: 1,
      },
      passed: {
        type: "boolean",
        description: "Whether the scenario was passed (score meets passing threshold).",
      },
      feedback: {
        type: "string",
        description: "Concise feedback explaining the score (2-4 sentences). Be specific about what was done well and what was lacking.",
      },
      reasoning: {
        type: "string",
        description: "Internal reasoning used to arrive at the grade (1-3 sentences).",
      },
    },
    required: ["score", "passed", "feedback", "reasoning"],
  },
};

// ── Evaluator Result ─────────────────────────────────────────

export interface EvaluationResult {
  score: number;
  passed: boolean;
  feedback: string;
}

// ── Scenario Evaluator ───────────────────────────────────────

export class ScenarioEvaluator {
  private provider: LLMProvider;

  constructor(provider: LLMProvider) {
    this.provider = provider;
  }

  /**
   * Evaluate a completed scenario bloop result.
   * Uses the appropriate evaluator type from the scenario config.
   */
  async evaluate(
    scenario: TrainingScenario,
    bloopResult: string,
    toolCalls: ToolCallRecord[],
  ): Promise<EvaluationResult> {
    const { evaluatorType, evaluatorConfig } = scenario;
    const passThreshold = evaluatorConfig.passThreshold ?? 0.6;

    try {
      switch (evaluatorType) {
        case "contains":
          return this.evaluateContains(bloopResult, evaluatorConfig.pattern ?? "", passThreshold);

        case "regex":
          return this.evaluateRegex(bloopResult, evaluatorConfig.pattern ?? "", passThreshold);

        case "llm":
          return await this.evaluateLLM(
            scenario,
            bloopResult,
            toolCalls,
            evaluatorConfig.criteria ?? scenario.evaluationCriteria,
            passThreshold,
          );

        default:
          return {
            score: 0,
            passed: false,
            feedback: `Unknown evaluator type: ${evaluatorType}`,
          };
      }
    } catch (err: any) {
      return {
        score: 0,
        passed: false,
        feedback: `Evaluation failed: ${err.message ?? String(err)}`,
      };
    }
  }

  // ── Evaluator Implementations ────────────────────────────

  private evaluateContains(
    result: string,
    pattern: string,
    passThreshold: number,
  ): EvaluationResult {
    const normalizedResult = result.toLowerCase();
    const normalizedPattern = pattern.toLowerCase();
    const found = normalizedResult.includes(normalizedPattern);
    const score = found ? 1.0 : 0.0;

    return {
      score,
      passed: score >= passThreshold,
      feedback: found
        ? `Result contains the expected pattern "${pattern}".`
        : `Result does not contain the expected pattern "${pattern}".`,
    };
  }

  private evaluateRegex(
    result: string,
    pattern: string,
    passThreshold: number,
  ): EvaluationResult {
    try {
      const regex = new RegExp(pattern, "i");
      const found = regex.test(result);
      const score = found ? 1.0 : 0.0;

      return {
        score,
        passed: score >= passThreshold,
        feedback: found
          ? `Result matches the pattern /${pattern}/.`
          : `Result does not match the pattern /${pattern}/.`,
      };
    } catch (err: any) {
      return {
        score: 0,
        passed: false,
        feedback: `Invalid regex pattern "${pattern}": ${err.message}`,
      };
    }
  }

  private async evaluateLLM(
    scenario: TrainingScenario,
    result: string,
    toolCalls: ToolCallRecord[],
    criteria: string,
    passThreshold: number,
  ): Promise<EvaluationResult> {
    const config = getConfig();
    const model = config.reflectionModel ?? config.gatekeeperModel;

    // Build summary of tool calls used
    const toolNames = [...new Set(toolCalls.map((tc) => tc.toolName))];
    const toolCallSummary = toolNames.length > 0
      ? `Tools used: ${toolNames.join(", ")}`
      : "No tools used";

    const errorCount = toolCalls.filter((tc) => tc.error).length;
    const errorSummary = errorCount > 0
      ? `Tool errors: ${errorCount} (${toolCalls.filter((tc) => tc.error).map((tc) => tc.toolName).join(", ")})`
      : "No tool errors";

    const prompt = [
      `You are evaluating a training scenario result for an AI agent.`,
      ``,
      `Scenario: ${scenario.name} (${scenario.difficulty})`,
      `Goal: ${scenario.goal.slice(0, 500)}`,
      `Evaluation Criteria: ${criteria}`,
      `Pass Threshold: ${passThreshold} (score >= ${passThreshold} = pass)`,
      ``,
      `Agent Execution:`,
      `${toolCallSummary}`,
      `${errorSummary}`,
      ``,
      `Agent Result (truncated to 2000 chars):`,
      result.slice(0, 2000),
    ].join("\n");

    const response = await this.provider.createMessage({
      model,
      maxTokens: 512,
      system: "You are a precise AI training evaluator. Grade fairly and consistently. A passing score means the agent demonstrated the required capability, not perfection.",
      tools: [GRADE_SCENARIO_TOOL],
      toolChoice: { type: "tool", name: "grade_scenario" },
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    // Extract structured result from tool call
    const toolBlock = response.content.find(
      (b): b is LLMToolUseBlock => b.type === "tool_use",
    );

    if (!toolBlock) {
      // Fallback: no structured output
      return {
        score: 0.5,
        passed: 0.5 >= passThreshold,
        feedback: "LLM evaluation did not return structured output. Defaulting to 0.5.",
      };
    }

    const gradeResult = toolBlock.input as {
      score: number;
      passed: boolean;
      feedback: string;
      reasoning: string;
    };

    const score = Math.max(0, Math.min(1, gradeResult.score ?? 0));
    const passed = gradeResult.passed ?? (score >= passThreshold);

    return {
      score,
      passed,
      feedback: gradeResult.feedback ?? "No feedback provided.",
    };
  }
}
