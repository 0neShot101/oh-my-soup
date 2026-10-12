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

/** Launch a Chrome omp did not start, open the fixture in it over `app.cdp_url`, and run cells there. */
async function openConnectedTab(toolCallId: string) {
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
	const session = makeSession();
	const prelude = createBrowserPrelude(session);
	const context = { session, toolCallId };
	const name = `upload-${crypto.randomUUID()}`;
	const close = async () => {
		await prelude.invoke({ action: "close", name }, context).catch(() => undefined);
		child.kill();
		await child.exited;
		await fs.rm(root, { recursive: true, force: true });
	};
	try {
		await waitForCdp(`http://127.0.0.1:${port}`, 15_000);
		await prelude.invoke({ action: "open", name, url, app: { cdp_url: `http://127.0.0.1:${port}` } }, context);
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
		fetch: () => new Response(html, { headers: { "content-type": "text/html" } }),
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
