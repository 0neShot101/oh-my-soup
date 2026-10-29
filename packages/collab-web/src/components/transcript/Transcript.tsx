import type { AssistantMessage, ImageContent, SessionEntry, TextContent, ToolResultMessage } from "@oh-my-soup/pi-wire";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ActiveTool, ConnectionPhase } from "../../lib/client";
import { fmtTokens } from "../../lib/format";
import type { ToolRenderHost } from "../../tool-render";
import { Markdown, StreamingMarkdown } from "./Markdown";
import { ToolCard } from "./ToolCard";
import "./transcript.css";

export interface TranscriptProps {
	entries: readonly SessionEntry[];
	stream: AssistantMessage | null;
	streamDone: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	working: boolean;
	compact?: boolean; // dense variant for the agent drawer
	/** Sub-session drill-down capabilities forwarded to tool renderers. */
	host?: ToolRenderHost;
	/** Main connection phase; absent for the agent drawer's compact transcript. */
	phase?: ConnectionPhase;
	/** Historical host pages never tail-follow or display current work. */
	atLatest?: boolean;
}

interface ScrollGeometry {
	scrollTop: number;
	readonly scrollHeight: number;
	readonly clientHeight: number;
}

interface TailLock {
	current: boolean;
}

/** Scroll to the tail while locked; `force` re-arms the lock for a `live` transition. */
export function followTranscriptTail(element: ScrollGeometry, lock: TailLock, force = false): void {
	if (force) lock.current = true;
	if (lock.current) element.scrollTop = element.scrollHeight;
}

/** Re-derive the lock from current scroll geometry (locked within 40px of the bottom). */
export function updateTranscriptTailLock(element: ScrollGeometry, lock: TailLock): void {
	lock.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 40;
}

function Row({
	kind,
	gutter,
	title,
	children,
}: {
	kind: "user" | "assistant" | "custom" | "marker";
	gutter: ReactNode;
	title?: string;
	children: ReactNode;
}): ReactNode {
	return (
		<div className={`tr-row tr-row--${kind}`}>
			<div className="tr-gutter" title={title}>
				{gutter}
			</div>
			<div className="tr-body">{children}</div>
		</div>
	);
}

function ThinkingBlock({ text, redacted }: { text: string; redacted?: boolean }): ReactNode {
	const [open, setOpen] = useState(false);
	return (
		<div className="tr-think">
			<button type="button" className="tr-think-head" onClick={() => setOpen(v => !v)}>
				<ChevronRight size={11} className={`tr-chev${open ? " tr-chev--open" : ""}`} />
				thinking{redacted ? " · redacted" : ""}
			</button>
			{open && <div className="tr-think-body">{redacted ? "(redacted by provider)" : text}</div>}
		</div>
	);
}

/** Markdown + image thumbnails for user / custom message content. */
function MsgContent({ content }: { content: string | readonly (TextContent | ImageContent)[] }): ReactNode {
	if (typeof content === "string") return <Markdown text={content} />;
	return (
		<>
			{content.map((block, i) => {
				switch (block.type) {
					case "text":
						return <Markdown key={i} text={block.text} />;
					case "image":
						return (
							<img
								key={i}
								className="tr-msg-img"
								src={`data:${block.mimeType};base64,${block.data}`}
								alt="attachment"
							/>
						);
					default:
						return null;
				}
			})}
		</>
	);
}

function AssistantBody({
	message,
	results,
	active,
	pending,
	host,
}: {
	message: AssistantMessage;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	/** Still streaming — suppress stop-reason chips on the partial message. */
	pending: boolean;
	host?: ToolRenderHost;
}): ReactNode {
	const blocks = message.content.map((block, i) => {
		switch (block.type) {
			case "thinking":
				return <ThinkingBlock key={i} text={block.thinking} />;
			case "redactedThinking":
				return <ThinkingBlock key={i} text="" redacted />;
			case "text":
				return pending ? <StreamingMarkdown key={i} text={block.text} /> : <Markdown key={i} text={block.text} />;
			case "toolCall": {
				const act = active.get(block.id);
				const result = results.get(block.id);
				const args = act?.args ?? block.arguments;
				return (
					<div key={block.id} className="tr-tool">
						<ToolCard
							toolCallId={block.id}
							name={block.name}
							intent={block.intent ?? act?.intent}
							args={args}
							result={result}
							host={host}
							running={!result && (act !== undefined || pending)}
							partialResult={act?.partialResult}
						/>
						{!result && act === undefined && !pending && (
							<div className="tr-marker">Result not on this page.</div>
						)}
					</div>
				);
			}
			default:
				return null;
		}
	});
	const stop = message.stopReason;
	const failed = !pending && (stop === "error" || stop === "aborted");
	return (
		<>
			{blocks}
			{failed && (
				<div className="tr-stop">
					<span className={`tr-chip ${stop === "error" ? "tr-chip--err" : "tr-chip--warn"}`}>{stop}</span>
					{message.errorMessage !== undefined && message.errorMessage.length > 0 && (
						<span className="tr-stop-msg">{message.errorMessage}</span>
					)}
				</div>
			)}
		</>
	);
}

