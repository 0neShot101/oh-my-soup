import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { findFreeCdpPort, waitForCdp } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { uploadFilesToElement } from "@oh-my-pi/pi-coding-agent/tools/browser/interactions";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import type { ElementHandle, Page } from "puppeteer-core";
import { rejectionOf } from "../helpers/rejection";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

// File inputs reached by selector, by handle and inside a shadow root; buttons whose click opens a hidden input's
// chooser, one of which turns its input into a text field once the chooser is open.
const html = `<!doctype html>
<style>button { display: block; margin: 8px; padding: 8px; }</style>
<input id="direct" type="file" multiple>
<input id="handle" type="file">
<div id="host"></div>
<button id="trigger" type="button">Upload</button><input id="trigger-input" type="file" hidden>
<button id="other" type="button">Upload another</button><input id="other-input" type="file" hidden>
<button id="swap" type="button">Upload, then swap</button><input id="swap-input" type="file" hidden>
<script>
window.composedInputs = [];
document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = '<input id="shadow" type="file">';
document.addEventListener("input", event => composedInputs.push(event.composedPath()[0].id));
for (const id of ["trigger", "other"])
  document.getElementById(id).addEventListener("click", () => document.getElementById(id + "-input").click());
document.getElementById("swap").addEventListener("click", () => {
  const input = document.getElementById("swap-input");
  input.click();
  input.type = "text";
});
</script>`;

// A page that replaces the globals an upload builds its files with, as polyfills and monitoring scripts do.
const poisonedHtml = `<!doctype html>
<input id="direct" type="file">
<button id="trigger" type="button">Upload</button><input id="trigger-input" type="file" hidden>
<script>
for (const name of ["DataTransfer", "File", "Event", "atob"])
  window[name] = function () { throw new Error("the page replaced " + name); };
document.getElementById("trigger").addEventListener("click", () => document.getElementById("trigger-input").click());
</script>`;

interface ProxiedSocket {
	path: string;
	upstream?: WebSocket;
	pending: (string | Buffer)[];
}

/** Forward CDP to Chrome and, like the relay, drop the connection on a websocket message over `maxMessageBytes`. */
function startCappedCdpProxy(chromePort: number, maxMessageBytes: number): Bun.Server<ProxiedSocket> {
	return Bun.serve<ProxiedSocket>({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req, server) {
			const { pathname } = new URL(req.url);
			if (server.upgrade(req, { data: { path: pathname, pending: [] } })) return undefined;
			const response = await fetch(`http://127.0.0.1:${chromePort}${pathname}`);
			const body = (await response.text()).replaceAll(`127.0.0.1:${chromePort}`, `127.0.0.1:${server.port}`);
			return new Response(body, { status: response.status, headers: { "content-type": "application/json" } });
		},
		websocket: {
			maxPayloadLength: maxMessageBytes,
			open(ws) {
				const upstream = new WebSocket(`ws://127.0.0.1:${chromePort}${ws.data.path}`);
				ws.data.upstream = upstream;
				upstream.onopen = () => {
					for (const message of ws.data.pending.splice(0)) upstream.send(message);
				};
				upstream.onmessage = event => ws.send(event.data);
				upstream.onclose = () => ws.close();
			},
			message(ws, message) {
				const { upstream } = ws.data;
				if (upstream?.readyState === WebSocket.OPEN) upstream.send(message);
				else ws.data.pending.push(message);
			},
			close(ws) {
				ws.data.upstream?.close();
			},
		},
	});
}

let tempDir = "";
let site: Bun.Server<undefined> | undefined;
let url = "";

function makeSession(): ToolSession {
	return {
		cwd: tempDir,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"browser.enabled": true,
			"browser.headless": true,
			"browser.cmux": false,
			"browser.tern": false,
			"tools.maxTimeout": 0,
		}),
	};
}

/**
 * Launch a Chrome omp did not start, open a fixture page in it over `app.cdp_url`, and run cells there. With
 * `maxMessageBytes`, omp reaches Chrome through a proxy that caps websocket messages the way the relay does.
 */
