import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, GuestFrame } from "@oh-my-soup/pi-wire";
import { COLLAB_PROTO } from "@oh-my-soup/pi-wire";
import { GuestClient } from "../src/lib/client";
import { encodeBase64Url } from "../src/lib/link";
import { CollabSocket } from "../src/lib/socket";

const NativeWebSocket = globalThis.WebSocket;
const LINK = `transient-network-room#${encodeBase64Url(new Uint8Array(32))}`;

class ScriptedWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: ScriptedWebSocket[] = [];

	readonly url: string;
	binaryType = "arraybuffer";
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onopen: ((event: Event) => void) | null = null;
	readyState = ScriptedWebSocket.CONNECTING;

	constructor(url: string | URL) {
		this.url = String(url);
		ScriptedWebSocket.instances.push(this);
	}

	send(_data: unknown): void {}

	open(): void {
		this.readyState = ScriptedWebSocket.OPEN;
		this.onopen?.(new Event("open"));
	}

	message(data: string): void {
		this.onmessage?.(new MessageEvent("message", { data }));
	}

	relayClose(code: number, reason: string): void {
		this.readyState = ScriptedWebSocket.CLOSED;
		this.onclose?.(new CloseEvent("close", { code, reason }));
	}

	close(code = 1000, reason = "closed"): void {
		if (this.readyState === ScriptedWebSocket.CLOSED) return;
		this.relayClose(code, reason);
	}
}

function installScriptedWebSocket(): void {
	ScriptedWebSocket.instances = [];
	Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: ScriptedWebSocket });
}

function restoreNativeWebSocket(): void {
	Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: NativeWebSocket });
}

function instance(index: number): ScriptedWebSocket {
	const ws = ScriptedWebSocket.instances[index];
	if (!ws) throw new Error(`WebSocket instance ${index} was not created`);
	return ws;
}

afterEach(() => {
	restoreNativeWebSocket();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("browser guest room recovery", () => {
	it("stays reconnecting while a dropped host recreates the room", () => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		installScriptedWebSocket();
		const client = new GuestClient(LINK, "tester");

		try {
			client.connect();
			instance(0).open();
			expect(client.getSnapshot().phase).toBe("waiting");

			instance(0).message('{"t":"room-closed"}');
			expect(client.getSnapshot().phase).not.toBe("ended");
			instance(0).relayClose(4001, "room closed");
			expect(client.getSnapshot().phase).toBe("reconnecting");

			vi.advanceTimersByTime(1_000);
			instance(1).open();
			instance(1).relayClose(4004, "no such room");
			expect(client.getSnapshot().phase).toBe("reconnecting");

			vi.advanceTimersByTime(1_000);
			expect(ScriptedWebSocket.instances).toHaveLength(2);
			vi.advanceTimersByTime(1_000);
			instance(2).open();
			expect(client.getSnapshot().phase).toBe("reconnecting");
		} finally {
			client.close();
		}
	});

	it("ends an initial join when the room does not exist", () => {
		vi.useFakeTimers();
		installScriptedWebSocket();
		const client = new GuestClient(LINK, "tester");

		client.connect();
		instance(0).open();
		instance(0).relayClose(4004, "no such room");

		expect(client.getSnapshot()).toMatchObject({ phase: "ended", endedReason: "no such room" });
		vi.advanceTimersByTime(30_000);
		expect(ScriptedWebSocket.instances).toHaveLength(1);
	});

	it("requests paged history and resets pending navigation and streaming on reconnect", () => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		installScriptedWebSocket();
		const sent: GuestFrame[] = [];
		vi.spyOn(CollabSocket.prototype, "send").mockImplementation(frame => {
			sent.push(frame);
		});
		const client = new GuestClient(LINK, "tester");
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "in flight" }],
			model: "test/model",
			usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { total: 0 } },
			stopReason: "stop",
			timestamp: 1,
		};
		const welcome = {
			t: "welcome" as const,
			proto: COLLAB_PROTO,
			header: { type: "session" as const, id: "test", cwd: "/tmp", timestamp: "2026-07-01T00:00:00Z" },
			state: { isStreaming: true, queuedMessageCount: 0, cwd: "/tmp", participants: [] },
			agents: [],
			entryCount: 0,
			history: { beforeId: null, afterId: null, total: 0 },
		};
		try {
			client.connect();
			instance(0).open();
			expect(sent[0]).toMatchObject({ t: "hello", proto: COLLAB_PROTO, history: "paged" });
			client.applyFrameForTest(welcome);
			client.applyFrameForTest({ t: "stream", id: 1, revision: 0, message });
			client.fetchHistory({ kind: "latest" });
			expect(client.getSnapshot().history.loading).toBe(true);
			instance(0).relayClose(1006, "network interrupted");
			expect(client.getSnapshot().phase).toBe("reconnecting");
			expect(client.getSnapshot().stream).toBeNull();
			expect(client.getSnapshot().history.loading).toBe(false);
			client.applyFrameForTest({
				t: "history",
				reqId: 1,
				entries: [],
				page: { beforeId: null, afterId: null, total: 999 },
			});
			expect(client.getSnapshot().history.total).toBe(0);

			vi.advanceTimersByTime(1_000);
			instance(1).open();
			client.applyFrameForTest({ t: "stream", id: 1, revision: 1, message });
			expect(client.getSnapshot().stream).toBeNull();
			client.applyFrameForTest(welcome);
			client.applyFrameForTest({ t: "stream", id: 2, revision: 5, message });
			expect(client.getSnapshot().phase).toBe("live");
			expect(client.getSnapshot().stream).toEqual(message);
			client.applyFrameForTest({
				t: "history",
				reqId: 1,
				entries: [],
				page: { beforeId: null, afterId: null, total: 999 },
			});
			expect(client.getSnapshot().history.total).toBe(0);
		} finally {
			client.close();
		}
	});
});
