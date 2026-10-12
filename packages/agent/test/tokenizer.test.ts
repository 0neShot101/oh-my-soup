import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as natives from "@oh-my-pi/pi-natives";
import { Tokenizer, tokenizerEncodingForModel } from "../src/tokenizer";
import type { AgentMessage } from "../src/types";

afterEach(() => {
	vi.restoreAllMocks();
});

// Contract: the catalog resolves model identity once as Model.tokenizer; the
// agent maps that catalog property to the matching native counter. A wrong
// row silently skews every context-budget and compaction decision.
describe("tokenizerEncodingForModel", () => {
	test("maps every catalog tokenizer family to its native counter", () => {
		expect(tokenizerEncodingForModel({ tokenizer: "claude-v3" })).toBe(natives.Encoding.ClaudeV3);
		expect(tokenizerEncodingForModel({ tokenizer: "claude-v47" })).toBe(natives.Encoding.ClaudeV47);
		expect(tokenizerEncodingForModel({ tokenizer: "claude-v5" })).toBe(natives.Encoding.ClaudeV5);
		expect(tokenizerEncodingForModel({ tokenizer: "claude-v5-sonnet" })).toBe(natives.Encoding.ClaudeV5Sonnet);
		expect(tokenizerEncodingForModel({ tokenizer: "qwen3" })).toBe(natives.Encoding.Qwen3);
		expect(tokenizerEncodingForModel({ tokenizer: "deepseek-v3" })).toBe(natives.Encoding.DeepSeekV3);
		expect(tokenizerEncodingForModel({ tokenizer: "kimi-k2" })).toBe(natives.Encoding.KimiK2);
		expect(tokenizerEncodingForModel({ tokenizer: "glm5" })).toBe(natives.Encoding.Glm5);
	});

	test("leaves unknown catalog models on the estimate policy", () => {
		expect(tokenizerEncodingForModel({})).toBeNull();
		expect(tokenizerEncodingForModel(undefined)).toBeNull();
	});
});

describe("Tokenizer", () => {
	test("defaults to null encoding and byte estimation", () => {
		const tokenizer = new Tokenizer();
		expect(tokenizer.encoding).toBeNull();
		expect(tokenizer.countTokens("hello world")).toBe(3);
	});

	test("separate instances do not interfere with each other", () => {
		const t1 = new Tokenizer({ tokenizer: "claude-v47" });
		const t2 = new Tokenizer({ tokenizer: "qwen3" });
		const t3 = new Tokenizer({});

		expect(t1.encoding).toBe(natives.Encoding.ClaudeV47);
		expect(t2.encoding).toBe(natives.Encoding.Qwen3);
		expect(t3.encoding).toBeNull();

		const t4 = new Tokenizer({ tokenizer: "claude-v3" });
		expect(t4.encoding).toBe(natives.Encoding.ClaudeV3);
		expect(t1.encoding).toBe(natives.Encoding.ClaudeV47);
		expect(t2.encoding).toBe(natives.Encoding.Qwen3);
		expect(t3.encoding).toBeNull();
	});
});

