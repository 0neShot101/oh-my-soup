import { afterAll, describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-soup/pi-ai";
import { ModelRegistry } from "@oh-my-soup/pi-coding-agent/config/model-registry";
import { getSearchProvider } from "@oh-my-soup/pi-coding-agent/web/search/provider";
import type { SearchParams } from "@oh-my-soup/pi-coding-agent/web/search/providers/base";
import { searchCelestial } from "@oh-my-soup/pi-coding-agent/web/search/providers/celestial";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const authStorage = createInMemoryAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
afterAll(() => authStorage.close());

function params(fetch: FetchImpl): SearchParams {
	const model = modelRegistry.find("web", "celestial");
	if (!model) throw new Error("Missing web/celestial model");
	return { query: "rust site:example.org", model, modelRegistry, authStorage, systemPrompt: "", fetch };
}

function braveHtml(): string {
	const data = [
		{ type: "data", data: { page: "/search" } },
		{
			type: "data",
			data: {
				body: {
					response: {
						query: { original: "rust" },
						web: {
							results: [
								{ title: "Single engine", url: "https://brave.example/", description: "Only Brave" },
								{
									title: "Shared result",
									url: "http://www.example.org/docs/?utm_source=brave#top",
									description: "",
								},
							],
						},
					},
				},
			},
		},
	];
	return `<script>start({node_ids:[0],data:${JSON.stringify(data)}})</script>`;
}

function duckScript(): string {
	return `DDG.deep.deepPayload = {instantAnswers:[],recommendedTabs:{maxVisibleTabs:1,tabOrder:[]}}; DDG.pageLayout.load("d", ${JSON.stringify(
		[
			{
				a: "<b>Shared</b> documentation",
				c: "https://example.org/docs",
				d: "example.org",
				da: "",
				h: 0,
				i: "example.org",
				k: null,
				m: 0,
				o: 0,
				p: 0,
				s: "Shared",
				t: "Shared",
				u: "https://example.org/docs",
			},
		],
	)});`;
}

function transport(brave: string | number = braveHtml(), script = duckScript()): FetchImpl {
	return input => {
		const url = new URL(String(input));
		switch (url.hostname) {
			case "search.brave.com":
				return Promise.resolve(
					typeof brave === "number" ? new Response("unavailable", { status: brave }) : new Response(brave),
				);
			case "duckduckgo.com":
				return Promise.resolve(new Response('<script>load("https://links.duckduckgo.com/d.js?q=rust")</script>'));
			case "links.duckduckgo.com":
				return Promise.resolve(new Response(script));
			default:
				return Promise.reject(new Error(`Unexpected search URL: ${url}`));
		}
	};
}

describe("Celestial native search", () => {
	it("selects the catalog engine and ranks normalized consensus above a higher single-engine result", async () => {
		const provider = await getSearchProvider("celestial");
		const response = await provider.search(params(transport()));
		expect(response.sources.map(source => source.url)).toEqual([
			"https://example.org/docs",
			"https://brave.example/",
		]);
		expect(response.sources[0].snippet).toBe("Shared documentation");
		expect(response.answer).toBeUndefined();
	});

	it("bounds cyclic script continuations without losing the successful engine", async () => {
		const response = await searchCelestial(params(transport(braveHtml(), 'DDG.deep.initialize("/d.js?q=again");')));
		expect(response.sources.map(source => source.title)).toEqual(["Single engine", "Shared result"]);
	});

	it("keeps real DuckDuckGo results when Brave is unavailable", async () => {
		const response = await searchCelestial(params(transport(503)));
		expect(response.sources.map(source => source.url)).toEqual(["https://example.org/docs"]);
		expect(response.sources[0].snippet).toBe("Shared documentation");
	});

	it("reports both engine failures instead of inventing an answer", async () => {
		await expect(searchCelestial(params(transport(403, "not valid javascript;")))).rejects.toThrow(
			/brave:.*403.*duckduckgo:/,
		);
	});

	it("settles caller cancellation even if the fetch transport ignores its signal", async () => {
		const controller = new AbortController();
		const deferred = Promise.withResolvers<Response>();
		const pending = searchCelestial({ ...params(() => deferred.promise), signal: controller.signal });
		controller.abort(new Error("search cancelled"));
		try {
			await expect(pending).rejects.toThrow("search cancelled");
		} finally {
			deferred.resolve(new Response(""));
		}
	});
});
