import { describe, expect, it } from "bun:test";
import { type AnthropicOptions, streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { withEnv } from "./helpers";

const BINDING_BETA = "thinking-binding-controls-2026-08-01";
const CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27";
const GATEWAY_ENV = { CLAUDE_CODE_USE_FOUNDRY: undefined, ANTHROPIC_BASE_URL: "https://llm-gateway.example.com" };

/**
 * Defaults to the model from the gateway report:
 * `thinking.adaptive.block_binding: Extra inputs are not permitted`.
 */
function anthropicModel(id = "claude-sonnet-5-5"): Model<"anthropic-messages"> {
	return buildModel({
		id,
		name: id,
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
	body: {
		thinking?: { type: string; block_binding?: unknown };
		context_management?: unknown;
		fallback_credit_token?: string;
		messages?: unknown;
	};
	beta: string;
}

async function captureRequest(
	model: Model<"anthropic-messages">,
	extra: AnthropicOptions = {},
	messages: Context["messages"] = [{ role: "user", content: "hi", timestamp: 1 }],
): Promise<CapturedRequest> {
	let captured: CapturedRequest | undefined;
	await streamAnthropic(
		model,
		{ messages },
		{
			apiKey: "sk-ant-api-test",
			thinkingEnabled: true,
			reasoning: Effort.High,
			...extra,
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
		await withEnv({ ...GATEWAY_ENV, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: undefined }, async () => {
			const enabled = await captureRequest(anthropicModel());
			expect(enabled.url.startsWith("https://llm-gateway.example.com")).toBe(true);
			expect(enabled.body.thinking?.block_binding).toEqual({ prefix_mismatch_behavior: "drop_block" });
			expect(enabled.body.context_management).toBeDefined();
			expect(enabled.beta).toContain(BINDING_BETA);
			expect(enabled.beta).toContain(CONTEXT_MANAGEMENT_BETA);
		});

		await withEnv({ ...GATEWAY_ENV, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" }, async () => {
			const disabled = await captureRequest(anthropicModel());
			expect(disabled.body.thinking?.type).toBe("adaptive");
			expect(disabled.body.thinking?.block_binding).toBeUndefined();
			expect(disabled.body.context_management).toBeUndefined();
			expect(disabled.beta).not.toContain(BINDING_BETA);
			expect(disabled.beta).not.toContain(CONTEXT_MANAGEMENT_BETA);
		});
	});

	it("strips the withheld betas from caller-supplied options.betas", async () => {
		await withEnv({ ...GATEWAY_ENV, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" }, async () => {
			const request = await captureRequest(anthropicModel(), {
				betas: [BINDING_BETA, CONTEXT_MANAGEMENT_BETA, "custom-beta-2026-01-01"],
			});
			expect(request.beta).not.toContain(BINDING_BETA);
			expect(request.beta).not.toContain(CONTEXT_MANAGEMENT_BETA);
			expect(request.beta).toContain("custom-beta-2026-01-01");
		});
	});

	it("strips the withheld betas from caller headers an injected client's per-request betas merge into", async () => {
		await withEnv({ CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" }, async () => {
			let beta = "";
			await streamAnthropic(
				anthropicModel(),
				{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
				{
					apiKey: "sk-ant-api-test",
					thinkingEnabled: true,
					reasoning: Effort.High,
					headers: { "anthropic-beta": `${BINDING_BETA},${CONTEXT_MANAGEMENT_BETA},custom-beta-2026-01-01` },
					client: {
						messages: {
							create: (_value, requestOptions) => {
								beta = new Headers(requestOptions?.headers).get("anthropic-beta") ?? "";
								throw new Error("captured");
							},
						},
					},
				},
			).result();
			// The effort beta proves the per-request merge ran over the caller header.
			expect(beta).toContain("effort-2025-11-24");
			expect(beta).toContain("custom-beta-2026-01-01");
			expect(beta).not.toContain(BINDING_BETA);
			expect(beta).not.toContain(CONTEXT_MANAGEMENT_BETA);
		});
	});

	it("forfeits a fallback-credit redemption frozen with withheld fields and builds a fresh request", async () => {
		await withEnv({ ...GATEWAY_ENV, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" }, async () => {
			const request = await captureRequest(anthropicModel(), {
				fallbackCreditRedemption: {
					token: "fct_frozen",
					prefillClaim: false,
					params: {
						model: "claude-fable-5-1",
						messages: [{ role: "user", content: "hi" }],
						stream: true,
						thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
						context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
					},
					betas: [BINDING_BETA, CONTEXT_MANAGEMENT_BETA],
					expiresAt: Date.now() + 60_000,
				},
			});
			expect(request.body.fallback_credit_token).toBeUndefined();
			expect(request.body.thinking?.block_binding).toBeUndefined();
			expect(request.body.context_management).toBeUndefined();
			expect(request.beta).not.toContain(BINDING_BETA);
			expect(request.beta).not.toContain(CONTEXT_MANAGEMENT_BETA);
		});
	});

	it("leaves non-Anthropic providers' context_management intact (#3288)", async () => {
		const zai = buildModel({
			id: "glm-4.6",
			name: "GLM 4.6",
			api: "anthropic-messages",
			provider: "zai",
			baseUrl: "https://api.z.ai/api/anthropic",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 128_000,
		});
		await withEnv({ CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" }, async () => {
			const request = await captureRequest(zai);
			expect(request.body.context_management).toEqual({ edits: [{ type: "clear_thinking_20251015", keep: "all" }] });
			expect(request.beta).toContain(CONTEXT_MANAGEMENT_BETA);
		});
	});

	it("replays a legacy encrypted compaction summary as text, without its context_management edit", async () => {
		const fable = anthropicModel("claude-fable-5");
		const summary = "## Goal\nAudit the handlers.";
		const messages: Context["messages"] = [
			{
				role: "user",
				content: `<summary>${summary}</summary>`,
				providerPayload: {
					type: "anthropicCompaction",
					provider: "anthropic",
					content: summary,
					exactTail: true,
					encryptedContent: "enc_opaque_legacy",
				},
				timestamp: 1,
			},
			{ role: "user", content: "next", timestamp: 2 },
		];
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: undefined,
				ANTHROPIC_BASE_URL: undefined,
				CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
			},
			async () => {
				const request = await captureRequest(fable, {}, messages);
				expect(request.body.context_management).toBeUndefined();
				expect(request.beta).not.toContain("compact-2026-01-12");
				expect(JSON.stringify(request.body.messages)).not.toContain("enc_opaque_legacy");
				expect(JSON.stringify(request.body.messages)).toContain("<summary>");
			},
		);
	});
});
