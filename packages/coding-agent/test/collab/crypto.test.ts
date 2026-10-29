import { describe, expect, it } from "bun:test";
import {
	generateRoomKey,
	generateWriteToken,
	importRoomKey,
	open,
	seal,
} from "@oh-my-soup/pi-coding-agent/collab/crypto";
import {
	type CollabFrame,
	DEFAULT_RELAY_URL,
	formatCollabLink,
	formatCollabWebLink,
	generateRoomId,
	packEnvelope,
	parseCollabLink,
	rewriteEnvelopePeer,
	unpackEnvelope,
} from "@oh-my-soup/pi-coding-agent/collab/protocol";

describe("collab crypto", () => {
	it("round-trips a frame through seal/open", async () => {
		const key = await importRoomKey(generateRoomKey());
		const frame: CollabFrame = { t: "prompt", text: "check bun.lock — and ünïcode 🚀" };
		const sealed = await seal(key, frame);
		expect(await open(key, sealed)).toEqual(frame);
	});

	it("rejects tampered ciphertext", async () => {
		const key = await importRoomKey(generateRoomKey());
		const sealed = await seal(key, { t: "abort" });
		sealed[sealed.length - 1]! ^= 0xff;
		expect(open(key, sealed)).rejects.toThrow();
	});

	it("rejects frames sealed with a different key", async () => {
		const sealed = await seal(await importRoomKey(generateRoomKey()), { t: "abort" });
		const otherKey = await importRoomKey(generateRoomKey());
		expect(open(otherKey, sealed)).rejects.toThrow();
	});
});

