import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Context } from "@oh-my-soup/pi-ai";
import { Settings } from "@oh-my-soup/pi-coding-agent/config/settings";
import { cfgSystemPromptFiles, cfgSystemPromptPlacement } from "@oh-my-soup/pi-coding-agent/session/context-settings";
import {
	applyModelPromptFile,
	applySystemPromptPlacement,
} from "@oh-my-soup/pi-coding-agent/session/system-prompt-placement";
import { executeAcpBuiltinSlashCommand } from "@oh-my-soup/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-soup/pi-coding-agent/slash-commands/types";
import { TempDir } from "@oh-my-soup/pi-utils";

interface ModelFixture {
	provider: string;
	id: string;
	supportsSystemPrompt?: boolean;
}

function createRuntime(options: {
	cwd: string;
	model?: ModelFixture;
	available?: ModelFixture[];
	settings?: Record<string, unknown>;
}) {
	const settings = Settings.isolated(options.settings ?? {});
	const output = vi.fn();
	const runtime = {
		session: {
			isStreaming: false,
			sessionId: "session-sprompt",
			settings,
			model: options.model,
			sessionManager: { getCwd: () => options.cwd },
			modelRegistry: {
				getAvailable: () => options.available ?? (options.model ? [options.model] : []),
			},
		},
		output,
	} as unknown as SlashCommandRuntime;
	return { settings, output, runtime };
}

async function applyConfiguredPrompt(settings: Settings, model: ModelFixture): Promise<Context> {
	const context: Context = {
		systemPrompt: ["Session prompt must be replaced."],
		messages: [{ role: "user", content: "hello", timestamp: 0 }],
	};
	const withFile = await applyModelPromptFile(context, model, cfgSystemPromptFiles.get(settings));
	return applySystemPromptPlacement(withFile, model, cfgSystemPromptPlacement.get(settings));
}

const CAPABLE_MODEL: ModelFixture = { provider: "anthropic", id: "claude-fable-5" };
const NO_SYSTEM_MODEL: ModelFixture = { provider: "google", id: "gemma-4-31b-it", supportsSystemPrompt: false };

