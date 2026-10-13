import { describe, expect, it, spyOn } from "bun:test";
import { buildModel } from "../src/build";
import { calculateUsageCost, getTimeBasedPricingPeriod } from "../src/models";
import type { Api, Model, ModelSpec, Provider, TokenCost } from "../src/types";

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

function buildAt(timestamp: number, spec: ModelSpec<Api>): Model<Api> {
	const clock = spyOn(Date, "now").mockReturnValue(timestamp);
	try {
		return buildModel(spec);
	} finally {
		clock.mockRestore();
	}
}

function costAt(timestamp: number, spec: ModelSpec<Api>): TokenCost {
	const { input, output, cacheRead, cacheWrite } = buildAt(timestamp, spec).cost;
	return { input, output, cacheRead, cacheWrite };
}

/** Rates billed for a request at `timestamp`: one million tokens in each priced bucket. */
function billedAt(model: Model<Api>, timestamp: number): TokenCost {
	const usage = {
		input: 1_000_000,
		output: 1_000_000,
		cacheRead: 1_000_000,
		cacheWrite: 0,
		totalTokens: 3_000_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const { input, output, cacheRead, cacheWrite } = calculateUsageCost(model.cost, usage, timestamp);
	return { input, output, cacheRead, cacheWrite };
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

	it("bills each request at the card in force when it was made, whenever the row was built", () => {
		const spec = argon("google", "google-generative-ai", INTRO);
		// A row built before the switch (bundled, cached, or held by a long session) bills later requests at list.
		const early = buildAt(SWITCH - 1, spec);
		expect(billedAt(early, SWITCH - 1)).toEqual(INTRO);
		expect(billedAt(early, SWITCH)).toEqual(LIST);
		// A row built after it still bills earlier requests at the introductory price.
		const late = buildAt(SWITCH, spec);
		expect(billedAt(late, SWITCH - 1)).toEqual(INTRO);
		expect(billedAt(late, SWITCH)).toEqual(LIST);
		// A dated change is not a peak/off-peak tariff.
		expect(getTimeBasedPricingPeriod(early.cost, SWITCH)).toBeUndefined();
	});

	it("leaves resellers that publish their own Argon price untouched", () => {
		const openrouter = argon("openrouter", "openrouter", INTRO, "google/gemini-4-argon");
		expect(costAt(SWITCH, openrouter)).toEqual(INTRO);
	});
});
