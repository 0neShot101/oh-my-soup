import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveImageCountBudget, resolveInlineImageByteBudget } from "@oh-my-pi/pi-catalog/compat/request-size";
import { getBundledModel, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { toModelSpec } from "@oh-my-pi/pi-catalog/provider-models/bundled-references";
import type { Model } from "@oh-my-pi/pi-catalog/types";

function rerouted(model: Model<"openai-codex-responses">, baseUrl: string): Model<"openai-codex-responses"> {
	return buildModel({ ...toModelSpec(model), baseUrl });
}

describe("image-count-budget", () => {
	test("Anthropic allows 100 images on 200k-window models and 600 on the rest", () => {
		const rows = getBundledModels("anthropic").filter(model => model.input.includes("image"));
		expect(rows.length).toBeGreaterThan(0);
		for (const model of rows) {
			expect({ id: model.id, budget: resolveImageCountBudget(model) }).toEqual({
				id: model.id,
				budget: model.contextWindow !== null && model.contextWindow > 200_000 ? 600 : 100,
			});
		}
	});

	test("separator-collapsed Claude revisions keep the 200k-window budget", () => {
		const opus = getBundledModel("anthropic", "claude-opus-4-5");
		expect(resolveImageCountBudget(buildModel({ ...toModelSpec(opus), id: "claude-opus-45" }))).toBe(100);
		expect(resolveImageCountBudget(buildModel({ ...toModelSpec(opus), id: "claude-opus-46" }))).toBe(600);
	});

	test.each([
		["openai-codex", "gpt-6.1-sol", 2000],
		["openai", "gpt-5.5", 200],
		["amazon-bedrock", "us.anthropic.claude-opus-5-5", 90],
		["openrouter", "anthropic/claude-opus-5.5", 90],
	] as const)("%s carries its budget", (provider, id, budget) => {
		expect(resolveImageCountBudget(getBundledModel(provider, id))).toBe(budget);
	});

	test("an unlisted host has no budget", () => {
		const ramp = buildModel({ ...toModelSpec(getBundledModel("anthropic", "claude-opus-5-5")), provider: "ramp" });
		expect(resolveImageCountBudget(ramp)).toBeUndefined();
	});
});

describe("inline-image-byte-budget", () => {
	test("the Codex backend carries 24 MB; a rerouted Codex baseUrl carries none", () => {
		const sol = getBundledModel<"openai-codex-responses">("openai-codex", "gpt-6.1-sol");
		expect(sol.compat.officialEndpoint).toBe(true);
		expect(resolveInlineImageByteBudget(sol)).toBe(24_000_000);
		expect(resolveInlineImageByteBudget(rerouted(sol, "https://chatgpt.com/backend-api/"))).toBe(24_000_000);
		const proxied = rerouted(sol, "https://codex-proxy.example/backend-api");
		expect(proxied.compat.officialEndpoint).toBe(false);
		expect(resolveInlineImageByteBudget(proxied)).toBeUndefined();
	});
});