interface EntryRowProps {
	entry: SessionEntry;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	host?: ToolRenderHost;
	pairedToolIds: ReadonlySet<string>;
}

/** Re-render only when the entry itself or one of its tool pairings changed. */
function entryRowEqual(prev: EntryRowProps, next: EntryRowProps): boolean {
	if (prev.entry !== next.entry || prev.host !== next.host) return false;
	const e = next.entry;
	if (e.type === "message" && e.message.role === "toolResult") {
		return prev.pairedToolIds.has(e.message.toolCallId) === next.pairedToolIds.has(e.message.toolCallId);
	}
	if (e.type !== "message" || e.message.role !== "assistant") return true;
	for (const block of e.message.content) {
		if (block.type !== "toolCall") continue;
		if (prev.results.get(block.id) !== next.results.get(block.id)) return false;
		if (prev.active.get(block.id) !== next.active.get(block.id)) return false;
	}
	return true;
}

const EntryRow = memo(function EntryRow({ entry, results, active, pairedToolIds, host }: EntryRowProps): ReactNode {
	switch (entry.type) {
		case "message": {
			const msg = entry.message;
			switch (msg.role) {
				case "user":
					return (
						<Row kind="user" gutter="host" title={entry.timestamp}>
							<MsgContent content={msg.content} />
						</Row>
					);
				case "assistant":
					return (
						<Row kind="assistant" gutter="agent" title={entry.timestamp}>
							<AssistantBody message={msg} results={results} active={active} pending={false} host={host} />
						</Row>
					);
				case "toolResult":
					if (pairedToolIds.has(msg.toolCallId)) return null;
					return (
						<Row kind="assistant" gutter="tool" title={entry.timestamp}>
							<ToolCard
								toolCallId={msg.toolCallId}
								name={msg.toolName}
								args={undefined}
								result={msg}
								host={host}
							/>
						</Row>
					);
				default:
					// Developer & unknown roles are not transcript rows.
					return null;
			}
		}
		case "custom_message": {
			if (entry.customType === "collab-prompt") {
				const details = entry.details;
				const from =
					details !== null &&
					typeof details === "object" &&
					typeof (details as Record<string, unknown>).from === "string"
						? ((details as Record<string, unknown>).from as string)
						: "guest";
				return (
					<Row kind="user" gutter={<span className="tr-badge">{from}</span>} title={entry.timestamp}>
						<MsgContent content={entry.content} />
					</Row>
				);
			}
			if (!entry.display) return null;
			return (
				<Row kind="custom" gutter="" title={entry.timestamp}>
					<div className="tr-custom">
						<span className="tr-chip">{entry.customType}</span>
						<MsgContent content={entry.content} />
					</div>
				</Row>
			);
		}
		case "compaction":
			return (
				<div className="tr-divider" title={entry.shortSummary ?? entry.summary}>
					<span>context compacted · {fmtTokens(entry.tokensBefore)} tokens</span>
				</div>
			);
		case "branch_summary":
			return (
				<div className="tr-divider" title={entry.summary}>
					<span>branch summary</span>
				</div>
			);
		case "model_change":
			return (
				<Row kind="marker" gutter="" title={entry.timestamp}>
					<span className="tr-marker">model → {entry.model}</span>
				</Row>
			);
		case "thinking_level_change":
			return (
				<Row kind="marker" gutter="" title={entry.timestamp}>
					<span className="tr-marker">thinking → {entry.thinkingLevel ?? "off"}</span>
				</Row>
			);
		default:
			// unknown entry types from newer hosts — skip tolerantly
			return null;
	}
}, entryRowEqual);

/** Overlapping windows keep a practical scroll anchor without growing mounted rows. */
const WINDOW = 100;
const WINDOW_STEP = WINDOW / 2;
const EARLIER_TRIGGER_PX = 200;
const NO_ACTIVE_TOOLS: ReadonlyMap<string, ActiveTool> = new Map();

