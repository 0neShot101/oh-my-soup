import { describe, expect, it } from "bun:test";
import type { AssistantMessage, SessionEntry } from "@oh-my-soup/pi-wire";
import { renderToStaticMarkup } from "react-dom/server";
import "./transcript-dom-shim";
import {
	followTranscriptTail,
	Transcript,
	type TranscriptProps,
	transcriptWindow,
	updateTranscriptTailLock,
} from "../src/components/transcript/Transcript";
import type { ActiveTool } from "../src/lib/client";

const TOOL_CALL_ID = "call-running-tool";
const TOOL_NAME = "probe_tool";

const RAW_ASSISTANT_TARGET = "stale-raw-assistant-target";
const ACTIVE_TOOL_TARGET = "effective-active-tool-target";

function assistantUsage(): AssistantMessage["usage"] {
	return { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } };
}

function committedAssistantToolCall(): SessionEntry {
	return {
		type: "message",
		id: "assistant-entry-1",
		parentId: null,
		timestamp: "2026-07-09T00:00:00Z",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "I will run the tool." },
				{
					type: "toolCall",
					id: TOOL_CALL_ID,
					name: TOOL_NAME,
					arguments: { target: RAW_ASSISTANT_TARGET },
					intent: "Inspect fixture input",
				},
			],
			model: "test/model",
			usage: assistantUsage(),
			stopReason: "stop",
			timestamp: 1,
		},
	};
}

function activeTool(): ActiveTool {
	return {
		toolCallId: TOOL_CALL_ID,
		toolName: TOOL_NAME,
		args: { target: ACTIVE_TOOL_TARGET },
		intent: "Inspect fixture input",
		startedAt: 1,
	};
}

function renderTranscript(props: Partial<TranscriptProps> & { working: boolean }): string {
	return renderToStaticMarkup(
		<Transcript
			entries={props.entries ?? []}
			stream={props.stream ?? null}
			streamDone={props.streamDone ?? true}
			activeTools={props.activeTools ?? new Map()}
			working={props.working}
			atLatest={props.atLatest}
			compact={props.compact}
		/>,
	);
}

function countElements(html: string, selector: string): number {
	let count = 0;
	new HTMLRewriter()
		.on(selector, {
			element() {
				count++;
			},
		})
		.transform(html);
	return count;
}

function countOccurrences(text: string, needle: string): number {
	let count = 0;
	let start = 0;
	while (true) {
		const index = text.indexOf(needle, start);
		if (index === -1) return count;
		count++;
		start = index + needle.length;
	}
}

describe("Transcript live tool rendering", () => {
	it("renders one running card for a committed tool call using active args without the working shimmer", () => {
		const html = renderTranscript({
			entries: [committedAssistantToolCall()],
			activeTools: new Map([[TOOL_CALL_ID, activeTool()]]),
			working: true,
		});

		expect(countElements(html, ".tv-card")).toBe(1);
		expect(countElements(html, '[aria-label="running"]')).toBe(1);
		expect(countOccurrences(html, TOOL_NAME)).toBe(1);
		expect(html).not.toContain("thinking…");
		expect(html).toContain(ACTIVE_TOOL_TARGET);
		expect(html).not.toContain(RAW_ASSISTANT_TARGET);
	});

	it("keeps the working shimmer when no tool is active", () => {
		const html = renderTranscript({ working: true, activeTools: new Map() });

		expect(html).toContain("thinking…");
	});
});

describe("Transcript message Markdown", () => {
	it("renders host strings and guest text blocks as Markdown", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "host-markdown",
				parentId: null,
				timestamp: "2026-07-15T00:00:00Z",
				message: {
					role: "user",
					content: "Use `381866285601915778`",
					timestamp: 1,
				},
			},
			{
				type: "custom_message",
				id: "guest-markdown",
				parentId: "host-markdown",
				timestamp: "2026-07-15T00:00:01Z",
				customType: "collab-prompt",
				content: [{ type: "text", text: "Guest uses **Markdown**" }],
				details: { from: "guest" },
				display: true,
			},
		];

		const html = renderTranscript({ entries, working: false });

		expect(countElements(html, ".tr-row--user .tr-md code")).toBe(1);
		expect(countElements(html, ".tr-row--user .tr-md strong")).toBe(1);
	});
});

describe("Transcript tail-follow scroll operations", () => {
	it("restores tail-follow when a connection becomes live", () => {
		const element = { scrollTop: 0, scrollHeight: 1_000, clientHeight: 200 };
		const lock = { current: false };

		followTranscriptTail(element, lock, true);
		expect(lock.current).toBe(true);
		expect(element.scrollTop).toBe(1_000);

		element.scrollTop = 600;
		updateTranscriptTailLock(element, lock);
		expect(lock.current).toBe(false);

		element.scrollHeight = 1_200;
		followTranscriptTail(element, lock);
		expect(element.scrollTop).toBe(600);

		followTranscriptTail(element, lock, true);
		expect(lock.current).toBe(true);
		expect(element.scrollTop).toBe(1_200);
	});
});

describe("Transcript windowing", () => {
	it("mounts only the newest 100 entries and offers the rest", () => {
		const entries: SessionEntry[] = Array.from({ length: 250 }, (_, i) => ({
			type: "message",
			id: `m${i}`,
			parentId: i === 0 ? null : `m${i - 1}`,
			timestamp: "2026-07-15T00:00:00Z",
			message: { role: "user", content: `message-${i}-end`, timestamp: i },
		}));

		const html = renderTranscript({ entries, working: false });

		expect(countElements(html, ".tr-row--user")).toBe(100);
		expect(html).toContain("message-249-end");
		expect(html).toContain("message-150-end");
		expect(html).not.toContain("message-149-end");
		expect(html).toContain("show 150 earlier");
	});
});

