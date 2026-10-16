import { describe, expect, it } from "bun:test";
import { runEvalBudget } from "../../src/eval/budget-bridge";
import type { GoalModeState } from "../../src/goals/state";
import type { UsageStatistics } from "../../src/session/session-entries";
import type { ToolSession } from "../../src/tools";

type TurnBudget = { total: number | null; spent: number; hard: boolean };

function makeSession(parts: { turn?: TurnBudget; goal?: GoalModeState; usage?: UsageStatistics }): ToolSession {
	return {
		getTurnBudget: parts.turn ? () => parts.turn as TurnBudget : undefined,
		getGoalModeState: parts.goal ? () => parts.goal : undefined,
		getUsageStatistics: parts.usage ? () => parts.usage as UsageStatistics : undefined,
	} as unknown as ToolSession;
}

function goalState(extra: Partial<GoalModeState["goal"]>): GoalModeState {
	return {
		enabled: true,
		mode: "active",
		goal: { id: "g1", status: "active", tokensUsed: 0, timeUsedSeconds: 0, ...extra },
	} as GoalModeState;
}

function usage(output: number): UsageStatistics {
	return {
		input: 0,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: output,
		orchestrationInput: 0,
		orchestrationOutput: 0,
		orchestrationCacheRead: 0,
		premiumRequests: 0,
		cost: 0,
		subagentCost: 0,
	};
}

describe("runEvalBudget", () => {
	it("disallows agents from inspecting the remaining token budget", async () => {
		const session = makeSession({
			turn: { total: 200_000, spent: 5_000, hard: true },
			goal: goalState({ tokenBudget: 100_000, tokensUsed: 4_200 }),
			usage: usage(777),
		});
		await expect(runEvalBudget({}, { session })).rejects.toThrow(
			"Inspecting the remaining token budget is disabled.",
		);
	});
});
