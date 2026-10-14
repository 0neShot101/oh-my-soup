/**
 * Identity of the omp build running in this process, stamped into session files so a
 * transcript records which code produced each entry.
 *
 * Releases record only their version: a release tag maps it back to one commit. A source
 * checkout records the commit, branch, and a hash of its uncommitted diff, because its
 * version string stays the same across every unreleased commit and local edit.
 */
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { $env, isCompiledBinary, logger, VERSION } from "@oh-my-pi/pi-utils";
import type { SessionEntry } from "./session-entries";

export interface RuntimeIdentity {
	/** omp package version. */
	version: string;
	/** Source checkout commit; absent for releases and exact release-tag checkouts. */
	commit?: string;
	/** Source checkout branch; absent on a detached HEAD. */
	branch?: string;
	/** Hash of the checkout's uncommitted tracked changes (`git diff HEAD`); absent when clean. */
	diff?: string;
	/** Free-form name from `OMP_BUILD_LABEL`. */
	label?: string;
}

const MAX_LABEL_LENGTH = 80;
const MAX_DIFF_BYTES = 64 * 1024 * 1024;
const SOURCE_PACKAGE_PREFIX = "packages/coding-agent/";

const envLabel = $env.OMP_BUILD_LABEL?.trim();
let current: RuntimeIdentity = { version: VERSION, label: envLabel ? envLabel.slice(0, MAX_LABEL_LENGTH) : undefined };

async function resolveSourceIdentity(): Promise<void> {
	// Compiled binaries and package-manager installs have no checkout of their own; a git
	// repository found above a node_modules install belongs to some other project.
	if (isCompiledBinary() || import.meta.dir.split(/[\\/]/).includes("node_modules")) return;
	const repo = vcs.git(import.meta.dir);
	if (!repo?.prefixOf(import.meta.dir)?.startsWith(SOURCE_PACKAGE_PREFIX)) return;
	const head = repo.headSync();
	if (!head.commit) return;
	const [patch, tags] = await Promise.all([
		repo.diffText({ base: "HEAD", binary: true, maxBytes: MAX_DIFF_BYTES }),
		repo.tagsAt("HEAD"),
	]);
	if (!patch && tags.includes(`v${VERSION}`)) return;
	current = {
		version: VERSION,
		commit: head.commit,
		branch: head.branch ?? undefined,
		diff: patch ? Bun.hash(patch).toString(16).padStart(16, "0") : undefined,
		label: current.label,
	};
}

const ready = resolveSourceIdentity().catch(error => {
	logger.debug("Could not resolve source checkout identity", { error: String(error) });
});

/** Settles once source-checkout details are resolved; await before creating sessions. */
export function loadRuntimeIdentity(): Promise<void> {
	return ready;
}

/** Build identity of this process; version and label only until {@link loadRuntimeIdentity} settles. */
export function currentRuntimeIdentity(): RuntimeIdentity {
	return current;
}

export function sameRuntimeIdentity(
	a: RuntimeIdentity | null | undefined,
	b: RuntimeIdentity | null | undefined,
): boolean {
	if (!a || !b) return !a && !b;
	return (
		a.version === b.version &&
		a.commit === b.commit &&
		a.branch === b.branch &&
		a.diff === b.diff &&
		a.label === b.label
	);
}

/**
 * Builds that wrote the entries, in file order, collapsing consecutive repeats. `null` stands
 * for entries without a stamp (written before builds were recorded, or replicated without one).
 */
export function runtimeIdentityHistory(entries: readonly SessionEntry[]): Array<RuntimeIdentity | null> {
	const history: Array<RuntimeIdentity | null> = [];
	for (const entry of entries) {
		const writer = entry.runtime ?? null;
		if (history.length === 0 || !sameRuntimeIdentity(writer, history[history.length - 1])) history.push(writer);
	}
	return history;
}

/** One-line label, e.g. `18.10.4`, `18.10.4 will/topic@a1b2c3d4e5 +diff 3f2a9c01 "variant-a"`. */
export function formatRuntimeIdentity(identity: RuntimeIdentity | null | undefined): string {
	if (!identity) return "unknown";
	let text = identity.version;
	if (identity.commit) text += ` ${identity.branch ? `${identity.branch}@` : ""}${identity.commit.slice(0, 10)}`;
	if (identity.diff) text += ` +diff ${identity.diff.slice(0, 8)}`;
	if (identity.label) text += ` "${identity.label}"`;
	return text;
}
