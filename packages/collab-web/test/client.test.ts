import { describe, expect, it, vi } from "bun:test";
import type {
	AgentSnapshot,
	AssistantMessage,
	GuestFrame,
	HostFrame,
	HistoryPage,
	SessionEntry,
	SessionHeader,
	SessionState,
	SubagentProgressPayload,
	WireMessage,
} from "@oh-my-soup/pi-wire";
import { COLLAB_HISTORY_BYTES, COLLAB_HISTORY_ENTRIES } from "@oh-my-soup/pi-wire";
import { diffCollabStream } from "@oh-my-soup/pi-wire/collab-stream";
import { GuestClient } from "../src/lib/client";
import { COLLAB_PROTO, encodeBase64Url } from "../src/lib/link";
import { CollabSocket } from "../src/lib/socket";

const LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`;

const HEADER: SessionHeader = { type: "session", id: "s1", timestamp: "2026-06-12T00:00:00Z", cwd: "/work" };

const STATE: SessionState = {
	isStreaming: false,
	queuedMessageCount: 0,
	cwd: "/work",
	participants: [{ name: "host", role: "host" }],
};

const AGENTS: AgentSnapshot[] = [
	{
		id: "main",
		displayName: "Main",
		kind: "main",
		status: "running",
		hasSessionFile: true,
		createdAt: 1,
		lastActivity: 2,
	},
];

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		model: "test/model",
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } },
		stopReason: "stop",
		timestamp: 1,
	};
}

function messageEntry(id: string, message: WireMessage): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: "2026-06-12T00:00:01Z", message };
}

function welcomeFrame(entryCount = 0, readOnly?: boolean, history?: HistoryPage): HostFrame {
	return {
		t: "welcome",
		proto: COLLAB_PROTO,
		header: HEADER,
		state: STATE,
		agents: AGENTS,
		entryCount,
		readOnly,
		history,
	};
}

function snapshotChunk(entries: SessionEntry[], final = true): HostFrame {
	return { t: "snapshot-chunk", entries, final };
}

function liveClient(entries: SessionEntry[] = []): GuestClient {
	const client = new GuestClient(LINK, "tester");
	client.applyFrameForTest(welcomeFrame(entries.length));
	if (entries.length > 0) client.applyFrameForTest(snapshotChunk(entries));
	return client;
}

function userEntries(start: number, end: number, content = "message"): SessionEntry[] {
	return Array.from({ length: end - start }, (_, offset) => {
		const index = start + offset;
		return messageEntry(`e${index}`, { role: "user", content: `${content}-${index}`, timestamp: index });
	});
}

function historyFrame(
	reqId: number,
	entries: SessionEntry[],
	total: number,
	beforeId: string | null,
	afterId: string | null,
): HostFrame {
	return { t: "history", reqId, entries, page: { beforeId, afterId, total } };
}

describe("GuestClient frame apply", () => {
	it("throws on an invalid link", () => {
		expect(() => new GuestClient("not a link", "tester")).toThrow();
	});

	it("welcome populates the snapshot and goes live", () => {
		const userEntry = messageEntry("e1", { role: "user", content: "hi", timestamp: 1 });
		const client = liveClient([userEntry]);
		const snap = client.getSnapshot();
		expect(snap.phase).toBe("live");
		expect(snap.header).toEqual(HEADER);
		expect(snap.entries).toEqual([userEntry]);
		expect(snap.state).toEqual(STATE);
		expect(snap.agents).toEqual(AGENTS);
		expect(snap.working).toBe(false);
		expect(snap.stream).toBeNull();
		expect(snap.activeTools.size).toBe(0);
	});

	it("welcome readOnly flag lands in the snapshot", () => {
		const client = new GuestClient(LINK, "tester");
		expect(client.getSnapshot().readOnly).toBe(false);
		client.applyFrameForTest(welcomeFrame(0, true));
		expect(client.getSnapshot().readOnly).toBe(true);
	});

	it("times out stalled snapshot chunks and resets the clock on progress", () => {
		vi.useFakeTimers();
		try {
			const firstEntry = messageEntry("e1", { role: "user", content: "hi", timestamp: 1 });
			const client = new GuestClient(LINK, "tester");
			client.applyFrameForTest(welcomeFrame(2));
			expect(client.getSnapshot().phase).toBe("connecting");

			vi.advanceTimersByTime(29_999);
			expect(client.getSnapshot().phase).toBe("connecting");
			client.applyFrameForTest(snapshotChunk([firstEntry], false));
			expect(client.getSnapshot().entries).toEqual([]);
			expect(client.getSnapshot().phase).toBe("connecting");

			vi.advanceTimersByTime(29_999);
			expect(client.getSnapshot().phase).toBe("connecting");
			vi.advanceTimersByTime(1);
			const snap = client.getSnapshot();
			expect(snap.phase).toBe("ended");
			expect(snap.endedReason).toBe("timed out waiting for the host's session snapshot");

			const completeClient = new GuestClient(LINK, "tester");
			completeClient.applyFrameForTest(welcomeFrame(1));
			completeClient.applyFrameForTest(snapshotChunk([firstEntry]));
			vi.advanceTimersByTime(30_000);
			expect(completeClient.getSnapshot().phase).toBe("live");
			expect(completeClient.getSnapshot().entries).toEqual([firstEntry]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps the transcript on screen through a resync and swaps it in on the final chunk", () => {
		const e1 = messageEntry("e1", { role: "user", content: "hi", timestamp: 1 });
		const e2 = messageEntry("e2", { role: "user", content: "again", timestamp: 2 });
		const client = liveClient([e1]);

		client.applyFrameForTest(welcomeFrame(2));
		client.applyFrameForTest(snapshotChunk([e1], false));
		expect(client.getSnapshot().entries).toEqual([e1]);
		expect(client.getSnapshot().loading).toEqual({ received: 1, total: 2 });

		client.applyFrameForTest(snapshotChunk([e2]));
		expect(client.getSnapshot().entries).toEqual([e1, e2]);
		expect(client.getSnapshot().loading).toBeNull();
		expect(client.getSnapshot().phase).toBe("live");
	});

	it("publishes live entries that arrive mid-snapshot after the snapshot, not inside it", () => {
		const e1 = messageEntry("e1", { role: "user", content: "one", timestamp: 1 });
		const e2 = messageEntry("e2", { role: "user", content: "two", timestamp: 2 });
		const live = messageEntry("live", { role: "user", content: "live", timestamp: 3 });
		const client = new GuestClient(LINK, "tester");

		client.applyFrameForTest(welcomeFrame(2));
		client.applyFrameForTest(snapshotChunk([e1], false));
		client.applyFrameForTest({ t: "entry", entry: live });
		expect(client.getSnapshot().entries).toEqual([]);
		expect(client.getSnapshot().loading).toEqual({ received: 1, total: 2 });

		client.applyFrameForTest(snapshotChunk([e2]));
		expect(client.getSnapshot().entries).toEqual([e1, e2, live]);
	});

	it("drops the finished stream ghost when its entry lands mid-snapshot", () => {
		const e1 = messageEntry("e1", { role: "user", content: "one", timestamp: 1 });
		const e2 = messageEntry("e2", { role: "user", content: "two", timestamp: 2 });
		const message = assistantMessage("hello");
		const client = new GuestClient(LINK, "tester");

		client.applyFrameForTest(welcomeFrame(2));
		client.applyFrameForTest(snapshotChunk([e1], false));
		client.applyFrameForTest({ t: "event", event: { type: "message_end", message } });
		client.applyFrameForTest({ t: "entry", entry: messageEntry("a1", message) });
		client.applyFrameForTest(snapshotChunk([e2]));

		const snap = client.getSnapshot();
		expect(snap.entries).toEqual([e1, e2, messageEntry("a1", message)]);
		expect(snap.stream).toBeNull();
		expect(snap.streamDone).toBe(false);
	});

	it("completes the snapshot once every promised entry arrived, even without a final chunk", () => {
		const e1 = messageEntry("e1", { role: "user", content: "one", timestamp: 1 });
		const e2 = messageEntry("e2", { role: "user", content: "two", timestamp: 2 });
		const client = new GuestClient(LINK, "tester");

		client.applyFrameForTest(welcomeFrame(2));
		client.applyFrameForTest(snapshotChunk([e1, e2], false));
		expect(client.getSnapshot().phase).toBe("live");
		expect(client.getSnapshot().entries).toEqual([e1, e2]);
		expect(client.getSnapshot().loading).toBeNull();
	});

	it("a stream baseline restores the ghost when joining mid-response", () => {
		const client = liveClient();
		const partial = assistantMessage("hel");
		client.applyFrameForTest({ t: "stream", id: 1, revision: 9, message: partial });
		const snap = client.getSnapshot();
		expect(snap.stream).toEqual(partial);
		expect(snap.streamDone).toBe(false);
	});

	it("message_end keeps the ghost until the matching entry lands", () => {
		const client = liveClient();
		const message = assistantMessage("hello");
		client.applyFrameForTest({ t: "stream", id: 1, revision: 0, message });
		client.applyFrameForTest({ t: "event", event: { type: "message_end", message } });
		let snap = client.getSnapshot();
		expect(snap.streamDone).toBe(true);
		expect(snap.stream).toEqual(message);

		client.applyFrameForTest({ t: "entry", entry: messageEntry("e2", message) });
		snap = client.getSnapshot();
		expect(snap.stream).toBeNull();
		expect(snap.streamDone).toBe(false);
		expect(snap.entries).toHaveLength(1);
	});

	it("tool start/update/end maintains activeTools", () => {
		const client = liveClient();
		client.applyFrameForTest({
			t: "event",
			event: {
				type: "tool_execution_start",
				toolCallId: "tc1",
				toolName: "bash",
				args: { command: "ls" },
				intent: "Listing",
			},
		});
		let tool = client.getSnapshot().activeTools.get("tc1");
		expect(tool?.toolName).toBe("bash");
		expect(tool?.intent).toBe("Listing");

		client.applyFrameForTest({
			t: "event",
			event: {
				type: "tool_execution_update",
				toolCallId: "tc1",
				toolName: "bash",
				args: { command: "ls" },
				partialResult: "src",
			},
		});
		tool = client.getSnapshot().activeTools.get("tc1");
		expect(tool?.partialResult).toBe("src");

		client.applyFrameForTest({
			t: "event",
			event: { type: "tool_execution_end", toolCallId: "tc1", toolName: "bash", result: "src\ntest" },
		});
		expect(client.getSnapshot().activeTools.size).toBe(0);
	});

	it("agent_start/agent_end and state reconcile the working flag", () => {
		const client = liveClient();
		client.applyFrameForTest({ t: "event", event: { type: "agent_start" } });
		expect(client.getSnapshot().working).toBe(true);
		client.applyFrameForTest({ t: "state", state: { ...STATE, isStreaming: false } });
		expect(client.getSnapshot().working).toBe(false);
	});
	it("a state frame recovers a stuck-idle guest when agent_start was dropped", () => {
		// The host begins streaming mid-turn, but the matching `agent_start`
		// never arrived (e.g. dropped on a reconnect). Before the fix nothing
		// set `working` true except `agent_start`, so the guest stayed idle.
		const client = liveClient();
		expect(client.getSnapshot().working).toBe(false);
		client.applyFrameForTest({ t: "state", state: { ...STATE, isStreaming: true } });
		expect(client.getSnapshot().working).toBe(true);
	});

	it("an idle state frame clears a pinned tool card when tool_execution_end was dropped", () => {
		// Host reports idle, but the matching `tool_execution_end` was dropped,
		// leaving a stuck tool card. The authoritative idle signal must clear it.
		const client = liveClient();
		client.applyFrameForTest({
			t: "event",
			event: {
				type: "tool_execution_start",
				toolCallId: "tc1",
				toolName: "bash",
				args: { command: "ls" },
				intent: "Listing",
			},
		});
		expect(client.getSnapshot().activeTools.size).toBe(1);
		client.applyFrameForTest({ t: "state", state: { ...STATE, isStreaming: false } });
		expect(client.getSnapshot().activeTools.size).toBe(0);
	});

	it("bus progress frames update the progress map", () => {
		const client = liveClient();
		const payload: SubagentProgressPayload = {
			index: 0,
			agent: "task",
			task: "do things",
			progress: {
				index: 0,
				id: "Sub1",
				agent: "task",
				status: "running",
				task: "do things",
				recentTools: [],
				recentOutput: [],
				toolCount: 1,
				requests: 1,
				tokens: 100,
				cost: 0.01,
				durationMs: 1000,
			},
		};
		client.applyFrameForTest({ t: "bus", channel: "task:subagent:progress", data: payload });
		expect(client.getSnapshot().progress.get("Sub1")).toEqual(payload);
	});

	it("publishes streaming frames once per animation frame and flushes them with the next immediate frame", () => {
		vi.useFakeTimers();
		try {
			const client = liveClient();
			let commits = 0;
			client.subscribe(() => commits++);
			let previous = assistantMessage("");
			let revision = 0;
			client.applyFrameForTest({ t: "stream", id: 1, revision, message: previous }, { flush: false });
			for (const text of ["a", "ab", "abc"]) {
				const message = assistantMessage(text);
				client.applyFrameForTest(
					{
						t: "stream-delta",
						id: 1,
						previousRevision: revision,
						revision: ++revision,
						patch: diffCollabStream(previous, message),
					},
					{ flush: false },
				);
				previous = message;
			}
			expect(commits).toBe(0);
			expect(client.getSnapshot().stream).toBeNull();

			vi.advanceTimersByTime(16);
			expect(commits).toBe(1);
			expect(client.getSnapshot().stream).toEqual(assistantMessage("abc"));

			client.applyFrameForTest(
				{
					t: "stream-delta",
					id: 1,
					previousRevision: revision,
					revision: revision + 1,
					patch: diffCollabStream(previous, assistantMessage("abcd")),
				},
				{ flush: false },
			);
			client.applyFrameForTest({ t: "state", state: { ...STATE, isStreaming: true } }, { flush: false });
			expect(commits).toBe(2);
			expect(client.getSnapshot().stream).toEqual(assistantMessage("abcd"));
			vi.advanceTimersByTime(16);
			expect(commits).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("prunes subagent progress once the host stops listing the agent", () => {
		const client = liveClient();
		const payload = (id: string): SubagentProgressPayload => ({
			index: 0,
			agent: "task",
			task: "t",
			progress: {
				index: 0,
				id,
				agent: "task",
				status: "running",
				task: "t",
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				requests: 0,
				tokens: 0,
				cost: 0,
				durationMs: 0,
			},
		});
		const sub: AgentSnapshot = { ...AGENTS[0]!, id: "Sub1", kind: "sub" };
		client.applyFrameForTest({ t: "bus", channel: "task:subagent:progress", data: payload("Sub1") });
		// Progress may outrun its agent's first listing: one unlisted `agents` frame keeps it.
		client.applyFrameForTest({ t: "agents", agents: AGENTS });
		expect(client.getSnapshot().progress.has("Sub1")).toBe(true);
		client.applyFrameForTest({ t: "agents", agents: [...AGENTS, sub] });
		expect(client.getSnapshot().progress.has("Sub1")).toBe(true);

		const before = client.getSnapshot().progress;
		client.applyFrameForTest({ t: "agents", agents: AGENTS });
		expect(client.getSnapshot().progress.has("Sub1")).toBe(true);
		expect(client.getSnapshot().progress).toBe(before);
		client.applyFrameForTest({ t: "agents", agents: AGENTS });
		expect(client.getSnapshot().progress.has("Sub1")).toBe(false);
		expect(client.getSnapshot().progress).not.toBe(before);
	});

	it("bye ends the session with a reason", () => {
		const client = liveClient();
		client.applyFrameForTest({ t: "bye", reason: "host left" });
		const snap = client.getSnapshot();
		expect(snap.phase).toBe("ended");
		expect(snap.endedReason).toBe("host left");
	});

	it("error frames append notices", () => {
		const client = liveClient();
		client.applyFrameForTest({ t: "error", message: "boom" });
		const notices = client.getSnapshot().notices;
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({ level: "error", message: "boom" });
	});

	it("auto_retry_end failure surfaces an error notice", () => {
		const client = liveClient();
		client.applyFrameForTest({
			t: "event",
			event: { type: "auto_retry_end", success: false, attempt: 3, finalError: "x" },
		});
		const notices = client.getSnapshot().notices;
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({ level: "error", message: "x" });
	});

	it("a pre-welcome error (hello rejection, e.g. protocol mismatch) ends the session with the host's reason", () => {
		const client = new GuestClient(LINK, "tester");
		client.applyFrameForTest({
			t: "error",
			message: `protocol mismatch: host speaks v${COLLAB_PROTO}, guest sent v${COLLAB_PROTO - 1}`,
		});
		const snap = client.getSnapshot();
		expect(snap.phase).toBe("ended");
		expect(snap.endedReason).toContain("protocol mismatch");
		expect(snap.endedReason).toContain(`v${COLLAB_PROTO}`);
	});

	it("tracks host UI requests and sends responses", () => {
		const sent: GuestFrame[] = [];
		const sendSpy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation((frame: GuestFrame) => {
			sent.push(frame);
		});
		try {
			const client = liveClient();
			const request = {
				reqId: 7,
				kind: "select" as const,
				title: "Continue?",
				options: ["Yes", { label: "No", description: "Stop here" }],
				selectionMarker: "radio" as const,
			};
			client.applyFrameForTest({ t: "ui-request", request });
			expect(client.getSnapshot().uiRequest).toEqual(request);

			client.sendUiResponse(7, "Yes");
			expect(sent).toEqual([{ t: "ui-response", reqId: 7, value: "Yes" }]);
			expect(client.getSnapshot().uiRequest).toBeNull();
		} finally {
			sendSpy.mockRestore();
		}
	});

	it("clears pending host UI requests when the host ends them", () => {
		const client = liveClient();
		client.applyFrameForTest({
			t: "ui-request",
			request: { reqId: 8, kind: "editor", title: "Other", prefill: "draft" },
		});
		expect(client.getSnapshot().uiRequest?.reqId).toBe(8);
		client.applyFrameForTest({ t: "ui-request-end", reqId: 8 });
		expect(client.getSnapshot().uiRequest).toBeNull();
	});

	it("queues overlapping host UI requests until the active one resolves", () => {
		const client = liveClient();
		const first = { reqId: 9, kind: "select" as const, title: "First?", options: ["A"] };
		const second = { reqId: 10, kind: "editor" as const, title: "Second?", prefill: "draft" };
		client.applyFrameForTest({ t: "ui-request", request: first });
		client.applyFrameForTest({ t: "ui-request", request: second });
		expect(client.getSnapshot().uiRequest).toEqual(first);

		client.applyFrameForTest({ t: "ui-request-end", reqId: 9 });
		expect(client.getSnapshot().uiRequest).toEqual(second);

		client.applyFrameForTest({ t: "ui-request-end", reqId: 10 });
		expect(client.getSnapshot().uiRequest).toBeNull();
	});

	it("snapshot reference is stable between frames and replaced per frame", () => {
		const client = liveClient();
		const before = client.getSnapshot();
		expect(client.getSnapshot()).toBe(before);
		client.applyFrameForTest({ t: "agents", agents: AGENTS });
		const after = client.getSnapshot();
		expect(after).not.toBe(before);
		expect(after.agents).not.toBe(before.agents);
		// Non-entry frames must not invalidate entry identity: Transcript's
		// memo and useSyncExternalStore skip their O(n) scans per token.
		expect(after.entries).toBe(before.entries);
	});

	it("replaces the entries reference when entry frames arrive", () => {
		const client = liveClient();
		const before = client.getSnapshot();
		client.applyFrameForTest({
			t: "entry",
			entry: {
				type: "message",
				id: "m-new",
				parentId: null,
				timestamp: "2026-06-12T00:00:02Z",
				message: { role: "user", content: "hi", timestamp: 2 },
			},
		});
		const after = client.getSnapshot();
		expect(after.entries).not.toBe(before.entries);
		expect(after.entries).toHaveLength(before.entries.length + 1);
	});
});

describe("GuestClient bounded history", () => {
	it("joins 9000 canonical entries from a bounded initial page", () => {
		const client = new GuestClient(LINK, "tester");
		const entries = userEntries(8900, 9000);
		client.applyFrameForTest(welcomeFrame(100, false, { beforeId: "e8900", afterId: null, total: 9000 }));
		expect(client.getSnapshot().loading).toEqual({ received: 0, total: 100 });
		client.applyFrameForTest(snapshotChunk(entries.slice(0, 40), false));
		expect(client.getSnapshot().entries).toHaveLength(0);
		client.applyFrameForTest(snapshotChunk(entries.slice(40)));
		expect(client.getSnapshot()).toMatchObject({
			phase: "live",
			entries,
			history: { beforeId: "e8900", afterId: null, total: 9000, atLatest: true, loading: false },
		});
	});

	it("bounds old fixture snapshots without metadata and preserves an exclusive older cursor", () => {
		const entries = userEntries(0, 9000);
		const client = liveClient(entries);
		expect(client.getSnapshot().entries).toEqual(entries.slice(-COLLAB_HISTORY_ENTRIES));
		expect(client.getSnapshot().history).toMatchObject({ beforeId: "e8900", total: 9000 });
	});

	it("bounds UTF-8 bytes as well as entry count and always retains the newest oversize entry", () => {
		const client = liveClient(userEntries(0, 20, "한🙂".repeat(4000)));
		const first = client.getSnapshot();
		expect(first.entries.length).toBeLessThan(20);
		expect(new TextEncoder().encode(JSON.stringify(first.entries)).byteLength).toBeLessThanOrEqual(
			COLLAB_HISTORY_BYTES,
		);
		expect(first.history.beforeId).toBe(first.entries[0]!.id);

		const huge = messageEntry("huge", { role: "user", content: "🙂".repeat(COLLAB_HISTORY_BYTES), timestamp: 20 });
		client.applyFrameForTest({ t: "entry", entry: huge });
		expect(client.getSnapshot().entries).toEqual([huge]);
		expect(client.getSnapshot().history.beforeId).toBe("huge");
		client.applyFrameForTest({ t: "entry", entry: userEntries(21, 22)[0]! });
		expect(client.getSnapshot().entries.map(entry => entry.id)).toEqual(["e21"]);
		expect(client.getSnapshot().history.beforeId).toBe("e21");
	});

	it("bounds live retention and exposes every evicted row through replacement pages", () => {
		const canonical = userEntries(0, 1250);
		const client = liveClient(canonical.slice(0, 50));
		for (const entry of canonical.slice(50)) client.applyFrameForTest({ t: "entry", entry });
		expect(client.getSnapshot().entries).toEqual(canonical.slice(-100));
		expect(client.getSnapshot().history).toMatchObject({ beforeId: "e1150", total: 1250 });
		const sent: GuestFrame[] = [];
		const sendSpy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation(frame => {
			sent.push(frame);
			if (frame.t !== "fetch-history") return;
			const cursor = frame.cursor;
			const index =
				cursor.kind === "latest" ? canonical.length : canonical.findIndex(entry => entry.id === cursor.id);
			const start = cursor.kind === "after" ? index + 1 : Math.max(0, index - 100);
			const end = cursor.kind === "before" ? index : Math.min(canonical.length, start + 100);
			client.applyFrameForTest(
				historyFrame(
					frame.reqId,
					canonical.slice(start, end),
					canonical.length,
					start > 0 ? canonical[start]!.id : null,
					end < canonical.length ? canonical[end - 1]!.id : null,
				),
			);
		});
		try {
			const visited = new Set(client.getSnapshot().entries.map(entry => entry.id));
			while (client.getSnapshot().history.beforeId !== null) {
				client.fetchHistory({ kind: "before", id: client.getSnapshot().history.beforeId! });
				const snap = client.getSnapshot();
				expect(snap.entries.length).toBeLessThanOrEqual(COLLAB_HISTORY_ENTRIES);
				for (const entry of snap.entries) visited.add(entry.id);
			}
			expect(visited.size).toBe(canonical.length);
			expect(client.getSnapshot().entries[0]?.id).toBe("e0");
			while (client.getSnapshot().history.afterId !== null) {
				client.fetchHistory({ kind: "after", id: client.getSnapshot().history.afterId! });
				expect(client.getSnapshot().entries.length).toBeLessThanOrEqual(COLLAB_HISTORY_ENTRIES);
			}
			expect(client.getSnapshot().history.atLatest).toBe(true);
			expect(client.getSnapshot().entries.at(-1)?.id).toBe("e1249");
			expect(sent[0]).toMatchObject({ t: "fetch-history", cursor: { kind: "before", id: "e1150" } });
		} finally {
			sendSpy.mockRestore();
			client.close();
		}
	});

	it("keeps live work independent of history and merges a latest reply without duplicate or lost rows", () => {
		const client = liveClient(userEntries(0, 250));
		client.fetchHistory({ kind: "before", id: "e150" });
		client.applyFrameForTest(historyFrame(1, userEntries(50, 150), 250, "e50", "e149"));
		const historical = client.getSnapshot().entries;
		const baseline = assistantMessage("reading");
		const updated = assistantMessage("reading while live continues");
		client.applyFrameForTest({ t: "stream", id: 7, revision: 0, message: baseline });
		client.applyFrameForTest({ t: "entry", entry: userEntries(250, 251)[0]! });
		client.applyFrameForTest({
			t: "stream-delta",
			id: 7,
			previousRevision: 0,
			revision: 1,
			patch: diffCollabStream(baseline, updated),
		});
		expect(client.getSnapshot().entries).toBe(historical);
		expect(client.getSnapshot().history).toMatchObject({ atLatest: false, total: 251 });
		expect(client.getSnapshot().stream).toEqual(updated);

		client.fetchHistory({ kind: "latest" });
		for (const entry of userEntries(251, 253)) client.applyFrameForTest({ t: "entry", entry });
		// Reply already contains e251, while e252 arrived after that snapshot.
		client.applyFrameForTest(historyFrame(2, userEntries(152, 252), 252, "e152", null));
		expect(client.getSnapshot().entries).toEqual(userEntries(153, 253));
		expect(client.getSnapshot().history).toMatchObject({ atLatest: true, beforeId: "e153", total: 253 });
		expect(client.getSnapshot().stream).toEqual(updated);
		client.close();
	});

	it("does not reappend raced entries that were already evicted from the reply's byte-bounded page", () => {
		const client = liveClient(userEntries(0, 3));
		client.fetchHistory({ kind: "latest" });
		const older = userEntries(3, 4)[0]!;
		const latest = messageEntry("e4", { role: "user", content: "x".repeat(COLLAB_HISTORY_BYTES), timestamp: 4 });
		client.applyFrameForTest({ t: "entry", entry: older });
		client.applyFrameForTest({ t: "entry", entry: latest });
		client.applyFrameForTest(historyFrame(1, [latest], 5, "e4", null));
		expect(client.getSnapshot().entries).toEqual([latest]);
		expect(client.getSnapshot().history.total).toBe(5);
		client.close();
	});

	it("keeps both pending snapshot and latest-request live races bounded through a long burst", () => {
		const client = new GuestClient(LINK, "tester");
		client.applyFrameForTest(welcomeFrame(100, false, { beforeId: "e0", afterId: null, total: 100 }));
		client.applyFrameForTest(snapshotChunk(userEntries(0, 40), false));
		for (const entry of userEntries(100, 2100)) client.applyFrameForTest({ t: "entry", entry });
		client.applyFrameForTest(snapshotChunk(userEntries(40, 100)));
		expect(client.getSnapshot().entries).toEqual(userEntries(2000, 2100));
		expect(client.getSnapshot().history).toMatchObject({ beforeId: "e2000", total: 2100 });
		client.fetchHistory({ kind: "latest" });
		for (const entry of userEntries(2100, 4100)) client.applyFrameForTest({ t: "entry", entry });
		client.applyFrameForTest(historyFrame(1, userEntries(2000, 2100), 2100, "e2000", null));
		expect(client.getSnapshot().entries).toEqual(userEntries(4000, 4100));
		expect(client.getSnapshot().history).toMatchObject({ beforeId: "e4000", total: 4100 });
		client.close();
	});

	it("preserves older access when an empty latest reply races more than one live window", () => {
		const client = liveClient();
		client.fetchHistory({ kind: "latest" });
		for (const entry of userEntries(0, 250)) client.applyFrameForTest({ t: "entry", entry });
		client.applyFrameForTest(historyFrame(1, [], 0, null, null));
		expect(client.getSnapshot().entries).toEqual(userEntries(150, 250));
		expect(client.getSnapshot().history).toMatchObject({ beforeId: "e150", total: 250, atLatest: true });
		client.close();
	});

	it("deduplicates live entries that also occur in an in-flight snapshot", () => {
		const client = new GuestClient(LINK, "tester");
		client.applyFrameForTest(welcomeFrame(2));
		client.applyFrameForTest({ t: "entry", entry: userEntries(1, 2)[0]! });
		client.applyFrameForTest(snapshotChunk(userEntries(0, 2)));
		expect(client.getSnapshot().entries).toEqual(userEntries(0, 2));
		expect(client.getSnapshot().history.total).toBe(2);
	});

	it("ignores overlapping navigation and stale replies after a welcome or timeout", () => {
		vi.useFakeTimers();
		const sent: GuestFrame[] = [];
		const sendSpy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation(frame => {
			sent.push(frame);
		});
		try {
			const client = liveClient(userEntries(0, 150));
			client.fetchHistory({ kind: "before", id: "e50" });
			client.fetchHistory({ kind: "latest" });
			expect(sent).toHaveLength(1);
			expect(client.getSnapshot().history.loading).toBe(true);
			client.applyFrameForTest(welcomeFrame(1, false, { beforeId: "e149", afterId: null, total: 150 }));
			client.applyFrameForTest(historyFrame(1, userEntries(0, 50), 150, null, "e49"));
			client.applyFrameForTest(snapshotChunk(userEntries(149, 150)));
			expect(client.getSnapshot().entries).toEqual(userEntries(149, 150));
			expect(client.getSnapshot().history.loading).toBe(false);

			client.fetchHistory({ kind: "before", id: "e149" });
			const before = client.getSnapshot().entries;
			vi.advanceTimersByTime(10_000);
			expect(client.getSnapshot().history.error).toContain("timed out");
			expect(client.getSnapshot().entries).toBe(before);
			client.fetchHistory({ kind: "before", id: "e149" });
			client.applyFrameForTest(historyFrame(2, userEntries(49, 149), 150, "e49", "e148"));
			expect(client.getSnapshot().history.loading).toBe(true);
			expect(client.getSnapshot().entries).toBe(before);
			client.applyFrameForTest(historyFrame(3, userEntries(49, 149), 150, "e49", "e148"));
			expect(client.getSnapshot().history).toMatchObject({ loading: false, error: null, atLatest: false });
			client.close();
		} finally {
			sendSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	it("surfaces history failures without clearing the page and discards a reply after close", () => {
		const client = liveClient(userEntries(0, 150));
		const before = client.getSnapshot().entries;
		client.fetchHistory({ kind: "before", id: "gone" });
		client.applyFrameForTest({
			t: "history",
			reqId: 1,
			entries: [],
			page: { beforeId: null, afterId: null, total: 150 },
			error: "history cursor no longer exists",
		});
		expect(client.getSnapshot().entries).toBe(before);
		expect(client.getSnapshot().history).toMatchObject({ loading: false, error: "history cursor no longer exists" });
		client.fetchHistory({ kind: "before", id: "e50" });
		client.close();
		client.applyFrameForTest(historyFrame(2, userEntries(0, 50), 150, null, "e49"));
		expect(client.getSnapshot().phase).toBe("ended");
		expect(client.getSnapshot().history.loading).toBe(false);
		expect(client.getSnapshot().entries).toBe(before);
	});
});

describe("GuestClient lossless stream patches", () => {
	it("applies text/thinking appends, replacements and final metadata without mutating prior snapshots", () => {
		const client = liveClient(userEntries(0, 1));
		const first: AssistantMessage = {
			...assistantMessage(""),
			content: [
				{ type: "thinking", thinking: "plan" },
				{ type: "text", text: "hel" },
			],
		};
		const second: AssistantMessage = {
			...first,
			content: [
				{ type: "thinking", thinking: "plan carefully" },
				{ type: "text", text: "hello" },
				{ type: "toolCall", id: "call", name: "read", arguments: { path: "a" } },
			],
		};
		const third: AssistantMessage = {
			...second,
			content: [{ type: "text", text: "revised answer" }],
			usage: { ...second.usage, output: 20, totalTokens: 21 },
		};
		client.applyFrameForTest({ t: "stream", id: 1, revision: 0, message: first });
		const before = client.getSnapshot();
		client.applyFrameForTest({
			t: "stream-delta",
			id: 1,
			previousRevision: 0,
			revision: 1,
			patch: diffCollabStream(first, second),
		});
		expect(client.getSnapshot().stream).toEqual(second);
		expect(client.getSnapshot().entries).toBe(before.entries);
		expect(before.stream).toEqual(first);
		client.applyFrameForTest({
			t: "stream-delta",
			id: 1,
			previousRevision: 1,
			revision: 2,
			patch: diffCollabStream(second, third),
		});
		expect(client.getSnapshot().stream).toEqual(third);
		const final = { ...third, content: [{ type: "text" as const, text: "authoritative final answer" }] };
		client.applyFrameForTest({ t: "event", event: { type: "message_end", message: final } });
		expect(client.getSnapshot().stream).toEqual(final);
		client.applyFrameForTest({ t: "entry", entry: messageEntry("final", final) });
		expect(client.getSnapshot().stream).toBeNull();
		expect(client.getSnapshot().entries.at(-1)).toEqual(messageEntry("final", final));
	});

	it("ignores pre-welcome deltas and decodes a targeted baseline during snapshot download", () => {
		const client = new GuestClient(LINK, "tester");
		const first = assistantMessage("before");
		const next = assistantMessage("before and after");
		client.applyFrameForTest({
			t: "stream-delta",
			id: 1,
			previousRevision: 5,
			revision: 6,
			patch: diffCollabStream(first, next),
		});
		expect(client.getSnapshot().phase).toBe("connecting");
		expect(client.getSnapshot().stream).toBeNull();
		client.applyFrameForTest(welcomeFrame(1));
		client.applyFrameForTest({ t: "stream", id: 1, revision: 6, message: first });
		client.applyFrameForTest({
			t: "stream-delta",
			id: 1,
			previousRevision: 6,
			revision: 7,
			patch: diffCollabStream(first, next),
		});
		client.applyFrameForTest(snapshotChunk(userEntries(0, 1)));
		expect(client.getSnapshot().phase).toBe("live");
		expect(client.getSnapshot().stream).toEqual(next);
	});

	it("requires rejoin on a missing revision, wrong stream ID or invalid append offset", () => {
		const first = assistantMessage("hello");
		const next = assistantMessage("hello world");
		for (const failure of ["revision", "id", "offset"] as const) {
			const client = liveClient();
			client.applyFrameForTest({ t: "stream", id: 1, revision: 0, message: first });
			const patch = diffCollabStream(failure === "offset" ? assistantMessage("wrong length") : first, next);
			if (failure === "offset") {
				patch.changes = [
					{ index: 0, kind: "append", field: "text", offset: 12, text: "!", properties: { type: "text" } },
				];
			}
			client.applyFrameForTest({
				t: "stream-delta",
				id: failure === "id" ? 2 : 1,
				previousRevision: failure === "revision" ? 1 : 0,
				revision: 2,
				patch,
			});
			expect(client.getSnapshot().phase).toBe("ended");
			expect(client.getSnapshot().endedReason).toContain("Rejoin");
		}
	});

	it("resets the decoder on welcome and canonical message boundaries", () => {
		const first = assistantMessage("old");
		const next = assistantMessage("old content");
		for (const boundary of ["welcome", "message_start", "message_end"] as const) {
			const client = liveClient();
			client.applyFrameForTest({ t: "stream", id: 1, revision: 0, message: first });
			if (boundary === "welcome") client.applyFrameForTest(welcomeFrame());
			else client.applyFrameForTest({ t: "event", event: { type: boundary, message: assistantMessage("new") } });
			client.applyFrameForTest({
				t: "stream-delta",
				id: 1,
				previousRevision: 0,
				revision: 1,
				patch: diffCollabStream(first, next),
			});
			expect(client.getSnapshot().phase).toBe("ended");
			expect(client.getSnapshot().endedReason).toContain("synchronization");
		}
	});
});
