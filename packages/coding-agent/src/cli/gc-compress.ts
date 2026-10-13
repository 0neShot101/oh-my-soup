/**
 * In-place transparent filesystem compression for cold session files.
 *
 * Compressed files keep their path, bytes, and mtime; the filesystem inflates
 * them on read, so every session reader works unchanged. A later write stores
 * the file uncompressed again. Supported filesystems:
 *
 * - APFS (macOS): `ditto --hfsCompression` writes compressed copies that are
 *   verified and renamed over the originals.
 * - NTFS (Windows): `compact /exe:lzx` compresses each file in place.
 * - btrfs (Linux): `btrfs filesystem defragment -czstd` recompresses each file
 *   in place; `filefrag` reports which files are stored compressed.
 *
 * The in-place tools run in the kernel, so the file keeps its inode and
 * timestamps and no copy is ever swapped in.
 */
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import { FileSessionStorage } from "../session/session-storage";
import { sha256File } from "../utils/file-hash";

/**
 * Name prefix of the scratch directory `mkdtemp` creates beside the files of
 * one APFS batch. A crashed run can leave one behind; the next
 * `omp gc --compress --apply` removes it.
 */
export const COMPRESS_SCRATCH_PREFIX = ".omp-gc-compress-";
const SCRATCH_GLOB = new Bun.Glob(`**/${COMPRESS_SCRATCH_PREFIX}*`);
/**
 * Written into each scratch directory before anything else, so the sweep
 * recursively removes only directories gc created; a session artifact can
 * carry any name.
 */
const SCRATCH_OWNER_MARKER = ".omp-gc-compress-owner";

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

/** Bounded argv per tool spawn; Windows caps a command line at 32K characters. */
const DITTO_BATCH = 256;
const IN_PLACE_BATCH = 64;

const BTRFS_SUPER_MAGIC = 0x9123683e;

/** How this machine compresses files in place: the filesystem the sessions live on. */
export type CompressMethod = "apfs" | "ntfs" | "btrfs";

export interface CompressCandidate {
	path: string;
	bytes: number;
	/** Bytes allocated on disk before compression. */
	allocated: number;
	mtimeMs: number;
	/** Identity at selection; a file that no longer matches is left alone. */
	mtimeNs: bigint;
	ino: bigint;
}

export interface CompressBatchResult {
	compressed: number;
	/** Bytes allocated on disk by the processed candidates afterwards. */
	allocatedAfter: number;
	errors: string[];
}

/**
 * The compression method for files under `dir`, or undefined when its
 * filesystem has no transparent compression this phase drives. On Windows,
 * `compact` reports a non-NTFS volume as a per-file error.
 */
export async function compressMethod(
	dir: string,
	platform: NodeJS.Platform = process.platform,
): Promise<CompressMethod | undefined> {
	if (platform === "darwin") return "apfs";
	if (platform === "win32") return "ntfs";
	if (platform !== "linux") return undefined;
	try {
		if ((await fs.statfs(dir)).type !== BTRFS_SUPER_MAGIC) return undefined;
	} catch {
		return undefined;
	}
	return Bun.which("btrfs") && Bun.which("filefrag") ? "btrfs" : undefined;
}

/**
 * Whether `file` should be compressed: a regular file larger than one
 * filesystem block, in a compressible format, and not already stored
 * compressed. A single-block file cannot shrink. A compressed APFS or NTFS
 * file allocates fewer blocks than its logical size; session files are never
 * sparse, so that comparison identifies them. btrfs reports logical blocks,
 * so `dropCompressed` filters its candidates.
 */
export async function compressCandidate(file: string): Promise<CompressCandidate | undefined> {
	if (INCOMPRESSIBLE_EXTENSIONS[path.extname(file).toLowerCase()]) return undefined;
	const stat = await fs.lstat(file, { bigint: true });
	if (!stat.isFile() || stat.size <= stat.blksize) return undefined;
	const allocated = Number(stat.blocks) * 512;
	if (allocated < stat.size) return undefined;
	return {
		path: file,
		bytes: Number(stat.size),
		allocated,
		mtimeMs: Number(stat.mtimeMs),
		mtimeNs: stat.mtimeNs,
		ino: stat.ino,
	};
}

