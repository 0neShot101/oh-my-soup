import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-soup/pi-ai";
import { applyCollabStream, type CollabStreamPatch, diffCollabStream } from "@oh-my-soup/pi-wire/collab-stream";

function message(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function wireCopy<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

describe("collab stream codec", () => {
	it("sends only appended text and retains rich blocks without mutating the baseline", () => {
		const prefix = "existing output ".repeat(1_000);
		const previous = message([
			{ type: "text", text: prefix, textSignature: "answer-signature" },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "notes.txt" }, intent: "Read notes" },
		]);
		const next = {
			...previous,
			content: [{ type: "text", text: `${prefix}new text`, textSignature: "answer-signature" }, previous.content[1]],
		} satisfies AssistantMessage;
		const patch = diffCollabStream(previous, next);
		expect(patch.changes).toEqual([
			{
				index: 0,
				kind: "append",
				field: "text",
				offset: prefix.length,
				text: "new text",
				properties: { type: "text", textSignature: "answer-signature" },
			},
		]);
		expect(JSON.stringify(patch).length).toBeLessThan(prefix.length / 10);
		const applied = applyCollabStream(previous, wireCopy(patch));
		expect(applied).toEqual(next);
		expect(applied?.content).not.toBe(previous.content);
		expect(applied?.content[1]).toBe(previous.content[1]);
		expect(previous.content[0]).toEqual({ type: "text", text: prefix, textSignature: "answer-signature" });
	});

	it("appends thinking while preserving signatures and replacing block metadata exactly", () => {
		const previous = message([
			{
				type: "thinking",
				thinking: "Plan",
				thinkingSignature: "signature-before",
				summary: true,
				narration: true,
			},
		]);
		const next = message([
			{
				type: "thinking",
				thinking: "Plan carefully",
				thinkingSignature: "signature-after",
				itemId: "reasoning-item",
				summary: false,
			},
		]);
		const patch = diffCollabStream(previous, next);
		expect(patch.changes).toEqual([
			{
				index: 0,
				kind: "append",
				field: "thinking",
				offset: 4,
				text: " carefully",
				properties: {
					type: "thinking",
					thinkingSignature: "signature-after",
					itemId: "reasoning-item",
					summary: false,
				},
			},
		]);
		const applied = applyCollabStream(previous, wireCopy(patch));
		expect(applied).toEqual(next);
		expect(applied?.content[0]).not.toHaveProperty("narration");
	});

	it("replaces non-append corrections and shortened text or thinking blocks", () => {
		const previous = message([
			{ type: "text", text: "incorrect answer", textSignature: "old-answer" },
			{ type: "thinking", thinking: "long reasoning", thinkingSignature: "old-reasoning" },
		]);
		const next = message([
			{ type: "text", text: "corrected answer", textSignature: "corrected-answer" },
			{ type: "thinking", thinking: "long", thinkingSignature: "short-reasoning" },
		]);
		const patch = diffCollabStream(previous, next);
		expect(patch.changes).toEqual(next.content.map((value, index) => ({ index, kind: "replace", value })));
		expect(applyCollabStream(previous, wireCopy(patch))).toEqual(next);
	});

	it("replaces changed block types and tool arguments and appends new blocks", () => {
		const previous = message([
			{ type: "thinking", thinking: "Look up the file" },
			{
				type: "toolCall",
				id: "call-1",
				name: "read",
				arguments: { path: "old.txt" },
				thoughtSignature: "tool-signature",
			},
		]);
		const next = message([
			{ type: "text", text: "Reading the file", textSignature: "answer-signature" },
			{
				type: "toolCall",
				id: "call-1",
				name: "read",
				arguments: { path: "new.txt", options: { raw: true } },
				thoughtSignature: "tool-signature",
				intent: "Inspect the complete file",
			},
			{ type: "image", mimeType: "image/png", data: "encoded-image" },
		]);
		const patch = diffCollabStream(previous, next);
		expect(patch.contentLength).toBe(3);
		expect(patch.changes.map(change => change.kind)).toEqual(["replace", "replace", "replace"]);
		expect(applyCollabStream(previous, wireCopy(patch))).toEqual(next);
		expect(previous.content).toHaveLength(2);
	});

	it("truncates the content array and can remove all blocks without retaining old content", () => {
		const previous = message([
			{ type: "thinking", thinking: "Plan" },
			{ type: "text", text: "Answer" },
		]);
		const next = { ...previous, content: previous.content.slice(0, 1) };
		const patch = diffCollabStream(previous, next);
		expect(patch).toMatchObject({ contentLength: 1, changes: [] });
		expect(applyCollabStream(previous, wireCopy(patch))).toEqual(next);
		const empty = { ...next, content: [] };
		expect(applyCollabStream(next, wireCopy(diffCollabStream(next, empty)))).toEqual(empty);
		expect(previous.content).toHaveLength(2);
	});

	it("replaces message metadata including removed optional fields without resending unchanged content", () => {
		const previous = message([{ type: "text", text: "answer", textSignature: "stable-signature" }]);
		previous.responseId = "old-response";
		previous.errorMessage = "transient error";
		const next = message(previous.content);
		next.model = "actual-model";
		next.upstreamModel = "routed-model";
		next.usage = { ...next.usage, output: 31, totalTokens: 31 };
		next.stopReason = "toolUse";
		const patch = diffCollabStream(previous, next);
		expect(patch.changes).toEqual([]);
		expect(patch.metadata).not.toHaveProperty("content");
		const applied = applyCollabStream(previous, wireCopy(patch));
		expect(applied).toEqual(next);
		expect(applied).not.toHaveProperty("responseId");
		expect(applied).not.toHaveProperty("errorMessage");
		expect(applied?.content[0]).toBe(previous.content[0]);
	});

	it("updates signature-only block metadata with an empty append", () => {
		const previous = message([{ type: "text", text: "answer", textSignature: "old-signature" }]);
		const next = message([{ type: "text", text: "answer", textSignature: "final-signature" }]);
		const patch = diffCollabStream(previous, next);
		expect(patch.changes).toEqual([
			{
				index: 0,
				kind: "append",
				field: "text",
				offset: 6,
				text: "",
				properties: { type: "text", textSignature: "final-signature" },
			},
		]);
		expect(applyCollabStream(previous, wireCopy(patch))).toEqual(next);
	});

	it.each(["text", "thinking"] as const)("keeps UTF-16 offsets for split non-BMP %s across JSON transport", field => {
		const block = (text: string): AssistantMessage["content"][number] =>
			field === "text"
				? { type: "text", text, textSignature: "signature" }
				: { type: "thinking", thinking: text, thinkingSignature: "signature" };
		let text = "prefix\ud83d";
		let previous = wireCopy(message([block(text)]));
		for (const suffix of ["\ude80", "\ud834", "\udd1e", " final"]) {
			const offset = text.length;
			text += suffix;
			const next = message([block(text)]);
			const patch = wireCopy(diffCollabStream(previous, next));
			expect(patch.changes).toHaveLength(1);
			expect(patch.changes[0]).toMatchObject({ kind: "append", field, offset, text: suffix });
			const applied = applyCollabStream(previous, patch);
			expect(applied).toEqual(next);
			if (!applied) throw new Error("Expected complete Unicode stream");
			previous = applied;
		}
	});

	it("preserves provider-specific content and metadata not modeled by the browser", () => {
		const previous = {
			content: [{ type: "provider-block", payload: { data: [1], nested: { signature: "opaque" } } }],
			providerMetadata: { request: "first" },
		};
		const next = {
			content: [{ type: "provider-block", payload: { data: [1, 2], nested: { signature: "opaque-final" } } }],
			providerMetadata: { request: "second" },
		};
		expect(applyCollabStream(previous, wireCopy(diffCollabStream(previous, next)))).toEqual(next);
	});

	it("rejects append offset mismatches and missing or wrong-kind baseline blocks", () => {
		const previous = message([{ type: "text", text: "before" }]);
		const next = message([{ type: "text", text: "before after" }]);
		const patch = wireCopy(diffCollabStream(previous, next));
		expect(applyCollabStream(message([{ type: "text", text: "short" }]), patch)).toBeNull();
		expect(applyCollabStream(message([]), patch)).toBeNull();
		expect(applyCollabStream(message([{ type: "thinking", thinking: "before" }]), patch)).toBeNull();
		expect(applyCollabStream(next, patch)).toBeNull();
		expect(applyCollabStream(previous, patch)).toEqual(next);
	});

	it("rejects missing blocks rather than accepting a sparse reconstructed baseline", () => {
		const patch: CollabStreamPatch = {
			metadata: { role: "assistant" },
			contentLength: 2,
			changes: [{ index: 1, kind: "replace", value: { type: "text", text: "missing predecessor" } }],
		};
		expect(applyCollabStream(message([]), wireCopy(patch))).toBeNull();
		expect(applyCollabStream(message([]), { ...patch, changes: [] })).toBeNull();
		expect(
			applyCollabStream(message([]), {
				...patch,
				changes: [{ index: 2, kind: "replace", value: { type: "text", text: "out of bounds" } }],
			}),
		).toBeNull();
	});
});