export function transcriptWindow(
	entries: readonly SessionEntry[],
	pinnedId: string | null,
): {
	start: number;
	end: number;
	earlierId: string | null;
	newerId: string | null;
} {
	const tailStart = Math.max(0, entries.length - WINDOW);
	const pinnedIndex =
		pinnedId === null
			? tailStart
			: Math.max(
					0,
					entries.findIndex(entry => entry.id === pinnedId),
				);
	const start = Math.min(pinnedIndex, tailStart);
	const end = Math.min(entries.length, start + WINDOW);
	return {
		start,
		end,
		earlierId: start > 0 ? entries[Math.max(0, start - WINDOW_STEP)]!.id : null,
		newerId: end < entries.length ? entries[Math.min(tailStart, start + WINDOW_STEP)]!.id : null,
	};
}

interface ScrollAnchor {
	id: string;
	offset: number;
}

export function Transcript(props: TranscriptProps): ReactNode {
	const { entries, stream, streamDone, activeTools, working, compact, host, phase, atLatest = true } = props;
	// IDs, not indices, keep the reader pinned when the live page evicts its head.
	const [pinnedId, setPinnedId] = useState<string | null>(null);
	const { start, end, earlierId, newerId } = useMemo(() => transcriptWindow(entries, pinnedId), [entries, pinnedId]);
	const visible = useMemo(() => entries.slice(start, end), [entries, start, end]);
	const atTail = end === entries.length;
	const showLive = atLatest && atTail;
	const active = showLive ? activeTools : NO_ACTIVE_TOOLS;

	// A tool result always follows its call, so visible rows only pair with visible results.
	const results = useMemo(() => {
		const map = new Map<string, ToolResultMessage>();
		for (const entry of visible) {
			if (entry.type === "message" && entry.message.role === "toolResult") {
				map.set(entry.message.toolCallId, entry.message);
			}
		}
		return map;
	}, [visible]);

	const rootRef = useRef<HTMLDivElement | null>(null);
	const lockRef = useRef(atLatest);
	const lastScrollTopRef = useRef(0);
	const anchorRef = useRef<ScrollAnchor | null>(null);
	const navigationRef = useRef<{ anchor: ScrollAnchor | null; edge: "start" | "end" } | null>(null);

	const captureAnchor = (keep?: ReadonlySet<string>): ScrollAnchor | null => {
		const el = rootRef.current;
		if (el === null) return null;
		const top = el.getBoundingClientRect().top;
		for (const row of el.querySelectorAll<HTMLElement>("[data-entry-id]")) {
			const id = row.dataset.entryId;
			if (id === undefined || (keep !== undefined && !keep.has(id))) continue;
			const rect = row.getBoundingClientRect();
			if (rect.bottom > top) return { id, offset: rect.top - top };
		}
		return null;
	};

	useEffect(() => {
		const el = rootRef.current;
		if (el !== null && atLatest && atTail) {
			followTranscriptTail(el, lockRef);
			lastScrollTopRef.current = el.scrollTop;
		}
	}, [entries, stream, activeTools, working, atLatest, atTail, start]);

	// Reconnects return to live, but a historical page with phase=live does not.
	useEffect(() => {
		const el = rootRef.current;
		if (phase !== "live" || !atLatest || el === null) return;
		setPinnedId(null);
		followTranscriptTail(el, lockRef, true);
		lastScrollTopRef.current = el.scrollTop;
	}, [phase, atLatest]);

	useLayoutEffect(() => {
		const el = rootRef.current;
		if (el === null) return;
		const navigation = navigationRef.current;
		navigationRef.current = null;
		const before = navigation === null ? anchorRef.current : navigation.anchor;
		if (!lockRef.current) {
			const anchor =
				before &&
				Array.from(el.querySelectorAll<HTMLElement>("[data-entry-id]")).find(
					row => row.dataset.entryId === before.id,
				);
			if (anchor && before) {
				el.scrollTop += anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - before.offset;
			} else if (navigation !== null) {
				el.scrollTop = navigation.edge === "end" ? el.scrollHeight : 0;
			} else if (before !== null) {
				// The anchor aged out of a bounded live page. Stay at its oldest
				// retained row; Older still reaches every evicted entry.
				el.scrollTop = 0;
			}
		}
		lastScrollTopRef.current = el.scrollTop;
		anchorRef.current = captureAnchor();
	}, [entries, start, end]);

	const moveWindow = (id: string | null, edge: "start" | "end"): void => {
		if (id === null) return;
		const next = transcriptWindow(entries, id);
		const keep = new Set(entries.slice(next.start, next.end).map(entry => entry.id));
		navigationRef.current = { anchor: captureAnchor(keep), edge };
		lockRef.current = false;
		setPinnedId(id);
	};

	const showLatest = (): void => {
		lockRef.current = atLatest;
		navigationRef.current = { anchor: null, edge: "end" };
		setPinnedId(null);
	};

	// Scan only the mounted window; hidden history must not suppress a live tool.
	const committedToolIds = useMemo(() => {
		const ids = new Set<string>();
		for (const entry of visible) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			for (const block of entry.message.content) {
				if (block.type === "toolCall") ids.add(block.id);
			}
		}
		return ids;
	}, [visible]);

	const pairedToolIds = useMemo(() => {
		if (!showLive || stream === null) return committedToolIds;
		const ids = new Set(committedToolIds);
		for (const block of stream.content) {
			if (block.type === "toolCall") ids.add(block.id);
		}
		return ids;
	}, [committedToolIds, stream, showLive]);

	// Active tools not already represented as toolCall blocks in committed rows or the stream ghost.
	const tailTools = useMemo(() => {
		const tail: ActiveTool[] = [];
		if (!showLive) return tail;
		for (const tool of activeTools.values()) {
			if (committedToolIds.has(tool.toolCallId)) continue;
			if (stream?.content.some(block => block.type === "toolCall" && block.id === tool.toolCallId)) continue;
			tail.push(tool);
		}
		return tail;
	}, [committedToolIds, stream, activeTools, showLive]);

	// While the snapshot downloads the banner reports progress; an empty transcript isn't "no activity".
	const settled = phase === undefined || phase === "live";

	return (
		<div
			ref={rootRef}
			className={`tr-root${compact === true ? " tr-root--compact" : ""}`}
			onScroll={() => {
				const el = rootRef.current;
				if (el === null) return;
				const movingUp = el.scrollTop < lastScrollTopRef.current;
				lastScrollTopRef.current = el.scrollTop;
				if (atLatest && atTail) updateTranscriptTailLock(el, lockRef);
				else lockRef.current = false;
				anchorRef.current = captureAnchor();
				if (lockRef.current) {
					if (pinnedId !== null) setPinnedId(null);
				} else if (pinnedId === null) {
					setPinnedId(entries[start]?.id ?? null);
				}
				if (movingUp && el.scrollTop <= EARLIER_TRIGGER_PX) moveWindow(earlierId, "end");
			}}
		>
			{settled && entries.length === 0 && stream === null && !working && (
				<div className="tr-empty">no activity yet</div>
			)}
			{start > 0 && (
				<button type="button" className="tr-earlier" onClick={() => moveWindow(earlierId, "end")}>
					show {start.toLocaleString("en-US")} earlier
				</button>
			)}
			{visible.map(entry => (
				<div key={entry.id} data-entry-id={entry.id}>
					<EntryRow entry={entry} results={results} active={active} pairedToolIds={pairedToolIds} host={host} />
				</div>
			))}
			{newerId !== null && (
				<div className="tr-window-controls">
					<button type="button" className="tr-earlier" onClick={() => moveWindow(newerId, "start")}>
						show {Math.max(0, entries.length - end).toLocaleString("en-US")} newer
					</button>
					<button type="button" className="tr-earlier" onClick={showLatest}>
						latest
					</button>
				</div>
			)}
			{showLive && stream !== null && (
				<Row kind="assistant" gutter="agent">
					<AssistantBody
						message={stream}
						results={results}
						active={activeTools}
						pending={!streamDone}
						host={host}
					/>
				</Row>
			)}
			{tailTools.length > 0 && (
				<Row kind="assistant" gutter={stream === null ? "agent" : ""}>
					{tailTools.map(tool => (
						<ToolCard
							key={tool.toolCallId}
							toolCallId={tool.toolCallId}
							name={tool.toolName}
							intent={tool.intent}
							args={tool.args}
							running
							partialResult={tool.partialResult}
							host={host}
						/>
					))}
				</Row>
			)}
			{showLive && working && stream === null && activeTools.size === 0 && (
				<Row kind="assistant" gutter="agent">
					<div className="tr-shimmer">thinking…</div>
				</Row>
			)}
		</div>
	);
}