/**
 * Count, and with `apply` remove, scratch directories under `roots` that a
 * killed run left behind; the caller's gc lock rules out a live one. Only a
 * directory holding the owner marker is removed recursively. An unmarked one
 * is gc's only while empty (a run killed before writing the marker).
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
			try {
				if (!(await fs.lstat(dir)).isDirectory()) continue;
				const owned = await fs.exists(path.join(dir, SCRATCH_OWNER_MARKER));
				if (!owned && (await fs.readdir(dir)).length > 0) continue;
				found += 1;
				if (!apply) continue;
				if (owned) await fs.rm(dir, { recursive: true, force: true });
				else await fs.rmdir(dir);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				errors.push(`${dir}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	return found;
}

/** Paths among `files` that btrfs stores with at least one compressed extent. */
async function btrfsCompressedPaths(files: string[]): Promise<Set<string>> {
	const compressed = new Set<string>();
	for (let start = 0; start < files.length; start += IN_PLACE_BATCH) {
		const out = await $`filefrag -v ${files.slice(start, start + IN_PLACE_BATCH)}`.quiet().nothrow();
		let current: string | undefined;
		for (const line of out.stdout.toString().split("\n")) {
			if (line.startsWith("File size of ")) current = line.slice("File size of ".length, line.lastIndexOf(" is "));
			else if (current !== undefined && line.includes("encoded")) compressed.add(current);
		}
	}
	return compressed;
}

/** `candidates` minus files already stored compressed that block counts cannot reveal (btrfs). */
export async function dropCompressed(
	candidates: CompressCandidate[],
	method: CompressMethod,
): Promise<CompressCandidate[]> {
	if (method !== "btrfs" || candidates.length === 0) return candidates;
	const compressed = await btrfsCompressedPaths(candidates.map(candidate => candidate.path));
	return candidates.filter(candidate => !compressed.has(candidate.path));
}

/**
 * Compress `candidates` in place. The caller must hold whatever lease keeps
 * writers off these files.
 *
 * APFS: each directory's files are copied with compression into a scratch
 * directory beside them, and a copy replaces its original only when its size
 * and SHA-256 match and the original is unchanged since it was selected.
 * NTFS and btrfs: the kernel compresses each file in place.
 */
