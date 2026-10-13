/**
 * In-place transparent filesystem compression for cold session files.
 *
 * Compressed files keep their path, bytes, and mtime; the filesystem inflates
 * them on read, so every session reader works unchanged. A later write stores
 * the file uncompressed again. Only APFS is supported: `ditto --hfsCompression`
 * ships with macOS and writes compressed copies that are verified and renamed
 * over the originals.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import { sha256File } from "../utils/file-hash";

/**
 * Scratch directory created beside the files of one batch. A crashed run can
 * leave one behind; the next `omp gc --compress` removes it.
 */
export const COMPRESS_SCRATCH_DIR = ".omp-gc-compress.tmp";
const SCRATCH_GLOB = new Bun.Glob(`**/${COMPRESS_SCRATCH_DIR}`);

/** Formats whose bytes are already compressed; APFS would store them as-is. */
const INCOMPRESSIBLE_EXTENSIONS: Record<string, true> = {
	".gz": true,
	".zst": true,
	".png": true,
	".jpg": true,
	".jpeg": true,
	".webp": true,
	".gif": true,
};

/** Bounded argv per `ditto` spawn. */
const DITTO_BATCH = 256;

export interface CompressCandidate {
	path: string;
	bytes: number;
	/** Bytes allocated on disk before compression. */
	allocated: number;
	mtimeMs: number;
}

export interface CompressBatchResult {
	compressed: number;
	/** Bytes allocated on disk by the processed candidates afterwards. */
	allocatedAfter: number;
	errors: string[];
}

export function transparentCompressionSupported(platform: NodeJS.Platform = process.platform): boolean {
	return platform === "darwin";
}

/**
 * Whether `file` should be compressed: a regular file larger than one
 * filesystem block, in a compressible format, and not already stored
 * compressed. A single-block file cannot shrink. A compressed APFS file
 * allocates fewer blocks than its logical size; session files are never
 * sparse, so that comparison identifies them.
 */
export async function compressCandidate(file: string): Promise<CompressCandidate | undefined> {
	if (INCOMPRESSIBLE_EXTENSIONS[path.extname(file).toLowerCase()]) return undefined;
	const stat = await fs.lstat(file);
	if (!stat.isFile() || stat.size <= stat.blksize) return undefined;
	const allocated = stat.blocks * 512;
	if (allocated < stat.size) return undefined;
	return { path: file, bytes: stat.size, allocated, mtimeMs: stat.mtimeMs };
}

/**
 * Count, and with `apply` remove, scratch directories under `roots`. Only a
 * killed run leaves one behind; the caller's gc lock rules out a live one.
 */
export async function sweepCompressScratch(roots: string[], apply: boolean, errors: string[]): Promise<number> {
	let found = 0;
	for (const root of roots) {
		const dirs: string[] = [];
		try {
			for await (const name of SCRATCH_GLOB.scan({ cwd: root, dot: true, onlyFiles: false })) {
				dirs.push(path.join(root, name));
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(`${root}: ${String(error)}`);
			continue;
		}
		for (const dir of dirs) {
			found += 1;
			if (!apply) continue;
			try {
				await fs.rm(dir, { recursive: true, force: true });
			} catch (error) {
				errors.push(`${dir}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	return found;
}

/**
 * Compress `candidates` in place. Each directory's files are copied with
 * compression into a scratch directory beside them, and a copy replaces its
 * original only when its size and SHA-256 match and the original is unchanged
 * since it was selected. The caller must hold whatever lease keeps writers off
 * these files.
 */
export async function compressFilesInPlace(candidates: CompressCandidate[]): Promise<CompressBatchResult> {
	const result: CompressBatchResult = { compressed: 0, allocatedAfter: 0, errors: [] };
	const byDir = new Map<string, CompressCandidate[]>();
	for (const candidate of candidates) {
		const dir = path.dirname(candidate.path);
		const group = byDir.get(dir);
		if (group) group.push(candidate);
		else byDir.set(dir, [candidate]);
	}
	for (const [dir, group] of byDir) {
		for (let start = 0; start < group.length; start += DITTO_BATCH) {
			await compressBatch(dir, group.slice(start, start + DITTO_BATCH), result);
		}
	}
	return result;
}

async function compressBatch(dir: string, batch: CompressCandidate[], result: CompressBatchResult): Promise<void> {
	// Every candidate counts at its current allocation until its compressed copy replaces it,
	// so failed and skipped files are still reported as occupying disk.
	for (const candidate of batch) result.allocatedAfter += candidate.allocated;
	const scratch = path.join(dir, COMPRESS_SCRATCH_DIR);
	try {
		await fs.rm(scratch, { recursive: true, force: true });
		await fs.mkdir(scratch);
		const digests = await Promise.all(batch.map(candidate => sha256File(candidate.path)));
		const copy = await $`ditto --hfsCompression ${batch.map(candidate => candidate.path)} ${scratch}`
			.quiet()
			.nothrow();
		if (copy.exitCode !== 0) {
			result.errors.push(`${dir}: ditto exited ${copy.exitCode}: ${copy.stderr.toString().trim()}`);
			return;
		}
		for (const [index, candidate] of batch.entries()) {
			const copyPath = path.join(scratch, path.basename(candidate.path));
			try {
				const current = await fs.lstat(candidate.path);
				if (current.size !== candidate.bytes || current.mtimeMs !== candidate.mtimeMs) continue;
				const copied = await fs.lstat(copyPath);
				if (copied.size !== candidate.bytes || (await sha256File(copyPath)) !== digests[index]) {
					result.errors.push(`${candidate.path}: compressed copy does not match the original`);
					continue;
				}
				// Incompressible: APFS stored the copy uncompressed, so the original stays.
				if (copied.blocks * 512 >= candidate.allocated) continue;
				// ditto already copied the nanosecond atime and mtime; the rename keeps them.
				await fs.rename(copyPath, candidate.path);
				result.compressed += 1;
				result.allocatedAfter += copied.blocks * 512 - candidate.allocated;
			} catch (error) {
				result.errors.push(`${candidate.path}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	} catch (error) {
		result.errors.push(`${dir}: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		await fs.rm(scratch, { recursive: true, force: true });
	}
}