describe("countTokens with modes", () => {
	test("approximate mode uses fast estimation", () => {
		const tokenizer = new Tokenizer();
		expect(tokenizer.countTokens("hello world", "approximate")).toBe(3);
	});

	test("upperbound mode uses byte length", () => {
		const tokenizer = new Tokenizer();
		expect(tokenizer.countTokens("hello world", "upperbound")).toBe(11);
	});

	test("strict mode uses native counting regardless of encoding", () => {
		const noEncoding = new Tokenizer();
		expect(noEncoding.countTokens("hello world", "strict")).toBe(2);
		expect(noEncoding.countTokens("hello world", "approximate")).toBe(3);
		expect(noEncoding.countTokens("hello world", "upperbound")).toBe(11);
		const claudeEncoding = new Tokenizer({ tokenizer: "claude-v47" });
		expect(claudeEncoding.countTokens("hello world", "strict")).toBeGreaterThan(0);
	});

	test("mode is per-call; encoding stays independently model-scoped in strict mode", () => {
		// approximate/upperbound skip the encoding entirely under NODE_ENV=test
		// (fast estimate for a snappy suite); strict is testEnv-independent, so
		// it is the mode that proves per-instance encoding isolation here.
		const claude = new Tokenizer({ tokenizer: "claude-v47" });
		const generic = new Tokenizer({});
		expect(claude.countTokens("hello world", "strict")).not.toBe(generic.countTokens("hello world", "strict"));
	});

	test("counts current fragment values without merging boundaries or retaining mutable arrays", () => {
		const tokenizer = new Tokenizer();
		const fragments = ["hel", "lo", "こんにちは 🌏", "e\u0301\u0000\ud800", ""];
		const initial = natives.countTokens(fragments);
		expect(tokenizer.countTokens(fragments, "strict")).toBe(initial);
		expect(tokenizer.countTokens([...fragments], "strict")).toBe(initial);
		for (const fragment of fragments) {
			expect(tokenizer.countTokens(fragment, "strict")).toBe(natives.countTokens(fragment));
		}

		fragments[1] = "changed streaming content";
		fragments.push("hel");
		expect(tokenizer.countTokens(fragments, "strict")).toBe(natives.countTokens(fragments));
		fragments.splice(0, 4);
		expect(tokenizer.countTokens(fragments, "strict")).toBe(natives.countTokens(fragments));
		fragments.length = 0;
		expect(tokenizer.countTokens(fragments, "strict")).toBe(0);
	});

	test("falls back conservatively when native encoding is unknown", () => {
		const nativeCount = vi.spyOn(natives, "countTokens").mockImplementation(() => {
			throw new Error('value "DeepSeekV3" does not match any variant of enum Encoding');
		});
		const tokenizer = new Tokenizer({ tokenizer: "deepseek-v3" });
		expect(tokenizer.countTokens("hello world", "strict")).toBe(11);
		expect(tokenizer.countTokens("hello world", "upperbound")).toBe(11);
		expect(tokenizer.checkTokenBudget("x".repeat(40), 20)).toEqual({
			fits: false,
			tokens: 40,
			exact: false,
		});
		expect(tokenizer.checkTokenBudget([], -1)).toEqual({ fits: false, tokens: 0, exact: false });

		// A failed native attempt must never seed an "exact" fallback entry.
		nativeCount.mockRestore();
		const exact = natives.countTokens("hello world", tokenizer.encoding);
		expect(tokenizer.countTokens("hello world", "strict")).toBe(exact);
		expect(tokenizer.checkTokenBudget("hello world", 0)).toEqual({
			fits: false,
			tokens: exact,
			exact: true,
		});
	});

	test("does not swallow unrelated native tokenizer errors", () => {
		vi.spyOn(natives, "countTokens").mockImplementation(() => {
			throw new Error("native tokenizer exploded");
		});
		const tokenizer = new Tokenizer({ tokenizer: "deepseek-v3" });
		expect(() => tokenizer.countTokens("hello world", "strict")).toThrow("native tokenizer exploded");
		expect(() => tokenizer.countTokens(["hello world"], "strict")).toThrow("native tokenizer exploded");
	});
});

// Contract: countMessage charges for every part of a message the provider will
// bill for. A role or block type the switch does not name reads as free, and the
// transcript, pruning and compaction math built on these numbers then plans
// against a context window larger than the real one.
describe("countMessage", () => {
	const TEXT = "x".repeat(4000);
	const IMAGE = { type: "image", data: "A".repeat(40_000), mimeType: "image/png" };

	test("counts a developer message like the user message it mirrors", () => {
		const tokenizer = new Tokenizer();
		const user = tokenizer.countMessage({ role: "user", content: TEXT, timestamp: 0 } as AgentMessage);
		const developer = tokenizer.countMessage({ role: "developer", content: TEXT, timestamp: 0 } as AgentMessage);

		expect(user).toBeGreaterThan(0);
		// developer is a core role: convertMessageToLlm ships it to the provider next
		// to user. It used to miss the switch and land on `default: return 0`.
		expect(developer).toBe(user);
	});

	test("charges the image estimate on user and developer content, as tool results do", () => {
		const tokenizer = new Tokenizer();
		const inToolResult = tokenizer.countMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [IMAGE],
			isError: false,
			timestamp: 0,
		} as unknown as AgentMessage);

		expect(inToolResult).toBeGreaterThan(0);
		expect(tokenizer.countMessage({ role: "user", content: [IMAGE], timestamp: 0 } as unknown as AgentMessage)).toBe(
			inToolResult,
		);
		expect(
			tokenizer.countMessage({ role: "developer", content: [IMAGE], timestamp: 0 } as unknown as AgentMessage),
		).toBe(inToolResult);
	});

	test("adds the image estimate on top of the text beside it", () => {
		const tokenizer = new Tokenizer();
		const textOnly = tokenizer.countMessage({
			role: "user",
			content: [{ type: "text", text: TEXT }],
			timestamp: 0,
		} as AgentMessage);
		const withImage = tokenizer.countMessage({
			role: "user",
			content: [{ type: "text", text: TEXT }, IMAGE],
			timestamp: 0,
		} as unknown as AgentMessage);

		expect(textOnly).toBeGreaterThan(0);
		expect(withImage).toBe(textOnly + inToolResultImageEstimate(tokenizer));
	});
});

