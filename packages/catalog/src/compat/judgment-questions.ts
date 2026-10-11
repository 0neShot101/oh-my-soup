import { toModelSpec } from "../provider-models/bundled-references";
import type { Model } from "../types";
import { resolveCatalogAxes } from "./resolve";

const questionsMaxCache = new Map<string, number | null>();
const QUESTIONS_MAX_CACHE_MAX = 8192;

/**
 * Most questions one System One judgment request to this model may carry
 * (`judgment-questions-max` axis), or `undefined` when the endpoint takes any
 * batch size.
 */
export function resolveJudgmentQuestionsMax(model: Model): number | undefined {
	const key = `${model.provider} ${model.id} ${model.api}`;
	let max = questionsMaxCache.get(key);
	if (max === undefined) {
		const value = resolveCatalogAxes(toModelSpec(model)).judgmentQuestionsMax;
		max = typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
		if (questionsMaxCache.size >= QUESTIONS_MAX_CACHE_MAX) questionsMaxCache.clear();
		questionsMaxCache.set(key, max);
	}
	return max ?? undefined;
}
