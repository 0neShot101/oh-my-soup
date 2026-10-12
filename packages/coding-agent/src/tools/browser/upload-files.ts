import * as path from "node:path";
import type { BunFile } from "bun";
import { throwIfAborted } from "../tool-errors";

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
	file: BunFile;
	size: number;
	info: UploadFileInfo;
}

/** The type Bun gives an extension it does not know; a browser's own pick reports such a file with no type. */
const UNKNOWN_TYPE = "application/octet-stream";

/** Open a file for upload; rejects when it cannot be read. */
export async function openUploadSource(absolute: string): Promise<UploadSource> {
	const file = Bun.file(absolute);
	// A missing file reports size 0; stat rejects instead of uploading it empty.
	const { size } = await file.stat();
	const type = file.type.split(";")[0];
	return {
		file,
		size,
		info: { name: path.basename(absolute), type: type === UNKNOWN_TYPE ? "" : type, lastModified: file.lastModified },
	};
}

/** Read whole files into payloads for one call into the page. */
export async function readFilePayloads(absolutePaths: string[], signal?: AbortSignal): Promise<FilePayload[]> {
	const payloads: FilePayload[] = [];
	for (const absolute of absolutePaths) {
		throwIfAborted(signal);
		const { file, info } = await openUploadSource(absolute);
		payloads.push({ ...info, data: Buffer.from(await file.arrayBuffer()).toString("base64") });
	}
	return payloads;
}