describe("collab link format", () => {
	const key = generateRoomKey();
	const roomId = generateRoomId();

	it("collapses the default relay to a bare roomId.key link", () => {
		const link = formatCollabLink(DEFAULT_RELAY_URL, roomId, key);
		expect(link).toBe(`${roomId}.${Buffer.from(key).toString("base64url")}`);
		const parsed = parseCollabLink(link);
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.wsUrl).toBe(`${DEFAULT_RELAY_URL}/r/${roomId}`);
		expect(parsed.roomId).toBe(roomId);
		expect(parsed.key).toEqual(key);
	});

	it("keeps default-host relay prefixes instead of routing rooms to the hosted root", () => {
		const relay = `${DEFAULT_RELAY_URL}/proxy///`;
		const link = formatCollabLink(relay, roomId, key);
		expect(link).toBe(`my.omp.sh/proxy/r/${roomId}.${Buffer.from(key).toString("base64url")}`);
		const parsed = parseCollabLink(link);
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.wsUrl).toBe(`${DEFAULT_RELAY_URL}/proxy/r/${roomId}`);
		expect(parsed.key).toEqual(key);
		expect(formatCollabWebLink(relay, roomId, key, undefined, "   ")).toBeNull();
	});

	it("preserves nested relay prefixes containing /r/ when inferring the omitted wss scheme", () => {
		const link = formatCollabLink("wss://relay.example.com:8443/team/r/relay///", roomId, key);
		expect(link).toBe(`relay.example.com:8443/team/r/relay/r/${roomId}.${Buffer.from(key).toString("base64url")}`);
		const parsed = parseCollabLink(link);
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.wsUrl).toBe(`wss://relay.example.com:8443/team/r/relay/r/${roomId}`);
		expect(parsed.roomId).toBe(roomId);
		expect(parsed.key).toEqual(key);
		expect(parsed.writeToken).toBeUndefined();
	});

	it("preserves VPN ws relay prefixes and view/control access without inventing a browser UI", () => {
		const relay = "ws://10.66.66.8/team/r/relay///";
		for (const writeToken of [undefined, generateWriteToken()]) {
			const secret = writeToken ? Buffer.concat([key, writeToken]) : Buffer.from(key);
			const link = formatCollabLink(relay, roomId, key, writeToken);
			expect(link).toBe(`ws://10.66.66.8/team/r/relay/r/${roomId}.${secret.toString("base64url")}`);
			expect(formatCollabWebLink(relay, roomId, key, writeToken)).toBeNull();
			const parsed = parseCollabLink(link);
			if ("error" in parsed) throw new Error(parsed.error);
			expect(parsed.wsUrl).toBe(`ws://10.66.66.8/team/r/relay/r/${roomId}`);
			expect(parsed.roomId).toBe(roomId);
			expect(parsed.key).toEqual(key);
			expect(parsed.writeToken).toEqual(writeToken);
		}
	});

	it("rewrites https legacy relay URLs to wss without dropping the relay prefix", () => {
		const parsed = parseCollabLink(
			`https://relay.example.com/team/r/relay/r/${roomId}#${Buffer.from(key).toString("base64url")}`,
		);
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.wsUrl).toBe(`wss://relay.example.com/team/r/relay/r/${roomId}`);
		expect(parsed.key).toEqual(key);
		expect(parsed.writeToken).toBeUndefined();
	});

	it("normalizes prefixed http VPN relays to ws without losing the control token", () => {
		const token = generateWriteToken();
		const secret = Buffer.concat([key, token]).toString("base64url");
		for (const link of [
			formatCollabLink("http://10.66.66.8:8080/api/relay///", roomId, key, token),
			`http://10.66.66.8:8080/api/relay/r/${roomId}#${secret}`,
		]) {
			const parsed = parseCollabLink(link);
			if ("error" in parsed) throw new Error(parsed.error);
			expect(parsed.wsUrl).toBe(`ws://10.66.66.8:8080/api/relay/r/${roomId}`);
			expect(parsed.key).toEqual(key);
			expect(parsed.writeToken).toEqual(token);
		}
	});

	it("rejects unsupported relay schemes instead of treating them as ws", () => {
		expect(() => formatCollabLink("ftp://10.66.66.8", roomId, key)).toThrow();
		expect("error" in parseCollabLink(`ftp://10.66.66.8/r/${roomId}.${Buffer.from(key).toString("base64url")}`)).toBe(
			true,
		);
	});

	it("rejects keys that are not 32 base64url bytes", () => {
		expect("error" in parseCollabLink(`${roomId}.dG9vc2hvcnQ`)).toBe(true);
		expect("error" in parseCollabLink(`${roomId}.not+base64url/`)).toBe(true);
	});

	it("accepts legacy #-separated links without dropping their relay prefixes", () => {
		const keyText = Buffer.from(key).toString("base64url");
		for (const [legacy, expectedWsUrl] of [
			[`${roomId}#${keyText}`, `${DEFAULT_RELAY_URL}/r/${roomId}`],
			[
				`relay.example.com:8443/team/r/relay/r/${roomId}#${keyText}`,
				`wss://relay.example.com:8443/team/r/relay/r/${roomId}`,
			],
			[`https://my.omp.sh/#${roomId}#${keyText}`, `${DEFAULT_RELAY_URL}/r/${roomId}`],
		] as const) {
			const parsed = parseCollabLink(legacy);
			if ("error" in parsed) throw new Error(`${legacy}: ${parsed.error}`);
			expect(parsed.wsUrl).toBe(expectedWsUrl);
			expect(parsed.roomId).toBe(roomId);
			expect(parsed.key).toEqual(key);
			expect(parsed.writeToken).toBeUndefined();
		}
	});

	it("accepts %23-mangled legacy deep links with relay prefixes and control access", () => {
		const token = generateWriteToken();
		const secret = Buffer.concat([key, token]).toString("base64url");
		const parsed = parseCollabLink(
			`https://web.example/client/#ws://10.66.66.8/team/r/relay/r/${roomId}%23${secret}`,
		);
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.wsUrl).toBe(`ws://10.66.66.8/team/r/relay/r/${roomId}`);
		expect(parsed.key).toEqual(key);
		expect(parsed.writeToken).toEqual(token);
	});

	it("derives a hosted browser wrapper from the normalized default relay", () => {
		for (const relay of [DEFAULT_RELAY_URL, "https://my.omp.sh///"]) {
			const webLink = formatCollabWebLink(relay, roomId, key, undefined, "");
			if (webLink === null) throw new Error("Expected the hosted browser UI");
			expect(webLink).toBe(`https://my.omp.sh/#${roomId}.${Buffer.from(key).toString("base64url")}`);
			const parsed = parseCollabLink(webLink);
			if ("error" in parsed) throw new Error(parsed.error);
			expect(parsed.wsUrl).toBe(`${DEFAULT_RELAY_URL}/r/${roomId}`);
			expect(parsed.roomId).toBe(roomId);
			expect(parsed.key).toEqual(key);
			expect(parsed.writeToken).toBeUndefined();
		}
	});

	it.each([
		["wss://relay.example.com", undefined],
		["ws://10.66.66.8", ""],
		["http://my.omp.sh", "   "],
	] as const)("does not invent a browser UI for %s without an explicit webUrl", (relay, webUrl) => {
		expect(formatCollabWebLink(relay, roomId, key, undefined, webUrl)).toBeNull();
	});

	it("wraps a prefixed wss relay invite in a separate web UI origin and path", () => {
		const webLink = formatCollabWebLink(
			"wss://relay.example.com:8443/proxy/relay///",
			roomId,
			key,
			undefined,
			"https://web.example/client/collab///",
		);
		if (webLink === null) throw new Error("Expected the configured browser UI");
		expect(webLink).toBe(
			`https://web.example/client/collab/#relay.example.com:8443/proxy/relay/r/${roomId}.${Buffer.from(key).toString("base64url")}`,
		);
		const parsed = parseCollabLink(webLink);
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.wsUrl).toBe(`wss://relay.example.com:8443/proxy/relay/r/${roomId}`);
		expect(parsed.key).toEqual(key);
		expect(parsed.writeToken).toBeUndefined();
	});

	it("parses non-local http web UI wrappers by their relay fragment", () => {
		const keyText = Buffer.from(key).toString("base64url");
		const parsed = parseCollabLink(`http://web.example/collab/#relay.example.com:8443/r/${roomId}.${keyText}`);
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.wsUrl).toBe(`wss://relay.example.com:8443/r/${roomId}`);
	});

	it("parses split web UI wrappers with full relay URLs in the fragment", () => {
		const keyText = Buffer.from(key).toString("base64url");
		const parsed = parseCollabLink(`https://web.example/collab/#wss://relay.example.com/r/${roomId}.${keyText}`);
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.wsUrl).toBe(`wss://relay.example.com/r/${roomId}`);
	});

	it("falls through invalid http wrapper fragments without reparsing them", () => {
		expect(parseCollabLink("https://web.example/#not-a-collab-link")).toEqual({
			error: "Collab link must contain a /r/<roomId> path",
		});
	});

	it("prefers browser wrapper fragments over relay-like web paths", () => {
		const inner = formatCollabLink("wss://relay.example.com", roomId, key);
		const parsed = parseCollabLink(`https://web.example/r/abcdefghij#${inner}`);
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.wsUrl).toBe(`wss://relay.example.com/r/${roomId}`);
	});

	it("parses the scheme-less display form of web deep links", () => {
		const parsed = parseCollabLink(`my.omp.sh/#${formatCollabLink(DEFAULT_RELAY_URL, roomId, key)}`);
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.wsUrl).toBe(`${DEFAULT_RELAY_URL}/r/${roomId}`);
		expect(Buffer.from(parsed.key)).toEqual(Buffer.from(key));
	});

	it("embeds the write token in full links and omits it from view links", () => {
		const token = generateWriteToken();
		const full = parseCollabLink(formatCollabLink(DEFAULT_RELAY_URL, roomId, key, token));
		if ("error" in full) throw new Error(full.error);
		expect(Buffer.from(full.key)).toEqual(Buffer.from(key));
		expect(Buffer.from(full.writeToken ?? new Uint8Array())).toEqual(Buffer.from(token));

		const view = parseCollabLink(formatCollabLink(DEFAULT_RELAY_URL, roomId, key));
		if ("error" in view) throw new Error(view.error);
		expect(Buffer.from(view.key)).toEqual(Buffer.from(key));
		expect(view.writeToken).toBeUndefined();
	});

	it("carries the write token through web deep links", () => {
		const token = generateWriteToken();
		const webLink = formatCollabWebLink(DEFAULT_RELAY_URL, roomId, key, token);
		if (webLink === null) throw new Error("Expected the hosted browser UI");
		const parsed = parseCollabLink(webLink);
		if ("error" in parsed) throw new Error(parsed.error);
		expect(Buffer.from(parsed.key)).toEqual(Buffer.from(key));
		expect(Buffer.from(parsed.writeToken ?? new Uint8Array())).toEqual(Buffer.from(token));
	});

	it("rejects secrets that are neither 32 nor 48 bytes", () => {
		const bad = Buffer.alloc(40, 1).toString("base64url");
		expect("error" in parseCollabLink(`${roomId}#${bad}`)).toBe(true);
	});

	it("keeps the key out of web-link path and query", () => {
		const webLink = formatCollabWebLink(DEFAULT_RELAY_URL, roomId, key);
		if (webLink === null) throw new Error("Expected the hosted browser UI");
		const url = new URL(webLink);
		expect(url.origin).toBe("https://my.omp.sh");
		expect(url.pathname).toBe("/");
		expect(url.search).toBe("");
		expect(url.hash).toBe(`#${roomId}.${Buffer.from(key).toString("base64url")}`);
	});

	it("normalizes explicit web UI roots, paths, trailing slashes, and ports", () => {
		const invite = `${roomId}.${Buffer.from(key).toString("base64url")}`;
		const rootLink = formatCollabWebLink(DEFAULT_RELAY_URL, roomId, key, undefined, " https://web.example/ ");
		expect(rootLink).toBe(`https://web.example/#${invite}`);

		const pathLink = formatCollabWebLink(
			DEFAULT_RELAY_URL,
			roomId,
			key,
			undefined,
			"https://web.example:8443/collab///",
		);
		expect(pathLink).toBe(`https://web.example:8443/collab/#${invite}`);

		const localHttpLink = formatCollabWebLink(
			DEFAULT_RELAY_URL,
			roomId,
			key,
			undefined,
			"http://localhost:5173/app/",
		);
		expect(localHttpLink).toBe(`http://localhost:5173/app/#${invite}`);
	});

	it("rejects web UI URLs without an http or https protocol", () => {
		expect(() => formatCollabWebLink(DEFAULT_RELAY_URL, roomId, key, undefined, "ftp://web.example")).toThrow(
			"collab.webUrl must start with http:// or https://",
		);
	});

	it("preserves prefixed ws relay routes and view/control access inside a separate HTTP web UI", () => {
		const relay = "ws://10.66.66.8/team/r/relay///";
		for (const writeToken of [undefined, generateWriteToken()]) {
			const webLink = formatCollabWebLink(relay, roomId, key, writeToken, "http://10.66.66.9:5173/apps/collab///");
			if (webLink === null) throw new Error("Expected the configured browser UI");
			const url = new URL(webLink);
			expect(url.origin).toBe("http://10.66.66.9:5173");
			expect(url.pathname).toBe("/apps/collab/");
			expect(url.search).toBe("");
			expect(url.hash).toBe(`#${formatCollabLink(relay, roomId, key, writeToken)}`);
			for (const input of [webLink, webLink.slice("http://".length)]) {
				const parsed = parseCollabLink(input);
				if ("error" in parsed) throw new Error(parsed.error);
				expect(parsed.wsUrl).toBe(`ws://10.66.66.8/team/r/relay/r/${roomId}`);
				expect(parsed.roomId).toBe(roomId);
				expect(parsed.key).toEqual(key);
				expect(parsed.writeToken).toEqual(writeToken);
			}
		}
	});

	it.each(["?x=1", "#room"])("rejects explicit HTTP web UI URLs containing %s", suffix => {
		expect(() =>
			formatCollabWebLink(DEFAULT_RELAY_URL, roomId, key, undefined, `http://10.66.66.8/${suffix}`),
		).toThrow("collab.webUrl must not include a query string or fragment");
	});
});

describe("collab wire envelope", () => {
	it("round-trips peer id and payload", () => {
		const payload = new Uint8Array([1, 2, 3, 250]);
		const packed = packEnvelope(0xdeadbeef, payload);
		const unpacked = unpackEnvelope(packed);
		expect(unpacked?.peerId).toBe(0xdeadbeef);
		expect(unpacked?.payload).toEqual(payload);
	});

	it("rewrites the peer id in place without touching the payload", () => {
		const packed = packEnvelope(0, new Uint8Array([9, 8, 7]));
		rewriteEnvelopePeer(packed, 42);
		const unpacked = unpackEnvelope(packed);
		expect(unpacked?.peerId).toBe(42);
		expect(unpacked?.payload).toEqual(new Uint8Array([9, 8, 7]));
	});

	it("returns null for frames shorter than the header", () => {
		expect(unpackEnvelope(new Uint8Array([0, 0]))).toBeNull();
	});
});
