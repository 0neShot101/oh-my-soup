import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveJudgmentQuestionsMax } from "@oh-my-pi/pi-catalog/compat/judgment-questions";

const base = {
	reasoning: false,
	input: ["text"] as "text"[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_000,
	maxTokens: 0,
};

describe("judgment-questions-max", () => {
	test("caps user-configured OpenJEV judges at 16 questions; TypeSafe jev stays uncapped", () => {
		const openjev = buildModel({
			...base,
			id: "openjev-4b",
			name: "OpenJEV 4B",
			api: "typesafe",
			provider: "my-openjev",
			baseUrl: "http://localhost:8000",
		});
		const jev = buildModel({
			...base,
			id: "jev-latest",
			name: "TypeSafe jev",
			api: "typesafe",
			provider: "typesafe",
			baseUrl: "https://api.typesafe.ai",
		});
		const openrouterJev = buildModel({
			...base,
			id: "~typesafe/jev-latest",
			name: "TypeSafe: Jev Latest",
			api: "openrouter-decisions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/alpha",
		});

		expect(resolveJudgmentQuestionsMax(openjev)).toBe(16);
		expect(resolveJudgmentQuestionsMax(jev)).toBeUndefined();
		expect(resolveJudgmentQuestionsMax(openrouterJev)).toBeUndefined();
	});
});
