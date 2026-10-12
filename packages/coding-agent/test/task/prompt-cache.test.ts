import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Model, ProviderSessionState } from "@oh-my-pi/pi-ai";
import { buildRequest as buildGeminiRequest } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildTransformedCodexRequestBody } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { buildParams as buildResponsesParams } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("task sibling prompt-cache routing", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		await Promise.all(sessions.splice(0).map(session => session.dispose()));
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it.each([
		["openai-codex", "gpt-6-luna", undefined],
		["muse-code", "muse-spark-1.3-contributor", "explicit-parent-cache"],
		["google-antigravity", "gemini-3.8-flash", "explicit-parent-cache"],
	] as const)(
		"routes %s task siblings through a shared cache key without sharing conversation state",
		async (provider, modelId, parentCacheKey) => {
			using directory = TempDir.createSync("@omp-task-cache-");
			vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network is disabled in this test"));
			const model = getBundledModel(provider, modelId);
			const authStorage = await AuthStorage.create(directory.join("auth.db"));
			authStorage.keys.setRuntime(provider, "test-key");
			const requests: Array<{
				sessionId: string | undefined;
				cacheKey: string | undefined;
				state: Map<string, ProviderSessionState> | undefined;
				wireKey: unknown;
			}> = [];
			const realCreateSession = sdk.createAgentSession;
			vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
				agents: [
					{ name: "task", description: "Review", systemPrompt: "Review the assignment.", source: "bundled" },
				],
				projectAgentsDir: null,
			});
			vi.spyOn(sdk, "createAgentSession").mockImplementation(async options => {
				const result = await realCreateSession(options);
				sessions.push(result.session);
				const mock = createMockModel({
					handler: { content: [{ type: "toolCall", name: "yield", arguments: { data: { findings: [] } } }] },
				});
				result.session.agent.streamFn = async (requestModel, context, streamOptions) => {
					const cacheOptions = {
						sessionId: streamOptions?.sessionId,
						promptCacheKey: streamOptions?.promptCacheKey,
						providerSessionState: streamOptions?.providerSessionState,
					};
					let wireKey: unknown;
					if (requestModel.api === "openai-codex-responses") {
						wireKey = (
							await buildTransformedCodexRequestBody(
								requestModel as Model<"openai-codex-responses">,
								context,
								cacheOptions,
							)
						).prompt_cache_key;
					} else if (requestModel.api === "openai-responses") {
						wireKey = buildResponsesParams(
							requestModel as Model<"openai-responses">,
							context,
							cacheOptions,
							undefined,
						).params.prompt_cache_key;
					} else {
						const request = buildGeminiRequest(
							requestModel as Model<"google-gemini-cli">,
							context,
							"test-project",
							cacheOptions,
							true,
						);
						wireKey = JSON.stringify(request).includes("explicit-parent-cache");
					}
					requests.push({
						sessionId: streamOptions?.sessionId,
						cacheKey: streamOptions?.promptCacheKey,
						state: streamOptions?.providerSessionState,
						wireKey,
					});
					return mock.stream(requestModel, context, streamOptions);
				};
				return result;
			});
			try {
				const { session: parent } = await sdk.createAgentSession({
					cwd: directory.path(),
					agentDir: directory.path(),
					authStorage,
					model,
					providerSessionId: "parent-provider-lineage",
					providerPromptCacheKey: parentCacheKey,
					sessionManager: SessionManager.inMemory(directory.path()),
					settings: Settings.isolated({
						"async.enabled": false,
						"marketplace.autoUpdate": "off",
						"compaction.enabled": false,
					}),
					toolNames: ["task"],
					spawns: "*",
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					rules: [],
					enableMCP: false,
					enableLsp: false,
				});
				const tool = parent.getToolByName("task") as TaskTool;
				for (const name of ["SiblingA", "SiblingB"]) {
					const result = await tool.execute(name, {
						name,
						task: `Review ${name}.`,
						model: `${provider}/${modelId}`,
					});
					expect(result.isError, JSON.stringify(result)).not.toBe(true);
					expect(result.details?.results[0]?.exitCode, JSON.stringify(result)).toBe(0);
				}
				expect(requests).toHaveLength(2);
				const expected = `${parentCacheKey ?? "parent-provider-lineage"}:task`;
				expect(requests.map(request => request.cacheKey)).toEqual([expected, expected]);
				expect(requests[0]?.sessionId).not.toBe(requests[1]?.sessionId);
				expect(requests[0]?.sessionId).not.toBe("parent-provider-lineage");
				expect(requests[0]?.state).toBeInstanceOf(Map);
				expect(requests[1]?.state).toBeInstanceOf(Map);
				expect(requests[0]?.state).not.toBe(requests[1]?.state);
				expect(requests.map(request => request.wireKey)).toEqual(
					provider === "google-antigravity" ? [false, false] : [expected, expected],
				);
			} finally {
				await Promise.all(sessions.splice(0).map(session => session.dispose()));
				authStorage.close();
			}
		},
	);
});
