import * as path from "node:path";
import { normalizePathForComparison } from "@oh-my-soup/pi-utils/dirs";
import type { SessionInfo } from "../session/session-listing";
import type { LiveServiceSession } from "./control";

function sessionPathKey(file: string): string {
	return normalizePathForComparison(path.resolve(file));
}

/** Find a service-owned process by its exact session file, never by a stale tail status or ID prefix. */
export function liveSessionForPath(
	file: string,
	sessions: readonly LiveServiceSession[],
): LiveServiceSession | undefined {
	const key = sessionPathKey(file);
	return sessions.find(session => sessionPathKey(session.sessionPath) === key);
}

/** Resolve CLI/slash-command identity without requiring a live session to have written its first turn. */
export function liveSessionForIdentifier(
	identifier: string,
	sessions: readonly LiveServiceSession[],
): LiveServiceSession | undefined {
	if (identifier.includes("/") || identifier.includes("\\") || identifier.endsWith(".jsonl"))
		return liveSessionForPath(identifier, sessions);
	const prefix = identifier.toLowerCase();
	let match: LiveServiceSession | undefined;
	for (const session of sessions) {
		if (!session.id.toLowerCase().startsWith(prefix)) continue;
		if (match) throw new Error(`Session "${identifier}" is ambiguous; use a longer ID`);
		match = session;
	}
	return match;
}

/** Overlay live host state on saved-session metadata, hiding sessions with no messages sent. */
export function markLiveSessions(
	sessions: SessionInfo[],
	liveSessions: readonly LiveServiceSession[],
	_sessionDir?: string,
): SessionInfo[] {
	const nonEmpty = sessions.filter(
		session => session.messageCount > 0 || (session.firstMessage !== "" && session.firstMessage !== "(no messages)"),
	);
	if (liveSessions.length === 0) return nonEmpty;
	const byPath = new Map(liveSessions.map(session => [sessionPathKey(session.sessionPath), session]));
	return nonEmpty.map(session => {
		const key = sessionPathKey(session.path);
		if (!byPath.has(key)) return session;
		return { ...session, status: "running" as const };
	});
}
