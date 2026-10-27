import { type } from "@oh-my-soup/omstype";
import {
	type AgentTool,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	TOOL_INTERRUPT_ABORT_REASON,
} from "@oh-my-soup/pi-agent-core";
import { formatDuration, prompt } from "@oh-my-soup/pi-utils";
import { IrcBus, IrcWaitCycleError } from "../irc/bus";
import waitDescription from "../prompts/tools/wait.md" with { type: "text" };
import waitNoMessageTemplate from "../prompts/tools/wait-no-message.md" with { type: "text" };
import type { ToolSession } from ".";
import type { AsyncJob, AsyncJobManager } from "../async/job-manager";
import {
	buildJobResult,
	describeAgents,
	runningAgentsOutsideJobs,
	snapshotJobs,
	undeliveredJobs,
} from "../async/job-control";
import { hasLiveOwnedService, listServicesTolerant, waitForOwnedServiceCompletion } from "../launch/services";
import { drainPendingInbox, messageResult } from "../irc/messaging";
import type { AgentRegistry } from "../registry/agent-registry";
import type { IrcMessage } from "@oh-my-soup/pi-tui/tools/irc";
import type { CoordinationDetails } from "@oh-my-soup/pi-tui/tools/wait";
import { throwIfAborted } from "./tool-errors";

import { cfgLaunchEnabled } from "./settings";

const waitSchema = type({});
const WAIT_MAX_MS = 30 * 60_000;
const PROGRESS_INTERVAL_MS = 500;
const MESSAGE_WAIT_LADDER_MS = [5_000, 10_000, 30_000, 60_000, 300_000] as const;
const MESSAGE_WAIT_LADDER_RESET_MS = 60_000;
const MESSAGE_WAIT_PEER_PREVIEW = 5;

interface MessageWindow {
	level: number;
	openedAt: number;
	deadline: number;
}

interface WaitMessaging {
	registry: AgentRegistry;
	senderId: string;
}

function takeQueuedMessage(messaging: WaitMessaging | undefined): IrcMessage | undefined {
	if (!messaging) return undefined;
	return drainPendingInbox(messaging.registry, messaging.senderId) ?? IrcBus.global().take(messaging.senderId);
}

interface PendingReplies {
	/** Agents asked that can still answer: running, or holding the question for a turn of its own, and not blocked on the caller. */
	from: string[];
	/** Agents asked that cannot answer before the caller finishes (see `AgentAwaits.blocksOn`). */
	blocked: string[];
	/** Agents asked whose turn ended without an answer, or that are gone. */
	stopped: string[];
}

/**
 * Agents the caller messaged during its current run that have not answered
 * yet, split by whether a reply can still come. A message back answers, and
 * so does a settled job of the agent the caller owns, which delivers its
 * result. Only a running agent, or one still holding the question for a turn
 * of its own (a subagent answers a message that reached it as it finished
 * after its result is out), can answer: one that went idle otherwise has
 * finished the turn it got it in, and any automatic reply (a woken subagent's
 * relayed output) has arrived by then.
 */
function pendingReplies(messaging: WaitMessaging): PendingReplies {
	const { registry, senderId } = messaging;
	const replies: PendingReplies = { from: [], blocked: [], stopped: [] };
	const since = registry.get(senderId)?.session?.runStartedAt ?? 0;
	for (const { to, sentAt } of IrcBus.global().unansweredSends(senderId, since)) {
		const session = registry.get(to)?.session;
		if (session && registry.awaits.blocksOn(to, senderId, sentAt)) replies.blocked.push(to);
		else if (session?.isStreaming || session?.hasQueuedIrcFrom(senderId)) replies.from.push(to);
		else replies.stopped.push(to);
	}
	return replies;
}

/** Why a reply wait cannot (or can no longer) get its answer. */
function noReplyText(replies: PendingReplies): string {
	const ids = (list: string[]) => list.map(id => `\`${id}\``).join(", ");
	if (replies.blocked.length > 0) {
		return `${ids(replies.blocked)} cannot reply before you finish: it is waiting on your result. Finish without the answer.`;
	}
	if (replies.stopped.length > 0) {
		return `${ids(replies.stopped)} finished its turn without replying. Ask again, or finish without the answer.`;
	}
	return "no background job or service you started is running, and no agent you messaged this run owes a reply. Other agents' results and messages arrive on their own.";
}
/** Whether `session` has the `wait` tool active, so prompts may point blocked callers at it. */
export function hasWaitTool(session: ToolSession): boolean {
	return session.isToolActive?.("wait") ?? true;
}

