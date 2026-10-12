import { describe, expect, test } from "bun:test";
import { compileCascade } from "../scripts/compat-compiler/compile-cascade";
import { resolveCatalogPolicy } from "../src/compat/catalog-policy";
import { resolveCascadeRules } from "../src/compat/cascade";
import { getBundledModel } from "../src/models";
import type { Model } from "../src/types";

describe("task sibling prompt-cache opt-in", () => {
	const muse = getBundledModel("muse-code", "muse-spark-1.3-contributor");

	test("enables only the measured provider, model, and API route", () => {
		expect(resolveCatalogPolicy(muse).taskSiblingPromptCache).toBe(true);
		const unmeasured: Model[] = [
			{ ...muse, id: "muse-spark-1.3" },
			{ ...muse, id: "muse-spark-1.2-contributor" },
			{ ...muse, id: "muse-spark-1.4-contributor" },
			{ ...muse, provider: "meta", providerType: undefined },
			{ ...muse, provider: "custom-host", providerType: undefined },
			{ ...muse, api: "openai-completions" },
			getBundledModel("openai-codex", "gpt-6-luna"),
			getBundledModel("google-antigravity", "gemini-3.8-flash"),
		];
		for (const model of unmeasured) {
			expect(
				resolveCatalogPolicy(model).taskSiblingPromptCache,
				`${model.provider}/${model.id}/${model.api}`,
			).not.toBe(true);
		}
	});

	test("honors an explicitly declared backend for custom provider names", () => {
		expect(
			resolveCatalogPolicy({ ...muse, provider: "custom-muse", providerType: "muse-code" }).taskSiblingPromptCache,
		).toBe(true);
		expect(resolveCatalogPolicy({ ...muse, providerType: "meta" }).taskSiblingPromptCache).not.toBe(true);
	});

	test("allows a narrower false rule to disable sharing and rejects string booleans", () => {
		const cascade = compileCascade([
			{
				file: "providers/test.kdl",
				text: 'provider "test" { task-sibling-prompt-cache #true; models "disabled" { task-sibling-prompt-cache #false } }',
			},
		]);
		expect(
			resolveCascadeRules(cascade, {
				provider: "test",
				api: "openai-responses",
				class: "unknown",
				model: "disabled",
				reasoning: false,
			}).catalog.taskSiblingPromptCache,
		).toBe(false);
		expect(() =>
			compileCascade([
				{
					file: "providers/test.kdl",
					text: 'provider "test" { task-sibling-prompt-cache "false" }',
				},
			]),
		).toThrow(/task-sibling-prompt-cache.*rejects value/);
	});
});