export async function compressFilesInPlace(
	candidates: CompressCandidate[],
	method: CompressMethod,
): Promise<CompressBatchResult> {
	const result: CompressBatchResult = { compressed: 0, allocatedAfter: 0, errors: [] };
	if (method !== "apfs") {
		for (let start = 0; start < candidates.length; start += IN_PLACE_BATCH) {
			await compressInPlaceBatch(candidates.slice(start, start + IN_PLACE_BATCH), method, result);
		}
		return result;
	}
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

async function compressInPlaceBatch(
	batch: CompressCandidate[],
	method: Exclude<CompressMethod, "apfs">,
	result: CompressBatchResult,
): Promise<void> {
	for (const candidate of batch) result.allocatedAfter += candidate.allocated;
	const files = batch.map(candidate => candidate.path);
	// btrfs defragment skips pages still awaiting writeback, so flush them first.
	if (method === "btrfs") {
		await Promise.all(
			files.map(file =>
				flushFile(file).catch(error => {
					result.errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
				}),
			),
		);
	}
	// Both tools keep the inode and timestamps. `compact` skips, and exits
	// nonzero for, a file another process holds open.
	const run =
		method === "ntfs"
			? await $`compact /c /exe:lzx /q ${files}`.quiet().nothrow()
			: await $`btrfs filesystem defragment -czstd ${files}`.quiet().nothrow();
	if (run.exitCode !== 0) {
		const output = `${run.stdout.toString()}${run.stderr.toString()}`.trim().split("\n").slice(-3).join(" ");
		result.errors.push(`${method === "ntfs" ? "compact" : "btrfs defragment"} exited ${run.exitCode}: ${output}`);
	}
	const btrfsCompressed = method === "btrfs" ? await btrfsCompressedPaths(files) : undefined;
	for (const candidate of batch) {
		try {
			const stat = await fs.lstat(candidate.path);
			if (btrfsCompressed) {
				if (btrfsCompressed.has(candidate.path)) result.compressed += 1;
			} else if (stat.blocks * 512 < candidate.allocated) {
				result.compressed += 1;
				result.allocatedAfter += stat.blocks * 512 - candidate.allocated;
			}
		} catch (error) {
			result.errors.push(`${candidate.path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

async function flushFile(file: string): Promise<void> {
	const handle = await fs.open(file, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/** The file at `candidate.path` is still the one selected: same inode, size, and mtime. */
function unchangedSinceSelection(candidate: CompressCandidate): boolean {
	const current = fsSync.lstatSync(candidate.path, { bigint: true });
	return (
		current.ino === candidate.ino && current.size === BigInt(candidate.bytes) && current.mtimeNs === candidate.mtimeNs
	);
}

/**
 * Rename `copyPath` over `candidate.path` if the original is unchanged, checked
 * immediately before the rename. Transcripts (`.jsonl`) swap under the session
 * publish lock, which serializes them against appends from any omp binary.
 */
function swapIfUnchanged(storage: FileSessionStorage, candidate: CompressCandidate, copyPath: string): boolean {
	if (candidate.path.endsWith(".jsonl")) {
		return storage.replaceSessionFileSync(candidate.path, copyPath, () => unchangedSinceSelection(candidate));
	}
	if (!unchangedSinceSelection(candidate)) return false;
	fsSync.renameSync(copyPath, candidate.path);
	return true;
}

async function compressBatch(dir: string, batch: CompressCandidate[], result: CompressBatchResult): Promise<void> {
	// Every candidate counts at its current allocation until its compressed copy replaces it,
	// so failed and skipped files are still reported as occupying disk.
	for (const candidate of batch) result.allocatedAfter += candidate.allocated;
	let scratch: string | undefined;
	try {
		// A fresh directory: a pre-existing one with this name is never gc's to remove.
		scratch = await fs.mkdtemp(path.join(dir, COMPRESS_SCRATCH_PREFIX));
		await Bun.write(path.join(scratch, SCRATCH_OWNER_MARKER), "");
		const digests = await Promise.all(batch.map(candidate => sha256File(candidate.path)));
		const copy = await $`ditto --hfsCompression ${batch.map(candidate => candidate.path)} ${scratch}`
			.quiet()
			.nothrow();
		if (copy.exitCode !== 0) {
			result.errors.push(`${dir}: ditto exited ${copy.exitCode}: ${copy.stderr.toString().trim()}`);
			return;
		}
		const storage = new FileSessionStorage();
		for (const [index, candidate] of batch.entries()) {
			const copyPath = path.join(scratch, path.basename(candidate.path));
			try {
				const copied = await fs.lstat(copyPath);
				if (copied.size !== candidate.bytes || (await sha256File(copyPath)) !== digests[index]) {
					result.errors.push(`${candidate.path}: compressed copy does not match the original`);
					continue;
				}
				// Incompressible: APFS stored the copy uncompressed, so the original stays.
				if (copied.blocks * 512 >= candidate.allocated) continue;
				// ditto copied the nanosecond mtime; the rename keeps it.
				if (!swapIfUnchanged(storage, candidate, copyPath)) continue;
				result.compressed += 1;
				result.allocatedAfter += copied.blocks * 512 - candidate.allocated;
			} catch (error) {
				result.errors.push(`${candidate.path}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	} catch (error) {
		result.errors.push(`${dir}: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		if (scratch !== undefined) await fs.rm(scratch, { recursive: true, force: true });
	}
}
