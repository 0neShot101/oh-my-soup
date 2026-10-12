/**
 * Whether a reader bills the signature of a replayed thinking block as input
 * tokens, from the `bills-thinking-signatures` rules in the compat cascade. A
 * model line's lineage rule (`rules/classes/*.kdl`) applies on every host;
 * readers without one are taken to bill it.
 */
import { classifyModel } from "../identity";
import { resolveCascade } from "./cascade";
import type { ImageTokenizationTarget } from "./image-tokenization";

/** Whether `reader` bills replayed thinking signatures; true unless its lineage declares otherwise. */
export function billsThinkingSignatures(reader: ImageTokenizationTarget): boolean {
	const provider = reader.provider ?? "";
	const model = reader.id ?? "";
	const identity = reader.identity ?? (model ? classifyModel(provider, model, { lenient: true }) : undefined);
	const billed = resolveCascade({
		provider,
		api: reader.api ?? "",
		class: identity?.class ?? "unknown",
		model,
		reasoning: false,
		...(identity?.family !== undefined && { family: identity.family }),
		...(identity?.revision !== undefined && { revision: identity.revision }),
	}).catalog.billsThinkingSignatures;
	return billed !== false;
}