// Contract: a replayed signed thinking block costs what the reading model bills
// for it: Claude rebuilds the full reasoning from the signature and bills it at
// the size the turn billed as output; other readers are charged the
// signature's bytes.
describe("countMessage replayed thinking", () => {
	const SIGNATURE = "s".repeat(4000);
	const VISIBLE = "Check the call sites first.";
	// What the visible blocks count to in the test env (bytes/4 per fragment).
	const VISIBLE_TOKENS = 9;
	const OUTPUT_TOKENS = 3000;

	function reader(provider: "anthropic" | "openrouter" | "amazon-bedrock" | "google", id: string): Model {
		const model = getBundledModel(provider, id);
		if (!model) throw new Error(`missing bundled model ${provider}/${id}`);
		return model as Model;
	}

	function signedTurn(
		from: Pick<Model, "api" | "provider" | "id">,
		thinking: string,
		thinkingSignature?: string,
	): AssistantMessage {
		return {
			role: "assistant",
			content: [
				{ type: "thinking", thinking, thinkingSignature },
				{ type: "text", text: "Done." },
			],
			api: from.api,
			provider: from.provider,
			model: from.id,
			usage: {
				input: 100,
				output: OUTPUT_TOKENS,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 100 + OUTPUT_TOKENS,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		};
	}

	test.each([
		["anthropic", "claude-opus-5-5", VISIBLE],
		["amazon-bedrock", "global.anthropic.claude-opus-5-5", VISIBLE],
		// Omitted display: no visible thinking, the same reasoning billed.
		["anthropic", "claude-opus-5-5", ""],
	] as const)("charges a Claude turn replayed natively on %s (%s) its output size", (provider, id, thinking) => {
		const model = reader(provider, id);
		expect(new Tokenizer(model).countMessage(signedTurn(model, thinking, SIGNATURE))).toBe(OUTPUT_TOKENS);
	});

	test.each([
		// Signatures are model-bound: another model's turn replays its thinking as text.
		[
			"a turn from another Claude model",
			reader("anthropic", "claude-opus-5-5"),
			reader("anthropic", "claude-opus-5"),
		],
		// OpenRouter filters reasoning history out of the request.
		[
			"a reader that filters reasoning history",
			reader("openrouter", "~anthropic/claude-opus-latest"),
			reader("openrouter", "~anthropic/claude-opus-latest"),
		],
	] as const)("charges only the visible blocks for %s, never the signature", (_case, model, from) => {
		expect(new Tokenizer(model).countMessage(signedTurn(from, VISIBLE, SIGNATURE))).toBe(VISIBLE_TOKENS);
	});

	test("keeps the compaction floor at the visible blocks of a native Claude replay", () => {
		const model = reader("anthropic", "claude-opus-5-5");
		const floored = new Tokenizer(model).countMessage(signedTurn(model, VISIBLE, SIGNATURE), {
			excludeEncryptedReasoning: true,
		});
		expect(floored).toBe(VISIBLE_TOKENS);
	});

	test("charges the signature's bytes for a reader whose catalog prices them", () => {
		const model = reader("google", "gemini-3-pro-preview");
		expect(new Tokenizer(model).countMessage(signedTurn(model, VISIBLE, SIGNATURE))).toBe(VISIBLE_TOKENS + 1000);
	});
});

/** The per-image charge, read back through the arm that already applied it. */
function inToolResultImageEstimate(tokenizer: Tokenizer): number {
	return tokenizer.countMessage({
		role: "toolResult",
		toolCallId: "call-probe",
		toolName: "read",
		content: [{ type: "image", data: "A".repeat(40_000), mimeType: "image/png" }],
		isError: false,
		timestamp: 0,
	} as unknown as AgentMessage);
}