/**
 * Blocks on background jobs and services the calling agent started, or on
 * the reply to a message it sent this run. Other agents' work never sustains
 * a wait: a peer owes no message. A reply wait ends once no agent asked can
 * still answer: each one finished its turn, or is blocked on the caller
 * itself, the cycle that would park both sides. A message arriving mid-wait
 * ends any wait.
 */
export class WaitTool implements AgentTool<typeof waitSchema, CoordinationDetails> {
	readonly name = "wait";
	readonly label = "Wait";
	readonly summary = "Wait for the next result of a background job or service you started, or a reply you asked for";
	readonly description = prompt.render(waitDescription);
	readonly parameters = waitSchema;
	readonly strict = true;
	readonly interruptible = true;
	readonly approval = "read";
	readonly loadMode = "essential";
	readonly intent = "optional";

	#lastMessageWait: { level: number; endedAt: number } | undefined;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		_params: typeof waitSchema.infer,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<CoordinationDetails>,
	): Promise<AgentToolResult<CoordinationDetails>> {
		const registry = this.session.agentRegistry;
		const senderId = this.session.getAgentId?.() ?? undefined;
		const messaging = registry && senderId ? { registry, senderId } : undefined;
		const manager = this.session.asyncJobManager;
		const pending = takeQueuedMessage(messaging);
		if (pending && messaging) return messageResult(messaging.senderId, pending);
		if (cfgLaunchEnabled.get(this.session.settings)) {
			try {
				await listServicesTolerant(this.session, signal);
			} catch (error) {
				if (signal?.reason !== TOOL_INTERRUPT_ABORT_REASON) throw error;
			}
		}
		const deadline = Date.now() + WAIT_MAX_MS;
		let messageWindow: MessageWindow | undefined;
		try {
			for (;;) {
				const queued = takeQueuedMessage(messaging);
				if (queued && messaging) return messageResult(messaging.senderId, queued);
				const jobs = manager?.getRunningJobs({ ownerId: senderId }) ?? [];
				const undelivered = manager ? undeliveredJobs(manager, senderId) : [];
				if (manager && undelivered.length > 0) {
					return buildJobResult(this.session, manager, "wait", [...undelivered, ...jobs], []);
				}
				const serviceRunning = hasLiveOwnedService(this.session);
				if (jobs.length === 0 && !serviceRunning) {
					const replies = messaging ? pendingReplies(messaging) : { from: [], blocked: [], stopped: [] };
					if (replies.from.length === 0) {
						const news = signal?.aborted || replies.blocked.length > 0 || replies.stopped.length > 0;
						const agents = runningAgentsOutsideJobs(this.session);
						const text = `Nothing to wait for: ${noReplyText(replies)}`;
						return {
							content: [
								{
									type: "text",
									text: agents.length > 0 ? `${describeAgents(agents).join("\n")}\n\n${text}` : text,
								},
							],
							details: { op: "wait", jobs: [], ...(agents.length > 0 ? { agents } : {}) },
							...(news ? {} : { useless: true }),
						};
					}
					messageWindow ??= this.#openMessageWindow();
				}
				const window = jobs.length === 0 && !serviceRunning ? messageWindow : undefined;
				const result = await this.#blockUntilWake({
					jobs,
					manager,
					messaging,
					serviceRunning,
					deadline: window ? Math.min(window.deadline, deadline) : deadline,
					messageWindow: window,
					signal,
					onUpdate,
				});
				if (result) return result;
			}
		} finally {
			if (messageWindow) this.#lastMessageWait = { level: messageWindow.level, endedAt: Date.now() };
		}
	}

	#openMessageWindow(): MessageWindow {
		const now = Date.now();
		const last = this.#lastMessageWait;
		const level =
			!last || now - last.endedAt >= MESSAGE_WAIT_LADDER_RESET_MS
				? 0
				: Math.min(last.level + 1, MESSAGE_WAIT_LADDER_MS.length - 1);
		return { level, openedAt: now, deadline: now + MESSAGE_WAIT_LADDER_MS[level] };
	}

	/**
	 * Block until an owned job settles, an owned service finishes, a message arrives, the cap elapses, or the call aborts.
	 * With neither jobs nor a service, the block is a reply wait: it also ends once no agent asked can still reply.
	 */
	async #blockUntilWake(args: {
		jobs: AsyncJob[];
		manager: AsyncJobManager | undefined;
		messaging: WaitMessaging | undefined;
		serviceRunning: boolean;
		deadline: number;
		messageWindow: MessageWindow | undefined;
		signal: AbortSignal | undefined;
		onUpdate: AgentToolUpdateCallback<CoordinationDetails> | undefined;
	}): Promise<AgentToolResult<CoordinationDetails> | undefined> {
		const { jobs, manager, messaging, serviceRunning, messageWindow, signal, onUpdate } = args;
		const replyWait = messaging !== undefined && jobs.length === 0 && !serviceRunning;
		const watchedAgents = replyWait
			? pendingReplies(messaging).from
			: jobs.flatMap(job => (job.agentId ? [job.agentId] : []));
		const watchedIds = jobs.map(job => job.id);
		manager?.watchJobs(watchedIds);
		const serviceAbort = new AbortController();
		const serviceLeg = serviceRunning ? waitForOwnedServiceCompletion(this.session, serviceAbort.signal) : undefined;
		const busAbort = new AbortController();
		const busCancelled = new Error("wait settled");
		const busLeg: Promise<{ message: IrcMessage | null; error: Error | null }> | undefined = messaging
			? IrcBus.global()
					.wait(messaging.senderId, {}, 0, busAbort.signal, {
						wakeSources: {
							registry: messaging.registry,
							read: () => ({
								agents: watchedAgents,
								// AgentAwaits can end a reply wait without a peer replying.
								independent:
									replyWait || serviceRunning || jobs.some(job => job.status !== "running" || !job.agentId),
							}),
						},
					})
					.then(
						message => ({ message, error: null }),
						error => ({
							message: null,
							error: error === busCancelled ? null : error instanceof Error ? error : new Error(String(error)),
						}),
					)
			: undefined;
		// A reply wait re-checks whether an agent asked can still answer on
		// every block change, status change, and end of an asked agent's turn
		// (after any automatic reply that turn owes has been sent).
		let noReply: PendingReplies | undefined;
		let workAppeared = false;
		const replyGone = Promise.withResolvers<void>();
		const unsubscribers: Array<() => void> = [];
		if (replyWait) {
			const checkReplies = () => {
				if (
					(manager?.getRunningJobs({ ownerId: messaging.senderId }).length ?? 0) > 0 ||
					hasLiveOwnedService(this.session)
				) {
					workAppeared = true;
					replyGone.resolve();
					return;
				}
				const replies = pendingReplies(messaging);
				if (replies.from.length > 0) return;
				noReply = replies;
				replyGone.resolve();
			};
			unsubscribers.push(messaging.registry.awaits.onChange(checkReplies));
			unsubscribers.push(messaging.registry.onChange(checkReplies));
			for (const id of watchedAgents) {
				const session = messaging.registry.get(id)?.session;
				if (!session) continue;
				unsubscribers.push(
					session.subscribe(event => {
						if (event.type === "agent_end") void session.waitForIrcReplies().then(checkReplies);
					}),
				);
			}
		}
		// A reply wait depends on the agents asked. An owned-job wait blocks on
		// agents only when all its wake sources are their results; a bash job or
		// service is an independent way out.
		const releaseHold =
			messaging && !serviceRunning && (replyWait || watchedAgents.length === jobs.length)
				? messaging.registry.awaits.hold(messaging.senderId, watchedAgents, { interruptible: true })
				: undefined;
		const { promise: timeout, resolve: timedOut } = Promise.withResolvers<void>();
		const timer = setTimeout(timedOut, Math.max(0, args.deadline - Date.now()));
		const abort = Promise.withResolvers<void>();
		const onAbort = () => abort.resolve();
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
		const emitProgress = () =>
			onUpdate?.({
				content: [{ type: "text", text: "" }],
				details: { op: "wait", jobs: snapshotJobs(this.session, jobs) },
			});
		const progressTimer = onUpdate && jobs.length > 0 ? setInterval(emitProgress, PROGRESS_INTERVAL_MS) : undefined;
		if (jobs.length > 0) emitProgress();
		let wake: "job" | "message" | "service" | "unanswerable" | "timeout" | "abort";
		try {
			wake = await Promise.race([
				...jobs.map(job => job.promise.then(() => "job" as const)),
				...(busLeg ? [busLeg.then(() => "message" as const)] : []),
				...(serviceLeg ? [serviceLeg.then(() => "service" as const)] : []),
				...(replyWait ? [replyGone.promise.then(() => "unanswerable" as const)] : []),
				timeout.then(() => "timeout" as const),
				abort.promise.then(() => "abort" as const),
			]);
		} finally {
			clearTimeout(timer);
			clearInterval(progressTimer);
			busAbort.abort(busCancelled);
			serviceAbort.abort();
			for (const unsubscribe of unsubscribers) unsubscribe();
			releaseHold?.();
			signal?.removeEventListener("abort", onAbort);
		}
		// Unwatch only after the result is built: a job recovered below is
		// consumed first, while one left unreported (message or interrupt won
		// the race) is re-enqueued for its ordinary async delivery.
		try {
			// A dequeued message wins a photo-finish with a job: the job remains
			// deliverable, whereas a lost message cannot be recovered from the bus.
			if (busLeg && messaging) {
				const { message, error } = await busLeg;
				if (message) return messageResult(messaging.senderId, message);
				if (error instanceof IrcWaitCycleError && !signal?.aborted) {
					return {
						content: [{ type: "text", text: error.message }],
						details: { op: "wait", from: messaging.senderId, jobs: [] },
						isError: true,
					};
				}
				if (error && !signal?.aborted) throw error;
			}
			if (signal?.aborted) {
				// Steering, a peer IRC, or a completion notice cut the wait short:
				// the designed wake path, so the message injects after a normal
				// result. Any other abort stops the run.
				if (signal.reason === TOOL_INTERRUPT_ABORT_REASON) {
					// Not `useless`: a message woke the agent, which the loop guard
					// must treat as progress rather than an idle poll.
					return {
						content: [{ type: "text", text: "Wait interrupted by message." }],
						details: { op: "wait", jobs: [], interrupted: true },
					};
				}
				throwIfAborted(signal);
			}
			if (workAppeared) return undefined;
			if (manager && jobs.length > 0) {
				const result = buildJobResult(this.session, manager, "wait", jobs, []);
				// A finished service is news even while every watched job still runs.
				if (wake !== "service") return result;
				const { useless: _idle, ...woke } = result;
				return woke;
			}
			if (wake === "timeout" && messageWindow) {
				const peers = messaging ? pendingReplies(messaging).from : [];
				return {
					content: [
						{
							type: "text",
							text: prompt.render(waitNoMessageTemplate, {
								elapsed: formatDuration(Date.now() - messageWindow.openedAt),
								peers: peers.slice(0, MESSAGE_WAIT_PEER_PREVIEW),
								more: Math.max(0, peers.length - MESSAGE_WAIT_PEER_PREVIEW),
							}),
						},
					],
					details: { op: "wait", jobs: [] },
					useless: true,
				};
			}
			return {
				content: [
					{
						type: "text",
						text:
							wake === "service"
								? "A service finished. Read proc:// for its status and output."
								: wake === "unanswerable" && noReply
									? noReplyText(noReply)
									: replyWait
										? "Wait limit reached with no reply. Ask again, or finish without the answer."
										: "Wait limit reached; background work may still be running. Read proc:// for status.",
					},
				],
				details: { op: "wait", jobs: [] },
				// A wait that ran out with nothing to report is an idle poll.
				...(wake === "timeout" ? { useless: true } : {}),
			};
		} finally {
			manager?.unwatchJobs(watchedIds);
		}
	}
}