describe("Transcript bounded navigation", () => {
	const entries: SessionEntry[] = Array.from({ length: 1250 }, (_, i) => ({
		type: "message",
		id: `window-${i}`,
		parentId: i === 0 ? null : `window-${i - 1}`,
		timestamp: "2026-07-15T00:00:00Z",
		message: { role: "user", content: `row ${i}`, timestamp: i },
	}));

	it("keeps earlier/newer traversal bounded and reaches every entry in both transcript variants", () => {
		for (const compact of [false, true]) {
			const visited = new Set<string>();
			let pinned: string | null = null;
			for (;;) {
				const window = transcriptWindow(entries, pinned);
				const visible = entries.slice(window.start, window.end);
				expect(visible.length).toBeLessThanOrEqual(100);
				const html = renderTranscript({ entries: visible, working: false, compact });
				expect(countElements(html, "[data-entry-id]")).toBeLessThanOrEqual(100);
				for (const entry of visible) visited.add(entry.id);
				if (window.earlierId === null) break;
				pinned = window.earlierId;
			}
			expect(visited.size).toBe(entries.length);
			expect(transcriptWindow(entries, pinned).start).toBe(0);
			while (transcriptWindow(entries, pinned).newerId !== null) {
				pinned = transcriptWindow(entries, pinned).newerId;
				const window = transcriptWindow(entries, pinned);
				expect(window.end - window.start).toBeLessThanOrEqual(100);
			}
			expect(transcriptWindow(entries, pinned).end).toBe(entries.length);
			expect(countElements(renderTranscript({ entries, working: false, compact }), "[data-entry-id]")).toBe(100);
		}
	});

	it("keeps an ID anchor as new rows arrive or older retained rows are evicted", () => {
		const firstPage = entries.slice(0, 200);
		const pinned = firstPage[75]!.id;
		expect(transcriptWindow(firstPage, pinned)).toMatchObject({ start: 75, end: 175 });
		expect(transcriptWindow(entries, pinned)).toMatchObject({ start: 75, end: 175 });
		expect(transcriptWindow(entries.slice(50), pinned)).toMatchObject({ start: 25, end: 125 });
		expect(transcriptWindow(entries.slice(100), pinned)).toMatchObject({ start: 0, end: 100 });
	});

	it("never attaches the current ghost, running tools or thinking indicator to historical pages", () => {
		const stream: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "current response must stay at latest" }],
			model: "test/model",
			usage: assistantUsage(),
			stopReason: "stop",
			timestamp: 1,
		};
		const html = renderTranscript({
			entries: entries.slice(0, 10),
			stream,
			activeTools: new Map([[TOOL_CALL_ID, activeTool()]]),
			working: true,
			atLatest: false,
		});
		expect(html).not.toContain("current response must stay at latest");
		expect(html).not.toContain("thinking…");
		expect(countElements(html, ".tv-card")).toBe(0);
	});
});

describe("Transcript tool results across page boundaries", () => {
	const result: SessionEntry = {
		type: "message",
		id: "tool-result",
		parentId: "assistant-entry-1",
		timestamp: "2026-07-09T00:00:01Z",
		message: {
			role: "toolResult",
			toolCallId: TOOL_CALL_ID,
			toolName: TOOL_NAME,
			content: [{ type: "text", text: "the result remains accessible" }],
			isError: false,
			timestamp: 2,
		},
	};

	it("renders an unpaired result as its own usable card rather than dropping it", () => {
		const html = renderTranscript({ entries: [result], working: false, atLatest: false });
		expect(countElements(html, ".tv-card")).toBe(1);
		expect(countElements(html, ".tv-status--ok")).toBe(1);
		expect(countElements(html, ".tv-head")).toBe(1);
		expect(html).toContain(TOOL_NAME);
	});

	it("does not duplicate a result when its call is in the same visible window", () => {
		const html = renderTranscript({ entries: [committedAssistantToolCall(), result], working: false });
		expect(countElements(html, ".tv-card")).toBe(1);
		expect(countElements(html, ".tv-status--ok")).toBe(1);
		expect(html).not.toContain("Result not on this page.");
	});

	it("marks a call whose result is outside the page without presenting it as still running", () => {
		const html = renderTranscript({ entries: [committedAssistantToolCall()], working: false, atLatest: false });
		expect(countElements(html, ".tv-card")).toBe(1);
		expect(countElements(html, '[aria-label="running"]')).toBe(0);
		expect(html).toContain("Result not on this page.");
	});

	it("reveals the result when tail windowing evicts its paired call", () => {
		const fillers: SessionEntry[] = Array.from({ length: 99 }, (_, i) => ({
			type: "message",
			id: `filler-${i}`,
			parentId: null,
			timestamp: "2026-07-09T00:00:01Z",
			message: { role: "user", content: "between call and result", timestamp: 2 },
		}));
		const html = renderTranscript({ entries: [committedAssistantToolCall(), ...fillers, result], working: false });
		expect(countElements(html, "[data-entry-id]")).toBe(100);
		expect(countElements(html, ".tv-card")).toBe(1);
		expect(countElements(html, ".tv-status--ok")).toBe(1);
	});
});