async function openConnectedTab(toolCallId: string, options: { page?: string; maxMessageBytes?: number } = {}) {
	const exe = await ensureChromiumExecutable();
	if (!exe) throw new Error("Expected a Chromium executable");
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-upload-connected-"));
	const port = await findFreeCdpPort();
	const child = Bun.spawn(
		[
			exe,
			"--headless=new",
			"--no-first-run",
			"--use-mock-keychain",
			`--user-data-dir=${root}`,
			`--remote-debugging-port=${port}`,
		],
		{ stdin: "ignore", stdout: "ignore", stderr: "ignore" },
	);
	const proxy = options.maxMessageBytes ? startCappedCdpProxy(port, options.maxMessageBytes) : undefined;
	const cdpUrl = `http://127.0.0.1:${proxy?.port ?? port}`;
	const session = makeSession();
	const prelude = createBrowserPrelude(session);
	const context = { session, toolCallId };
	const name = `upload-${crypto.randomUUID()}`;
	const close = async () => {
		await prelude.invoke({ action: "close", name }, context).catch(() => undefined);
		proxy?.stop(true);
		child.kill();
		await child.exited;
		await fs.rm(root, { recursive: true, force: true });
	};
	try {
		await waitForCdp(`http://127.0.0.1:${port}`, 15_000);
		await prelude.invoke(
			{ action: "open", name, url: `${url}${options.page ?? ""}`, app: { cdp_url: cdpUrl } },
			context,
		);
	} catch (error) {
		await close();
		throw error;
	}
	const run = async (code: string): Promise<unknown> => {
		const result = await prelude.invoke({ action: "run", name, timeout: 15, code }, context);
		const details = result.details;
		if (!details || typeof details !== "object" || !("value" in details)) throw new Error("run returned no value");
		return details.value;
	};
	return { run, close };
}

