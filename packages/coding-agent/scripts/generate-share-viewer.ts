#!/usr/bin/env bun
/**
 * Build the standalone share-viewer page the oms relay serves at `GET /s/<id>`.
 *
 * Same template as HTML exports, but with no embedded session: share-loader.js
 * (injected right after the empty #session-data tag) fetches the sealed blob
 * (gist or relay store), decrypts it with the `#<key>` fragment in-browser, and
 * hands the JSON to template.js via `window.__OMP_SESSION_DATA__`.
 *
 * The relay repo's build script runs this and embeds the output via go:embed.
 */
import * as path from "node:path";
import { generateThemeStyles, getTemplate } from "../src/export/html";

const outPath = process.argv[2];
if (!outPath) {
	console.error("usage: bun scripts/generate-share-viewer.ts <output.html>");
	process.exit(2);
}

const loaderBuild = await Bun.build({
	entrypoints: [path.join(import.meta.dir, "../src/export/html/share-loader.js")],
	target: "browser",
	format: "iife",
});
if (!loaderBuild.success) {
	throw new Error(`Share loader bundle failed:\n${loaderBuild.logs.map(log => log.message).join("\n")}`);
}
const loaderEntry = loaderBuild.outputs.find(output => output.kind === "entry-point");
if (!loaderEntry) throw new Error("Share loader bundle produced no entry point");
const loaderJs = await loaderEntry.text();
// Public artifacts use the bundled oms web themes rather than TUI themes.
const themeStyles = await generateThemeStyles("web");

const html = getTemplate()
	.replace("<theme-vars/>", () => `<style>${themeStyles}</style>`)
	.replace("<title>Session Export</title>", () => "<title>oms session</title>")
	.replace("{{SESSION_DATA}}</script>", () => `</script>\n  <script>${loaderJs}</script>`);

if (html.includes("{{SESSION_DATA}}")) throw new Error("session-data placeholder survived substitution");
if (!html.includes("__OMP_SESSION_DATA__")) throw new Error("share loader not injected");

await Bun.write(outPath, html);
console.log(`Generated ${path.resolve(outPath)} (${(html.length / 1024).toFixed(0)} KB)`);
