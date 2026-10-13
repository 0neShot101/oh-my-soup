import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { untilAborted, withTimeout } from "@oh-my-pi/pi-utils";
import type { BunFile } from "bun";
import type { ElementHandle, Page, Realm } from "puppeteer-core";
import { throwIfAborted } from "../tool-errors";

declare module "puppeteer-core" {
	interface Frame {
		/** The frame's isolated world, where a page's replaced globals never reach (`@internal` upstream). */
		isolatedRealm(): Realm;
	}
}

/** What a browser's own pick reports for a file. */
export interface UploadFileInfo {
	name: string;
	/** Bare MIME type, empty when the extension names none. */
	type: string;
	lastModified: number;
}

/** A file to hand a page, its contents base64-encoded. */
export interface FilePayload extends UploadFileInfo {
	data: string;
}

/** A file to upload, opened for reading in slices. */
export interface UploadSource {
	path: string;
	file: BunFile;
	size: number;
	info: UploadFileInfo;
}

/**
 * How a browser gets uploaded files: `paths` of staged copies it reads itself, or `contents` omp reads and streams in,
 * for a browser that may not open omp's files (a relay without file-URL access, a Chrome on another machine).
 */
export type UploadRoute = "paths" | "contents";

/** The type Bun gives an extension it does not know; a browser's own pick reports such a file with no type. */
const UNKNOWN_TYPE = "application/octet-stream";

/** Extensions Chrome itself maps to `application/octet-stream` (`kSecondaryMappings` in `net/base/mime_util.cc`). */
const OCTET_STREAM_EXTENSIONS: Record<string, true> = { ".bin": true, ".exe": true, ".com": true };

/** How long the route check waits for the browser to read its token file back. */
const ROUTE_CHECK_READ_MS = 2_000;

/** Open a file for upload; rejects when it cannot be read. */
export async function openUploadSource(absolute: string): Promise<UploadSource> {
	const file = Bun.file(absolute);
	// A missing file reports size 0; stat rejects instead of uploading it empty.
	const { size } = await file.stat();
	const bunType = file.type.split(";")[0];
	const unknown = bunType === UNKNOWN_TYPE && !OCTET_STREAM_EXTENSIONS[path.extname(absolute).toLowerCase()];
	return {
		path: absolute,
		file,
		size,
		info: { name: path.basename(absolute), type: unknown ? "" : bunType, lastModified: file.lastModified },
	};
}

/** Open every file of one upload, in order. */
export async function openUploadSources(absolutePaths: string[], signal?: AbortSignal): Promise<UploadSource[]> {
	const sources: UploadSource[] = [];
	for (const absolute of absolutePaths) {
		throwIfAborted(signal);
		sources.push(await openUploadSource(absolute));
	}
	return sources;
}

/** Read whole files into payloads for one call into the page. */
export async function readFilePayloads(absolutePaths: string[], signal?: AbortSignal): Promise<FilePayload[]> {
	const payloads: FilePayload[] = [];
	for (const { file, info } of await openUploadSources(absolutePaths, signal)) {
		throwIfAborted(signal);
		payloads.push({ ...info, data: Buffer.from(await file.arrayBuffer()).toString("base64") });
	}
	return payloads;
}

/**
 * Set a file input's files to `paths` through `DOM.setFileInputFiles`; the browser reads them itself. Raw CDP rather than
 * `ElementHandle.uploadFile`, which an actionable handle routes back through the upload helpers.
 */
export async function setFileInputPaths(input: ElementHandle, paths: string[]): Promise<void> {
	await input.frame.client.send("DOM.setFileInputFiles", { objectId: input.remoteObject().objectId, files: paths });
}

/** A detached file input's page side; this package type-checks without the DOM lib. */
interface PagePicker {
	type: string;
	multiple: boolean;
	readonly files: ArrayLike<{ text(): Promise<string> }> | null;
}

interface PickerGlobals {
	document: { createElement(tag: "input"): PagePicker };
}

