import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveImageCountBudget, resolveInlineImageByteBudget } from "@oh-my-pi/pi-catalog/compat/request-size";
import { getBundledModel, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { toModelSpec } from "@oh-my-pi/pi-catalog/provider-models/bundled-references";
import type { Api, Model } from "@oh-my-pi/pi-catalog/types";

/** The configured endpoint's classification; request-time env reroutes are pi-ai's to apply. */
function configuredOfficial(model: Model): boolean {
	return !!model.compat && "officialEndpoint" in model.compat && model.compat.officialEndpoint === true;
}

function imageCountBudget(model: Model): number | undefined {
	return resolveImageCountBudget(model, configuredOfficial(model));
}

function inlineImageByteBudget(model: Model): number | undefined {
	return resolveInlineImageByteBudget(model, configuredOfficial(model));
}

function rerouted<TApi extends Api>(model: Model<TApi>, baseUrl: string): Model<TApi> {
	return buildModel({ ...toModelSpec(model), baseUrl }) as Model<TApi>;
}

describe("image-count-budget", () => {
	test("the Anthropic API allows 100 images on 200k-window models and 600 on the rest", () => {
		const rows = getBundledModels("anthropic").filter(model => model.input.includes("image"));
		expect(rows.length).toBeGreaterThan(0);
		for (const model of rows) {
			expect({ id: model.id, budget: imageCountBudget(model) }).toEqual({
				id: model.id,
				budget: model.contextWindow !== null && model.contextWindow > 200_000 ? 600 : 100,
			});
		}
	});

	test("separator-collapsed Claude revisions keep the 200k-window budget", () => {
		const opus = getBundledModel("anthropic", "claude-opus-4-5");
		expect(imageCountBudget(buildModel({ ...toModelSpec(opus), id: "claude-opus-45" }))).toBe(100);
		expect(imageCountBudget(buildModel({ ...toModelSpec(opus), id: "claude-opus-46" }))).toBe(600);
	});

	test.each([
		["anthropic", "claude-opus-5-5", 600, 90],
		["anthropic", "claude-opus-4-5", 100, 90],
		["openai-codex", "gpt-6.1-sol", 2000, 200],
	] as const)(
		"%s %s allows %d images on its official endpoint and %d through a custom baseUrl",
		(provider, id, official, custom) => {
			const model = getBundledModel(provider, id);
			const officialUrl = model.baseUrl;
			expect(imageCountBudget(model)).toBe(official);
			expect(imageCountBudget(rerouted(model, ""))).toBe(official);
			expect(imageCountBudget(rerouted(model, `${officialUrl}/`))).toBe(official);
			expect(imageCountBudget(rerouted(model, "https://llm-proxy.example/v1"))).toBe(custom);
		},
	);

	test.each([
		["openai", "gpt-5.5", 200],
		["amazon-bedrock", "us.anthropic.claude-opus-5-5", 90],
		["openrouter", "anthropic/claude-opus-5.5", 90],
	] as const)("%s carries its budget", (provider, id, budget) => {
		expect(imageCountBudget(getBundledModel(provider, id))).toBe(budget);
	});

	test("an unlisted host has no budget", () => {
		const ramp = buildModel({ ...toModelSpec(getBundledModel("anthropic", "claude-opus-5-5")), provider: "ramp" });
		expect(imageCountBudget(ramp)).toBeUndefined();
	});
});

describe("inline-image-byte-budget", () => {
	test("the Codex backend carries 24 MB; a rerouted Codex baseUrl carries none", () => {
		const sol = getBundledModel<"openai-codex-responses">("openai-codex", "gpt-6.1-sol");
		expect(sol.compat.officialEndpoint).toBe(true);
		expect(inlineImageByteBudget(sol)).toBe(24_000_000);
		expect(inlineImageByteBudget(rerouted(sol, "https://chatgpt.com/backend-api/"))).toBe(24_000_000);
		const proxied = rerouted(sol, "https://codex-proxy.example/backend-api");
		expect(proxied.compat.officialEndpoint).toBe(false);
		expect(inlineImageByteBudget(proxied)).toBeUndefined();
	});
});
