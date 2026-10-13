import { describe, expect, it, spyOn } from "bun:test";
import { buildModel } from "../src/build";
import type { Api, ModelSpec, Provider, TokenCost } from "../src/types";

const INTRO = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 };
const LIST = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 };
const UNPRICED = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
// Midnight US Pacific (PST) on 2026-12-01, when Cloud Billing's day starts.
const SWITCH = Date.parse("2026-12-01T08:00:00Z");

function argon(provider: Provider, api: Api, cost: TokenCost, id = "gemini-4-argon"): ModelSpec<Api> {
	return {
		id,
		name: "Gemini 4 Argon",
		api,
		provider,
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text", "image"],
		cost,
		contextWindow: 1_048_576,
		maxTokens: 65_536,
	};
}

function costAt(timestamp: number, spec: ModelSpec<Api>): TokenCost {
	const clock = spyOn(Date, "now").mockReturnValue(timestamp);
	try {
		const { input, output, cacheRead, cacheWrite } = buildModel(spec).cost;
		return { input, output, cacheRead, cacheWrite };
	} finally {
		clock.mockRestore();
	}
}

describe("Gemini 4 Argon list-price schedule", () => {
	it("moves Google-billed hosts to the $4/$20 list price at the switch, over any upstream price", () => {
		const hosts: [ModelSpec<Api>, TokenCost][] = [
			// stencil.so's introductory price stays until the switch, then is overridden.
			[argon("google", "google-generative-ai", INTRO), INTRO],
			[argon("google-vertex", "google-vertex", INTRO), INTRO],
			// Antigravity discovery is unpriced; the bundled pricing peer covers it until the switch.
			[argon("google-antigravity", "google-gemini-cli", UNPRICED), UNPRICED],
			// Cursor bills Other Models at the model's API price.
			[argon("cursor", "cursor-agent", UNPRICED), INTRO],
		];
		for (const [spec, before] of hosts) {
			expect(costAt(SWITCH - 1, spec), `${spec.provider} before`).toEqual(before);
			expect(costAt(SWITCH, spec), `${spec.provider} after`).toEqual(LIST);
		}
	});

	it("leaves resellers that publish their own Argon price untouched", () => {
		const openrouter = argon("openrouter", "openrouter", INTRO, "google/gemini-4-argon");
		expect(costAt(SWITCH, openrouter)).toEqual(INTRO);
	});
});