describe("/sprompt", () => {
	it("set binds a session-CWD-relative prompt and delivers its contents", async () => {
		using tempDir = TempDir.createSync("@pi-sprompt-set-");
		await Bun.write(tempDir.join("prompt.md"), "  You are the fixture prompt.\n");
		const harness = createRuntime({ cwd: tempDir.path(), model: CAPABLE_MODEL });

		expect(await executeAcpBuiltinSlashCommand("/sprompt set prompt.md", harness.runtime)).toEqual({
			consumed: true,
		});

		const saved = cfgSystemPromptFiles.get(harness.settings);
		const expectedPath = tempDir.join("prompt.md");
		expect(saved["anthropic/claude-fable-5"]).toBe(expectedPath);
		expect((await applyConfiguredPrompt(harness.settings, CAPABLE_MODEL)).systemPrompt).toEqual([
			"You are the fixture prompt.",
		]);
	});

	it("set delivers file contents in the first user turn for models without system support", async () => {
		using tempDir = TempDir.createSync("@pi-sprompt-set-nosys-");
		await Bun.write(tempDir.join("prompt.md"), "gemma prompt");
		const harness = createRuntime({ cwd: tempDir.path(), model: NO_SYSTEM_MODEL });

		await executeAcpBuiltinSlashCommand("/sprompt set prompt.md", harness.runtime);

		expect(cfgSystemPromptFiles.get(harness.settings)["google/gemma-4-31b-it"]).toBe(tempDir.join("prompt.md"));
		const context = await applyConfiguredPrompt(harness.settings, NO_SYSTEM_MODEL);
		expect(context.systemPrompt).toBeUndefined();
		expect(context.messages[0]).toMatchObject({ role: "user", content: "gemma prompt", synthetic: true });
	});

	it.each(["relative", "absolute"] as const)("set reads double-quoted %s paths containing spaces", async spelling => {
		using tempDir = TempDir.createSync("@pi-sprompt-quoted-");
		const filename = "prompt's instructions.md";
		const file = tempDir.join(filename);
		await Bun.write(file, "QUOTED-PROMPT: selected file.");
		const harness = createRuntime({ cwd: tempDir.path(), model: CAPABLE_MODEL });
		const argument = spelling === "relative" ? filename : file;

		await executeAcpBuiltinSlashCommand(`/sprompt set "${argument}"`, harness.runtime);

		expect(cfgSystemPromptFiles.get(harness.settings)["anthropic/claude-fable-5"]).toBe(file);
		expect((await applyConfiguredPrompt(harness.settings, CAPABLE_MODEL)).systemPrompt).toEqual([
			"QUOTED-PROMPT: selected file.",
		]);
	});

	it("set resolves parent-relative files against the session CWD", async () => {
		using tempDir = TempDir.createSync("@pi-sprompt-parent-");
		const cwd = tempDir.join("workspace");
		await fs.mkdir(cwd);
		const file = tempDir.join("prompt.md");
		await Bun.write(file, "PARENT-PROMPT: outside the session CWD.");
		const harness = createRuntime({ cwd, model: CAPABLE_MODEL });

		await executeAcpBuiltinSlashCommand("/sprompt set ../prompt.md", harness.runtime);

		expect(cfgSystemPromptFiles.get(harness.settings)["anthropic/claude-fable-5"]).toBe(file);
		expect((await applyConfiguredPrompt(harness.settings, CAPABLE_MODEL)).systemPrompt).toEqual([
			"PARENT-PROMPT: outside the session CWD.",
		]);
	});

	it.each(["unquoted", "double-quoted"] as const)(
		"set expands %s home-relative paths outside the session CWD",
		async spelling => {
			// Own a unique home fixture without changing HOME, homedir(), or the process CWD.
			using homeDir = TempDir.createSync(path.join(os.homedir(), ".oms-sprompt-home-"));
			using cwdDir = TempDir.createSync("@pi-sprompt-home-cwd-");
			const file = homeDir.join("prompt with spaces.md");
			await Bun.write(file, "HOME-PROMPT: selected via /sprompt.");
			const homeRelative = `~/${path.basename(homeDir.path())}/prompt with spaces.md`;
			const argument = spelling === "double-quoted" ? `"${homeRelative}"` : homeRelative;
			const harness = createRuntime({ cwd: cwdDir.path(), model: CAPABLE_MODEL });

			await executeAcpBuiltinSlashCommand(`/sprompt set ${argument}`, harness.runtime);

			expect(cfgSystemPromptFiles.get(harness.settings)["anthropic/claude-fable-5"]).toBe(file);
			expect((await applyConfiguredPrompt(harness.settings, CAPABLE_MODEL)).systemPrompt).toEqual([
				"HOME-PROMPT: selected via /sprompt.",
			]);
		},
	);

	it.skipIf(process.platform === "win32")("set keeps POSIX apostrophes and backslashes literal", async () => {
		using tempDir = TempDir.createSync("@pi-sprompt-literal-");
		await Bun.write(tempDir.join("prompt.md"), "DECOY: single quotes were stripped.");
		await Bun.write(tempDir.join("prompt with spaces.md"), "DECOY: backslashes were unescaped.");
		for (const filename of ["'prompt.md'", String.raw`prompt\ with\ spaces.md`]) {
			const file = tempDir.join(filename);
			await Bun.write(file, `LITERAL-PROMPT: ${filename}`);
			const harness = createRuntime({ cwd: tempDir.path(), model: CAPABLE_MODEL });

			await executeAcpBuiltinSlashCommand(`/sprompt set ${filename}`, harness.runtime);

			expect(cfgSystemPromptFiles.get(harness.settings)["anthropic/claude-fable-5"]).toBe(file);
			expect((await applyConfiguredPrompt(harness.settings, CAPABLE_MODEL)).systemPrompt).toEqual([
				`LITERAL-PROMPT: ${filename}`,
			]);
		}
	});

	it("set rejects unreadable, empty, and absent file arguments without changing bindings", async () => {
		using tempDir = TempDir.createSync("@pi-sprompt-set-bad-");
		await Bun.write(tempDir.join("empty.md"), "   \n");
		await Bun.write(tempDir.join("saved.md"), "Existing prompt remains active.");
		const configured = { "anthropic/claude-fable-5": tempDir.join("saved.md") };
		const harness = createRuntime({
			cwd: tempDir.path(),
			model: CAPABLE_MODEL,
			settings: { systemPromptFiles: configured },
		});

		for (const argument of ["missing.md", "empty.md", '""', ""]) {
			await executeAcpBuiltinSlashCommand(`/sprompt set ${argument}`, harness.runtime);
			expect(cfgSystemPromptFiles.get(harness.settings)).toEqual(configured);
			expect((await applyConfiguredPrompt(harness.settings, CAPABLE_MODEL)).systemPrompt).toEqual([
				"Existing prompt remains active.",
			]);
		}
	});

	it("lists bindings with placement channels and marks the current model", async () => {
		using tempDir = TempDir.createSync("@pi-sprompt-list-");
		await Bun.write(tempDir.join("a.md"), "prompt a");
		const configured = {
			"anthropic/claude-fable-5": tempDir.join("a.md"),
			"google/gemma-4-31b-it": tempDir.join("missing.md"),
			"local/unloaded-model": tempDir.join("a.md"),
		};
		const harness = createRuntime({
			cwd: tempDir.path(),
			model: CAPABLE_MODEL,
			available: [CAPABLE_MODEL, NO_SYSTEM_MODEL],
			settings: { systemPromptFiles: configured },
		});

		await executeAcpBuiltinSlashCommand("/sprompt", harness.runtime);

		const text = harness.output.mock.calls.at(-1)?.[0] as string;
		expect(text).toContain(`* anthropic/claude-fable-5 -> ${tempDir.join("a.md")} [system prompt]`);
		expect(text).toContain(
			`  google/gemma-4-31b-it -> ${tempDir.join("missing.md")} (file missing) [first user turn]`,
		);
		expect(text).toContain(`  local/unloaded-model -> ${tempDir.join("a.md")}`);
	});

	it("clear removes only the current model's binding", async () => {
		using tempDir = TempDir.createSync("@pi-sprompt-clear-");
		const configured = {
			"anthropic/claude-fable-5": tempDir.join("a.md"),
			"google/gemma-4-31b-it": tempDir.join("b.md"),
		};
		// Seed and inspect the mutable settings through the descriptor consumed by /sprompt.
		const harness = createRuntime({ cwd: tempDir.path(), model: CAPABLE_MODEL });
		cfgSystemPromptFiles.set(harness.settings, configured);

		await executeAcpBuiltinSlashCommand("/sprompt clear", harness.runtime);

		expect(cfgSystemPromptFiles.get(harness.settings)).toEqual({
			"google/gemma-4-31b-it": tempDir.join("b.md"),
		});

		await executeAcpBuiltinSlashCommand("/sprompt clear", harness.runtime);
		expect(cfgSystemPromptFiles.get(harness.settings)).toEqual({
			"google/gemma-4-31b-it": tempDir.join("b.md"),
		});
	});

	it("toggle suspends and re-enables the current model's binding, keeping the path", async () => {
		using tempDir = TempDir.createSync("@pi-sprompt-toggle-");
		await Bun.write(tempDir.join("prompt.md"), "toggle me");
		const harness = createRuntime({ cwd: tempDir.path(), model: CAPABLE_MODEL });
		const file = tempDir.join("prompt.md");

		await executeAcpBuiltinSlashCommand("/sprompt toggle", harness.runtime);
		expect(cfgSystemPromptFiles.get(harness.settings)).toEqual({});

		await executeAcpBuiltinSlashCommand("/sprompt set prompt.md", harness.runtime);

		await executeAcpBuiltinSlashCommand("/sprompt toggle", harness.runtime);
		expect(cfgSystemPromptFiles.get(harness.settings)).toEqual({
			"anthropic/claude-fable-5": { path: file, enabled: false },
		});
		expect((await applyConfiguredPrompt(harness.settings, CAPABLE_MODEL)).systemPrompt).toEqual([
			"Session prompt must be replaced.",
		]);

		await executeAcpBuiltinSlashCommand("/sprompt", harness.runtime);
		expect(harness.output.mock.calls.at(-1)?.[0] as string).toContain(`${file} (disabled) [system prompt]`);

		await executeAcpBuiltinSlashCommand("/sprompt toggle", harness.runtime);
		expect(cfgSystemPromptFiles.get(harness.settings)).toEqual({ "anthropic/claude-fable-5": file });
		expect((await applyConfiguredPrompt(harness.settings, CAPABLE_MODEL)).systemPrompt).toEqual(["toggle me"]);
	});
});
