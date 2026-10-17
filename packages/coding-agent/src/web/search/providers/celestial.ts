import type { AuthStorage } from "@oh-my-soup/pi-ai";
import {
	celestialEvalDuckDuckGoScript,
	celestialExtractDuckDuckGoUrl,
	celestialFusePages,
	celestialParseBraveHtml,
	type CelestialEnginePageInput,
	type CelestialPageDto,
} from "@oh-my-soup/pi-natives";
import { untilAborted } from "@oh-my-soup/pi-utils";
import { SearchProviderError, type SearchResponse } from "../types";
import { clampNumResults, dateToAgeSeconds } from "../utils";
import { SearchProvider, type SearchParams } from "./base";
import { readLimitedText, withHardTimeout } from "./utils";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_DUCK_REDIRECTS = 5;
const RECENCY = { day: "d", week: "w", month: "m", year: "y" } as const;

async function readPage(url: URL, params: SearchParams, signal: AbortSignal): Promise<string> {
	return untilAborted(signal, async () => {
		const response = await (params.fetch ?? fetch)(url.toString(), {
			signal,
			redirect: "error",
			headers: { Accept: "text/html,application/javascript", "User-Agent": "Oh-My-Soup Celestial" },
		});
		const body = await readLimitedText(response, "celestial", MAX_RESPONSE_BYTES);
		if (!response.ok) {
			throw new SearchProviderError("celestial", `${url.hostname}: HTTP ${response.status}`, response.status);
		}
		return body;
	});
}

async function searchBrave(params: SearchParams, signal: AbortSignal): Promise<CelestialPageDto> {
	const url = new URL("https://search.brave.com/search");
	url.searchParams.set("q", params.query);
	if (params.recency) url.searchParams.set("tf", `p${RECENCY[params.recency]}`);
	const result = celestialParseBraveHtml(await readPage(url, params, signal), params.query);
	if (result.status !== "ok" || !result.page) {
		throw new SearchProviderError("celestial", "Brave requires an interactive challenge", 429);
	}
	return result.page;
}

async function searchDuckDuckGo(params: SearchParams, signal: AbortSignal): Promise<CelestialPageDto> {
	const url = new URL("https://duckduckgo.com/");
	url.searchParams.set("q", params.query);
	if (params.recency) url.searchParams.set("df", RECENCY[params.recency]);
	let scriptUrl = celestialExtractDuckDuckGoUrl(await readPage(url, params, signal));
	for (let attempt = 0; attempt < MAX_DUCK_REDIRECTS; attempt++) {
		const target = new URL(scriptUrl);
		if (
			target.origin !== "https://links.duckduckgo.com" ||
			target.pathname !== "/d.js" ||
			target.username ||
			target.password
		) {
			throw new SearchProviderError("celestial", "DuckDuckGo returned an invalid script URL");
		}
		const result = celestialEvalDuckDuckGoScript(await readPage(target, params, signal), params.query);
		if (result.status === "ok" && result.page) return result.page;
		if (result.status !== "retry" || !result.retryUrl) {
			throw new SearchProviderError("celestial", "DuckDuckGo returned no search page");
		}
		scriptUrl = result.retryUrl;
	}
	throw new SearchProviderError("celestial", "DuckDuckGo exceeded its script redirect limit");
}

/** Native parsing, URL deduplication and reciprocal-rank fusion; no model-generated answer. */
export async function searchCelestial(params: SearchParams): Promise<SearchResponse> {
	const signal = withHardTimeout(params.signal, params.timeoutMs);
	signal.throwIfAborted();
	const results = await Promise.allSettled([searchBrave(params, signal), searchDuckDuckGo(params, signal)]);
	signal.throwIfAborted();
	const engines = ["brave", "duckduckgo"] as const;
	const pages: CelestialEnginePageInput[] = [];
	const failures: string[] = [];
	for (const [index, result] of results.entries()) {
		if (result.status === "fulfilled") pages.push({ engine: engines[index], page: result.value });
		else
			failures.push(
				`${engines[index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
			);
	}
	if (pages.length === 0) throw new SearchProviderError("celestial", failures.join("; "));
	const fused = celestialFusePages(pages, "rrf");
	const count = clampNumResults(params.numSearchResults ?? params.limit, 10, 20);
	return {
		provider: "celestial",
		sources: fused.web.slice(0, count).map(({ hit }) => ({
			title: hit.title,
			url: hit.url,
			snippet: hit.snippet || undefined,
			publishedDate: hit.published,
			ageSeconds: dateToAgeSeconds(hit.published),
		})),
		relatedQuestions: fused.related,
	};
}

export class CelestialProvider extends SearchProvider {
	readonly id = "celestial";
	readonly label = "Celestial";

	isAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchCelestial(params);
	}
}
