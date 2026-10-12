#!/usr/bin/env bun
/**
 * Regenerates the committed browser asset
 *
 *   src/tools/browser/aria/aria-snapshot.bundle.txt   ← bundled CJS module
 *
 * by fetching Playwright's injected ARIA-snapshot sources (pinned to
 * PLAYWRIGHT_TAG), wrapping them with a small entry, and bundling — all in a
 * throwaway temp dir. Only the bundle is committed; the upstream sources are NOT
 * vendored into the repo (no shipping both source + generated copies). This is a
 * dev-time, network-bound step, exactly like `generate-models`.
 *
 * The tab worker imports the `.txt` with `{ type: "text" }`, wraps it in a
 * `new Function` worker-side, and runs it via puppeteer's CDP evaluate (it
 * installs nothing on `window`). The committed output means binary and source
 * installs need no network or build step at runtime.
 *
 * Usage: bun scripts/generate-aria-snapshot.ts
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const PLAYWRIGHT_TAG = "v1.61.0";
const RAW_BASE = `https://raw.githubusercontent.com/microsoft/playwright/${PLAYWRIGHT_TAG}/packages`;

const OUTPUT = path.join(import.meta.dir, "..", "src", "tools", "browser", "aria", "aria-snapshot.bundle.txt");

// Upstream source path -> temp path (relative to the temp root).
const VENDOR_FILES: Array<[string, string]> = [
	["injected/src/ariaSnapshot.ts", "injected/ariaSnapshot.ts"],
	["injected/src/roleUtils.ts", "injected/roleUtils.ts"],
	["injected/src/domUtils.ts", "injected/domUtils.ts"],
	["isomorphic/ariaSnapshot.ts", "isomorphic/ariaSnapshot.ts"],
	["isomorphic/stringUtils.ts", "isomorphic/stringUtils.ts"],
	["isomorphic/cssTokenizer.ts", "isomorphic/cssTokenizer.ts"],
	["isomorphic/yaml.ts", "isomorphic/yaml.ts"],
];

// Entry wrapping the upstream modules. Always runs Playwright's `ai` mode so every
// node carries a `[ref=eN]` id; matched nodes get an `_ariaRef` expando. Existing
// expandos are cleared first so the fresh module's counter renumbers from e1
// deterministically (refs are valid until the next snapshot). Installs nothing on
// `window`.
const ENTRY_SOURCE = `
import { generateAriaTree, renderAriaTree } from "./injected/ariaSnapshot";
import { normalizeWhiteSpace } from "./isomorphic/stringUtils";

export interface AriaSnapshotRequest {
	depth?: number;
	boxes?: boolean;
}

function walkElements(fn: (el: Element) => void): void {
	const walk = (root: { querySelectorAll(s: string): ArrayLike<Element> }): void => {
		for (const el of Array.from(root.querySelectorAll("*"))) {
			fn(el);
			const shadow = (el as Element & { shadowRoot?: { querySelectorAll(s: string): ArrayLike<Element> } | null }).shadowRoot;
			if (shadow) walk(shadow);
		}
	};
	walk(document as unknown as { querySelectorAll(s: string): ArrayLike<Element> });
}
type RefElement = Element & { _ariaRef?: { role: string; name: string; ref: string } };

export function ariaSnapshot(root: Element | null, request: AriaSnapshotRequest = {}): string {
	walkElements(el => {
		if ((el as RefElement)._ariaRef) delete (el as RefElement)._ariaRef;
	});
	const target = root ?? document.body ?? document.documentElement;
	const options = { mode: "ai", depth: request.depth, boxes: request.boxes } as const;
	// Playwright reads a text input's live value for the textbox's child text and for the
	// accessible name of any control that labels itself by it (aria-labelledby, embedded
	// controls), password fields included. While the tree is built, every password input
	// reports one bullet per character instead, as the screen and Chrome's accessibility
	// tree do, so a typed or saved password never reaches a snapshot. Matching by local
	// name covers XHTML pages and inputs adopted from another frame. No page task runs
	// before the getters are removed; an own \`value\` property the page installed (React
	// tracks input changes with one) is put back as it was, and a value the page made
	// non-configurable is masked in the rendered text instead.
	const masked: Array<[HTMLInputElement, PropertyDescriptor | undefined]> = [];
	const pinned: string[] = [];
	try {
		walkElements(el => {
			const input = el as HTMLInputElement;
			if (input.localName !== "input" || input.type !== "password") return;
			const own = Object.getOwnPropertyDescriptor(input, "value");
			const value = input.value;
			if (own && !own.configurable) {
				if (value) pinned.push(value);
				return;
			}
			const bullets = "\\u2022".repeat(value.length);
			Object.defineProperty(input, "value", { configurable: true, get: () => bullets });
			masked.push([input, own]);
		});
		let text = renderAriaTree(generateAriaTree(target, options), options).text;
		// Names are whitespace-normalized and JSON-quoted, then a key with a quote is YAML
		// single-quoted; child text escapes backslashes and quotes the same way JSON does.
		for (const value of pinned) {
			const bullets = "\\u2022".repeat(value.length);
			for (const plain of new Set([value, normalizeWhiteSpace(value)])) {
				const escaped = JSON.stringify(plain).slice(1, -1);
				for (const form of [escaped.replaceAll("'", "''"), escaped, plain]) {
					if (form) text = text.replaceAll(form, bullets);
				}
			}
		}
		return text;
	} finally {
		for (const [input, own] of masked) {
			if (own) Object.defineProperty(input, "value", own);
			else Reflect.deleteProperty(input, "value");
		}
	}
}

export function resolveAriaRef(ref: string): Element | null {
	let found: Element | null = null;
	walkElements(el => {
		if (!found && (el as RefElement)._ariaRef?.ref === ref) found = el;
	});
	return found;
}
`;

async function main(): Promise<void> {
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-aria-"));
	try {
		// Fetch pinned upstream sources into the temp dir.
		for (const [src, dst] of VENDOR_FILES) {
			const url = `${RAW_BASE}/${src}`;
			const res = await fetch(url);
			if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
			await Bun.write(path.join(tmp, dst), await res.text());
		}
		const entry = path.join(tmp, "entry.ts");
		await Bun.write(entry, ENTRY_SOURCE);

		// The injected sources import isomorphic modules via the `@isomorphic/*`
		// alias and the `yaml` package (type-only). Resolve the alias to the fetched
		// copies and stub `yaml` (only referenced from erased `import type`).
		const aliasPlugin: Bun.BunPlugin = {
			name: "aria-vendor-alias",
			setup(build) {
				build.onResolve({ filter: /^@isomorphic\// }, args => ({
					path: path.join(tmp, "isomorphic", `${args.path.slice("@isomorphic/".length)}.ts`),
				}));
				build.onResolve({ filter: /^yaml$/ }, () => ({ path: "yaml", namespace: "aria-yaml-stub" }));
				build.onLoad({ filter: /.*/, namespace: "aria-yaml-stub" }, () => ({
					contents: "export {};",
					loader: "ts",
				}));
			},
		};

		const result = await Bun.build({
			entrypoints: [entry],
			target: "browser",
			format: "cjs",
			minify: true,
			plugins: [aliasPlugin],
		});
		if (!result.success) {
			for (const log of result.logs) console.error(log);
			throw new Error("aria snapshot bundle failed");
		}
		const code = await result.outputs[0].text();
		const header = `// @generated by scripts/generate-aria-snapshot.ts from Playwright ${PLAYWRIGHT_TAG}\n// Bundled from Playwright's injected ARIA-snapshot sources (Apache-2.0, (c) Microsoft).\n// Do not edit by hand. Regenerate with: bun scripts/generate-aria-snapshot.ts\n`;
		await Bun.write(OUTPUT, header + code);
		console.log(`bundled ${path.relative(process.cwd(), OUTPUT)} (${code.length}b)`);
	} finally {
		await fs.rm(tmp, { recursive: true, force: true });
	}
}

await main();
