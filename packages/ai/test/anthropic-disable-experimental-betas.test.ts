import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { withEnv } from "./helpers";

/** The model from the gateway report: `thinking.adaptive.block_binding: Extra inputs are not permitted`. */
function sonnet55(): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-sonnet-5-5",
		name: "claude-sonnet-5-5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	});
}

interface CapturedRequest {
	url: string;
	body: { thinking?: { type: string; block_binding?: unknown }; context_management?: unknown };
	beta: string;
}

async function gatewayRequest(): Promise<CapturedRequest> {
	let captured: CapturedRequest | undefined;
	await streamAnthropic(
		sonnet55(),
		{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
		{
			apiKey: "sk-ant-api-test",
			thinkingEnabled: true,
			reasoning: Effort.High,
			fetch: async (url, init) => {
				captured ??= {
					url: String(url),
					body: JSON.parse(String(init?.body)),
					beta: new Headers(init?.headers).get("anthropic-beta") ?? "",
				};
				return Response.json({ error: { type: "invalid_request_error", message: "captured" } }, { status: 400 });
			},
		},
	).result();
	if (!captured) throw new Error("expected a captured request");
	return captured;
}

describe("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", () => {
	it("withholds block_binding and context_management (and their betas) on an ANTHROPIC_BASE_URL gateway", async () => {
		const gateway = { CLAUDE_CODE_USE_FOUNDRY: undefined, ANTHROPIC_BASE_URL: "https://llm-gateway.example.com" };

		await withEnv({ ...gateway, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: undefined }, async () => {
			const enabled = await gatewayRequest();
			expect(enabled.url.startsWith("https://llm-gateway.example.com")).toBe(true);
			expect(enabled.body.thinking?.block_binding).toEqual({ prefix_mismatch_behavior: "drop_block" });
			expect(enabled.body.context_management).toBeDefined();
			expect(enabled.beta).toContain("thinking-binding-controls-2026-08-01");
			expect(enabled.beta).toContain("context-management-2025-06-27");
		});

		await withEnv({ ...gateway, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" }, async () => {
			const disabled = await gatewayRequest();
			expect(disabled.body.thinking?.type).toBe("adaptive");
			expect(disabled.body.thinking?.block_binding).toBeUndefined();
			expect(disabled.body.context_management).toBeUndefined();
			expect(disabled.beta).not.toContain("thinking-binding-controls-2026-08-01");
			expect(disabled.beta).not.toContain("context-management-2025-06-27");
		});
	});
});
