import type { AssistantMessage, Message } from "@oh-my-soup/pi-ai";

const CYBER_REFUSAL_ERROR_MESSAGE_RE =
	/\b(?:Refusal\s*\(\s*cyber\s*\)|cyber[_ ]?policy|trusted access for cyber|flagged for possible cybersecurity risk|violative\s+cyber\s+content)\b/i;

const REFUSAL_ERROR_MESSAGE_RE =
	/\b(?:Refusal\b|finish reason:\s*(?:SAFETY|BLOCKLIST|PROHIBITED_CONTENT|RECITATION|SPII)|blocked by content filters?|content[_ ]?filter|content[_ ]?policy|cyber[_ ]?policy|trusted access for cyber|flagged for possible cybersecurity risk|safety[_ ]?system|usage[_ ]?policy|violative\s+\w+\s+content)\b/i;

/** Whether an error message string describes a cyber policy/classifier refusal. */
export function isCyberRefusalErrorMessage(errorMessage: string | undefined): boolean {
	if (!errorMessage) return false;
	return CYBER_REFUSAL_ERROR_MESSAGE_RE.test(errorMessage);
}

/** Whether an assistant error message is a cyber policy/classifier refusal. */
export function isCyberRefusalMessage(message: AssistantMessage): boolean {
	if (message.stopReason !== "error") return false;
	if (
		(message.stopDetails?.type === "refusal" || message.stopDetails?.type === "sensitive") &&
		message.stopDetails.category?.toLowerCase() === "cyber"
	) {
		return true;
	}
	return isCyberRefusalErrorMessage(message.errorMessage);
}

/** Whether an error message string describes a provider content/safety refusal. */
export function isProviderRefusalErrorMessage(errorMessage: string | undefined): boolean {
	if (!errorMessage) return false;
	return REFUSAL_ERROR_MESSAGE_RE.test(errorMessage);
}

/** Detects API-level provider refusals that are terminal errors, not dialogue to replay. */
export function isProviderRefusalMessage(message: AssistantMessage): boolean {
	if (message.stopReason !== "error") return false;
	const stopType = message.stopDetails?.type;
	if (stopType === "refusal" || stopType === "sensitive" || stopType === "content_filter") return true;
	return isProviderRefusalErrorMessage(message.errorMessage);
}

const SYNTHETIC_TOOL_ERROR_PREFIX =
	"Tool call was not executed because the provider stream ended with an error before the tool could run: ";

function isUnexecutedSyntheticRefusalToolResult(message: Message): boolean {
	if (message.role !== "toolResult" || !message.isError) return false;
	const details = (message as { details?: { __synthetic?: boolean; executed?: boolean } }).details;
	if (details?.__synthetic === true && details.executed === false) return true;
	return message.content.some(
		block =>
			block.type === "text" &&
			block.text.startsWith(
				"Tool call was not executed because the provider stream ended with an error before the tool could run",
			),
	);
}

/** Removes API-level provider refusals and strips refusal reasons from live provider replay. */
export function filterProviderReplayMessages(messages: readonly Message[]): Message[] {
	const out: Message[] = [];
	const droppedRefusalToolCallIds = new Set<string>();
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message.role === "assistant") {
			if (isProviderRefusalMessage(message)) {
				const toolCallIds = message.content
					.filter(
						(block): block is Extract<AssistantMessage["content"][number], { type: "toolCall" }> =>
							block.type === "toolCall",
					)
					.map(block => block.id);
				if (toolCallIds.length === 0) continue;
				if (isCyberRefusalMessage(message)) {
					const executedCallIds = new Set<string>();
					for (let j = i + 1; j < messages.length; j++) {
						const candidate = messages[j];
						if (candidate.role !== "toolResult" || !toolCallIds.includes(candidate.toolCallId)) continue;
						if (!isUnexecutedSyntheticRefusalToolResult(candidate)) {
							executedCallIds.add(candidate.toolCallId);
						}
					}
					if (executedCallIds.size === 0) {
						for (const id of toolCallIds) droppedRefusalToolCallIds.add(id);
						continue;
					}
				}
				out.push({
					...message,
					errorMessage: undefined,
					stopDetails: undefined,
				});
				continue;
			}
			out.push(message);
			continue;
		}
		if (message.role === "toolResult" && droppedRefusalToolCallIds.delete(message.toolCallId)) {
			continue;
		}
		if (message.role === "toolResult" && message.isError) {
			let changed = false;
			const content = message.content.map(block => {
				if (block.type !== "text") return block;
				if (
					block.text.startsWith(SYNTHETIC_TOOL_ERROR_PREFIX) &&
					isProviderRefusalErrorMessage(block.text.slice(SYNTHETIC_TOOL_ERROR_PREFIX.length))
				) {
					changed = true;
					return {
						...block,
						text: "Tool call was not executed because the provider stream ended with an error before the tool could run.",
					};
				}
				return block;
			});
			out.push(changed ? { ...message, content } : message);
			continue;
		}
		out.push(message);
	}
	return out;
}
