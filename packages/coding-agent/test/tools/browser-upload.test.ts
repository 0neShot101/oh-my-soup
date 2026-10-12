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
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

// A file input, and a button whose click opens a hidden input's chooser.
const html = `<!doctype html>
<style>button { display: block; margin: 8px; padding: 8px; }</style>
<input id="direct" type="file" multiple>
<button id="trigger" type="button">Upload</button><input id="trigger-input" type="file" hidden>
<script>
document.getElementById("trigger").addEventListener("click", () => document.getElementById("trigger-input").click());
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
		const context = { session, toolCallId: "browser-upload-connected" };
		const name = `upload-${crypto.randomUUID()}`;
		const run = async (code: string): Promise<unknown> => {
			const result = await prelude.invoke({ action: "run", name, timeout: 15, code }, context);
			const details = result.details;
			if (!details || typeof details !== "object" || !("value" in details)) throw new Error("run returned no value");
			return details.value;
		};
		try {
			await waitForCdp(`http://127.0.0.1:${port}`, 15_000);
			await prelude.invoke({ action: "open", name, url, app: { cdp_url: `http://127.0.0.1:${port}` } }, context);
			// A user's browser reads paths under its own permissions (relay file access, macOS folder privacy,
			// another host). Deleting the file once it is uploaded stands in for a path that browser cannot read.
			const gone = path.join(tempDir, "gone.txt");
			await Bun.write(gone, "gone soon");
			await run(`await tab.uploadFile("#direct", "gone.txt");
await tab.uploadFile("#trigger", "gone.txt");
return null;`);
			await fs.rm(gone);
			const contents = await run(`return await tab.evaluate(async () => {
	const read = selector => document.querySelector(selector).files[0].text().then(text => text, error => error.name);
	return [await read("#direct"), await read("#trigger-input")];
});`);
			expect(contents).toEqual(["gone soon", "gone soon"]);
		} finally {
			await prelude.invoke({ action: "close", name }, context).catch(() => undefined);
			child.kill();
			await child.exited;
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 60_000);
});
