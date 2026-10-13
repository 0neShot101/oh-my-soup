import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { YieldTool } from "@oh-my-pi/pi-coding-agent/tools/yield";

function createSession(): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

describe("YieldTool placeholder errors", () => {
	it("preserves untyped data/error conflict resend guidance", async () => {
		const tool = new YieldTool(createSession());
		const failure = await tool.execute("call-both", { data: { ok: true }, error: "boom" } as never).catch(err => err);
		expect(failure).toBeInstanceOf(Error);
		expect(String(failure.message)).toContain("Resubmit exactly one outcome");
		expect(String(failure.message)).toContain(
			'For success, resend the same payload without `error`, keeping the same `type` if you sent one: `{"data":<your output>}`',
		);
		expect(String(failure.message)).toContain('For failure, resend only `{"error":"boom"}`');
	});

	it("accepts data alongside empty or placeholder errors from non-strict OpenAI-compatible backends", async () => {
		for (const error of ["", "   ", "unused", "placeholder", "n/a"]) {
			const tool = new YieldTool(createSession());
			const result = await tool.execute(`call-placeholder-error-${String(error).trim() || "empty"}`, {
				type: "result",
				data: { ok: true },
				error,
			} as never);
			expect(result.details?.status).toBe("success");
			expect(result.details?.data).toEqual({ ok: true });
			expect(result.details?.error).toBeUndefined();
		}

		const structuralTool = new YieldTool(createSession());
		const failure = await structuralTool.execute("call-only-empty-error", { error: "" } as never).catch(err => err);
		expect(failure).toBeInstanceOf(Error);
		expect(String(failure.message)).toContain("yield must contain either `data` or `error`");

		const errorOnlyTool = new YieldTool(createSession());
		const errorOnly = await errorOnlyTool.execute("call-only-placeholder-error", { error: "unused" } as never);
		expect(errorOnly.details?.status).toBe("aborted");
		expect(errorOnly.details?.error).toBe("unused");
	});

	it("rejects data alongside ambiguous error text with exact resend guidance", async () => {
		const tool = new YieldTool(createSession());
		const failure = await tool
			.execute("call-ambiguous-error", {
				type: "result",
				data: { ok: true },
				error: "invalid output shape",
			} as never)
			.catch(err => err);
		expect(failure).toBeInstanceOf(Error);
		expect(String(failure.message)).toContain("non-placeholder error");
		expect(String(failure.message)).toContain(
			'For success, resend the same payload without `error`, keeping the same `type` if you sent one: `{"type":"result","data":<your output>}`',
		);
		expect(String(failure.message)).toContain('For failure, resend only `{"error":"invalid output shape"}`');
	});

	it("preserves incremental yield type in data/error conflict retry guidance", async () => {
		const tool = new YieldTool(createSession());
		const failure = await tool
			.execute("call-incremental-conflict", {
				type: ["findings"],
				data: { title: "real finding" },
				error: "contradictory source",
			} as never)
			.catch(err => err);
		expect(failure).toBeInstanceOf(Error);
		expect(String(failure.message)).toContain(
			'For success, resend the same payload without `error`, keeping the same `type` if you sent one: `{"type":["findings"],"data":<your output>}`',
		);
		expect(String(failure.message)).toContain('For failure, resend only `{"error":"contradictory source"}`');
	});
});