beforeAll(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-upload-"));
	site = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: req =>
			new Response(new URL(req.url).pathname === "/poisoned" ? poisonedHtml : html, {
				headers: { "content-type": "text/html" },
			}),
	});
	url = `http://127.0.0.1:${site.port}/`;
});

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
	site?.stop(true);
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser uploadFile", () => {
	test("hands a browser it did not launch the file contents, not a path", async () => {
		const { run, close } = await openConnectedTab("browser-upload-connected");
		try {
			// A user's browser reads paths under its own permissions (relay file access, macOS folder privacy,
			// another host). Deleting the file once it is uploaded stands in for a path that browser cannot read.
			const gone = path.join(tempDir, "gone.txt");
			await Bun.write(gone, "gone soon");
			const modified = new Date("2020-01-02T03:04:05Z");
			await fs.utimes(gone, modified, modified);
			const errors = await run(`const errors = [];
for (const upload of [
	() => tab.uploadFile("#direct", "gone.txt"),
	() => tab.uploadFile("#trigger", "gone.txt"),
	async () => (await tab.waitFor("#handle")).uploadFile("gone.txt"),
	() => tab.uploadFile("pierce/#shadow", "gone.txt"),
]) {
	try { await upload(); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
}
return errors;`);
			expect(errors).toEqual([]);
			await fs.rm(gone);
			const received = await run(`return await tab.evaluate(async () => {
	const inputs = [
		document.querySelector("#direct"),
		document.querySelector("#trigger-input"),
		document.querySelector("#handle"),
		document.querySelector("#host").shadowRoot.querySelector("#shadow"),
	];
	const files = await Promise.all(inputs.map(input => {
		const file = input.files[0];
		return file.text().then(text => [text, file.type, file.lastModified], error => [error.name]);
	}));
	return { files, composedInputs: window.composedInputs };
});`);
			const file = ["gone soon", "text/plain", modified.getTime()];
			expect(received).toEqual({
				files: [file, file, file, file],
				composedInputs: ["direct", "trigger-input", "handle", "shadow"],
			});
		} finally {
			await close();
		}
	}, 60_000);

	test("fails a chooser upload a browser it did not launch could not take", async () => {
		const { run, close } = await openConnectedTab("browser-upload-connected-refused");
		try {
			await Bun.write(path.join(tempDir, "alpha.txt"), "alpha");
			await Bun.write(path.join(tempDir, "beta.txt"), "beta");
			// The page swaps its input out from under the chooser. Two overlapping uploads would both take the first
			// chooser, so whichever reaches it second is refused and only the winner's input gets a file.
			const result =
				await run(`const message = outcome => outcome.status === "rejected" ? outcome.reason.message : "ok";
const swapped = await Promise.allSettled([tab.uploadFile("#swap", "alpha.txt")]);
const uploads = [["#trigger", "alpha.txt"], ["#other", "beta.txt"]];
const outcomes = await Promise.allSettled(uploads.map(([selector, file]) => tab.uploadFile(selector, file)));
const names = await tab.evaluate(() => ["#trigger-input", "#other-input"].map(id => [...document.querySelector(id).files].map(file => file.name)));
return {
	swapped: swapped.map(message),
	overlapping: outcomes.map((outcome, i) => ({ result: message(outcome), file: uploads[i][1], names: names[i] })),
};`);
			// `run` details carry the cell's return value untyped.
			const { swapped, overlapping } = result as {
				swapped: string[];
				overlapping: { result: string; file: string; names: string[] }[];
			};
			expect(swapped[0]).toContain("Node is not a file input element");
			const winner = overlapping.find(upload => upload.result === "ok");
			const loser = overlapping.find(upload => upload.result !== "ok");
			expect(winner?.names).toEqual(winner ? [winner.file] : ["no upload succeeded"]);
			expect(loser?.result).toContain("waits for its file chooser");
			expect(loser?.names).toEqual([]);
		} finally {
			await close();
		}
	}, 60_000);
	test("builds the files in the isolated world, untyped when the extension names no type", async () => {
		const { run, close } = await openConnectedTab("browser-upload-connected-poisoned", { page: "poisoned" });
		try {
			await Bun.write(path.join(tempDir, "notes"), "no extension");
			const errors = await run(`const errors = [];
for (const selector of ["#direct", "#trigger"]) {
	try { await tab.uploadFile(selector, "notes"); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
}
return errors;`);
			expect(errors).toEqual([]);
			const received =
				await run(`return await tab.evaluate(() => Promise.all(["#direct", "#trigger-input"].map(async id => {
	const file = document.querySelector(id).files[0];
	return [await file.text(), file.type];
})));`);
			// A browser's own pick of a file whose extension names no MIME type reports an empty type.
			expect(received).toEqual([
				["no extension", ""],
				["no extension", ""],
			]);
		} finally {
			await close();
		}
	}, 60_000);

	test("streams a file larger than one websocket message allows", async () => {
		const maxMessageBytes = 16 * 1024 * 1024;
		const { run, close } = await openConnectedTab("browser-upload-connected-capped", { maxMessageBytes });
		try {
			// Base64 in a single message would come to 4/3 of the file, over the cap.
			const bytes = new Uint8Array(maxMessageBytes);
			for (let offset = 0; offset < bytes.length; offset += 65_536)
				crypto.getRandomValues(bytes.subarray(offset, offset + 65_536));
			const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
			await Bun.write(path.join(tempDir, "large.bin"), bytes);
			const errors = await run(`const errors = [];
for (const selector of ["#direct", "#trigger"]) {
	try { await tab.uploadFile(selector, "large.bin"); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
}
return errors;`);
			expect(errors).toEqual([]);
			const digests =
				await run(`return await tab.evaluate(() => Promise.all(["#direct", "#trigger-input"].map(async id => {
	const digest = await crypto.subtle.digest("SHA-256", await document.querySelector(id).files[0].arrayBuffer());
	return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
})));`);
			expect(digests).toEqual([digest, digest]);
		} finally {
			await close();
		}
	}, 90_000);
});

test("detaches a chooser session that attaches after the upload was cancelled", async () => {
	const { promise: attached, resolve: attach } = Promise.withResolvers<{ detach: () => Promise<void> }>();
	let detached = false;
	const controller = new AbortController();
	// Only what the chooser route touches before its session exists: the target's tag and session creation,
	// which the cancel interrupts.
	const page = {
		createCDPSession: () => {
			controller.abort();
			return attached;
		},
	} as unknown as Page;
	const handle = { evaluate: async () => ({ tag: "BUTTON", type: "" }) } as unknown as ElementHandle;
	await rejectionOf(uploadFilesToElement(page, handle, ["/missing.txt"], "upload", controller.signal, "contents"));
	attach({
		detach: async () => {
			detached = true;
		},
	});
	for (let turn = 0; turn < 5; turn++) await Promise.resolve();
	expect(detached).toBe(true);
});