/** Create a detached `<input type=file multiple>`. Runs in the page, in the isolated world. */
export function createFilePicker(): PagePicker {
	const { document } = globalThis as unknown as PickerGlobals;
	const input = document.createElement("input");
	input.type = "file";
	input.multiple = true;
	return input;
}

/** A picker's files, as an array. Runs in the page. */
export function pickedFiles(picker: PagePicker): unknown[] {
	return Array.from(picker.files ?? []);
}

/** The text of a picker's first file. Runs in the page. */
function readFirstPickedFile(picker: PagePicker): Promise<string> | string {
	const file = picker.files?.[0];
	return file ? file.text() : "";
}

/**
 * One tab's upload state: its staging directory, and the route a one-time check picked for its browser connection.
 * The staged copies stay until the tab closes, since Chrome reads a picked file lazily.
 */
export class UploadStaging {
	#directory: Promise<string> | undefined;
	#route: Promise<UploadRoute> | undefined;

	/**
	 * The route for this connection, checked on the first upload: the browser gets a token file's path through
	 * `DOM.setFileInputFiles` on a detached input and must read it back. `Not allowed`, a failed or late read, or other
	 * contents mean it cannot open omp's files.
	 */
	route(page: Page, signal?: AbortSignal): Promise<UploadRoute> {
		this.#route ??= this.#checkRoute(page).catch(error => {
			// A check cut short (navigation, a closed target) decided nothing; the next upload checks again.
			this.#route = undefined;
			throw error;
		});
		const route = this.#route;
		return untilAborted(signal, () => route);
	}

	/** Copy files or folders into the staging directory, keeping names and mtimes, and return the copies' paths. */
	async stage(sources: UploadSource[], signal?: AbortSignal): Promise<string[]> {
		const directory = await this.#ensureDirectory();
		const staged: string[] = [];
		for (const source of sources) {
			throwIfAborted(signal);
			const folder = await fs.mkdtemp(path.join(directory, "f-"));
			const copy = path.join(folder, source.info.name);
			// A clone where the filesystem supports one (APFS, btrfs, XFS), a plain copy elsewhere. A folder, which
			// Chrome expands for a `webkitdirectory` input, is copied whole.
			await fs.cp(source.path, copy, {
				recursive: true,
				preserveTimestamps: true,
				mode: fs.constants.COPYFILE_FICLONE,
			});
			staged.push(copy);
		}
		return staged;
	}

	/** Remove the staged copies. */
	async dispose(): Promise<void> {
		const directory = this.#directory;
		this.#directory = undefined;
		if (!directory) return;
		await fs.rm(await directory, { recursive: true, force: true }).catch(() => undefined);
	}

	#ensureDirectory(): Promise<string> {
		this.#directory ??= fs.mkdtemp(path.join(os.tmpdir(), "omp-uploads-"));
		return this.#directory;
	}

	async #checkRoute(page: Page): Promise<UploadRoute> {
		const token = crypto.randomUUID();
		const tokenPath = path.join(await this.#ensureDirectory(), "route-check");
		await Bun.write(tokenPath, token);
		const picker = await page.mainFrame().isolatedRealm().evaluateHandle(createFilePicker);
		try {
			const input = picker.asElement();
			if (!input) throw new Error("The upload route check could not create a file input");
			try {
				await setFileInputPaths(input, [tokenPath]);
			} catch (error) {
				// Chrome refuses every path to a client without file access (a relay extension by default).
				if (error instanceof Error && error.message.includes("Not allowed")) return "contents";
				throw error;
			}
			const text = await withTimeout(
				picker.evaluate(readFirstPickedFile),
				ROUTE_CHECK_READ_MS,
				"upload route check read timed out",
			).catch(() => null);
			return text === token ? "paths" : "contents";
		} finally {
			await picker.dispose().catch(() => undefined);
			await fs.rm(tokenPath, { force: true }).catch(() => undefined);
		}
	}
}
