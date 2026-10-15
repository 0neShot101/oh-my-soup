/**
 * The native project walk-up must never treat home or temporary roots as project config dirs.
 * A cwd under home with no closer repo root (Windows temp dirs, scratch folders)
 * otherwise loads the user's ~/.oms/SYSTEM.md, RULES.md and AGENTS.md as project
 * config, even when the agent dir points elsewhere (profiles, isolated runs).
 */
import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getCapability } from "@oh-my-soup/pi-coding-agent/capability";
import { type ContextFile, contextFileCapability } from "@oh-my-soup/pi-coding-agent/capability/context-file";
import { clearCache } from "@oh-my-soup/pi-coding-agent/capability/fs";
import { type Skill, skillCapability } from "@oh-my-soup/pi-coding-agent/capability/skill";
import { type Rule, ruleCapability } from "@oh-my-soup/pi-coding-agent/capability/rule";
import { type SystemPrompt, systemPromptCapability } from "@oh-my-soup/pi-coding-agent/capability/system-prompt";
import type { LoadContext } from "@oh-my-soup/pi-coding-agent/capability/types";
// Importing discovery registers all providers as a side effect.
import "@oh-my-soup/pi-coding-agent/discovery";
import { __resetDirsFromEnvForTests, removeSyncWithRetries, setAgentDir } from "@oh-my-soup/pi-utils";

let tempDir: string;
let home: string;
// setAgentDir() rewrites these; restore them all so later test files see the original resolver.
const ENV_KEYS = ["PI_CODING_AGENT_DIR", "OMS_PROFILE", "PI_PROFILE", "PI_CONFIG_DIR"] as const;
let savedEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;

function writeFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

async function loadNative<T>(capabilityId: string, ctx: LoadContext): Promise<T[]> {
	const native = getCapability(capabilityId)?.providers.find(p => p.id === "native");
	if (!native) throw new Error(`native provider missing for ${capabilityId}`);
	const result = await (native.load as (ctx: LoadContext) => Promise<{ items: T[] }>)(ctx);
	return result.items;
}

beforeEach(() => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]])) as typeof savedEnv;
	clearCache();
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-home-walkup-"));
	home = path.join(tempDir, "home");
	// The user config root holds operator files; the active agent dir is isolated elsewhere.
	writeFile(path.join(home, ".oms", "SYSTEM.md"), "operator system prompt\n");
	writeFile(path.join(home, ".oms", "RULES.md"), "operator rule\n");
	writeFile(path.join(home, ".oms", "AGENTS.md"), "operator agents\n");
	writeFile(
		path.join(home, ".oms", "skills", "operator", "SKILL.md"),
		"---\nname: operator\ndescription: operator skill\n---\nbody\n",
	);
	setAgentDir(path.join(tempDir, "isolated-agent"));
});

afterEach(() => {
	clearCache();
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	__resetDirsFromEnvForTests();
	removeSyncWithRetries(tempDir);
});

test("a cwd outside home does not load native project config at or above the temporary root", async () => {
	const tempRoot = path.join(tempDir, "tmp");
	const cwd = path.join(tempRoot, "scratch", "work");
	fs.mkdirSync(cwd, { recursive: true });
	vi.spyOn(os, "tmpdir").mockReturnValue(tempRoot);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	for (const root of [tempRoot, tempDir]) {
		writeFile(path.join(root, ".oms", "SYSTEM.md"), "temporary system prompt\n");
		writeFile(path.join(root, ".oms", "RULES.md"), "temporary rule\n");
		writeFile(path.join(root, ".oms", "AGENTS.md"), "temporary agents\n");
		writeFile(
			path.join(root, ".oms", "skills", "temporary", "SKILL.md"),
			"---\nname: temporary\ndescription: temporary skill\n---\nbody\n",
		);
	}
	const ctx: LoadContext = { cwd, home, repoRoot: null };

	const prompts = await loadNative<SystemPrompt>(systemPromptCapability.id, ctx);
	const rules = await loadNative<Rule>(ruleCapability.id, ctx);
	const contexts = await loadNative<ContextFile>(contextFileCapability.id, ctx);
	const skills = await loadNative<Skill>(skillCapability.id, ctx);

	expect({
		prompts: prompts.map(prompt => prompt.path),
		rules: rules.map(rule => rule.path),
		contexts: contexts.map(context => context.path),
		skills: skills.map(skill => skill.path),
	}).toEqual({ prompts: [], rules: [], contexts: [], skills: [] });
});

test("native project config below the temporary root is still found", async () => {
	const tempRoot = path.join(tempDir, "tmp");
	const project = path.join(tempRoot, "project");
	const cwd = path.join(project, "nested");
	fs.mkdirSync(cwd, { recursive: true });
	vi.spyOn(os, "tmpdir").mockReturnValue(tempRoot);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	writeFile(path.join(project, ".oms", "SYSTEM.md"), "project system prompt\n");

	const prompts = await loadNative<SystemPrompt>(systemPromptCapability.id, { cwd, home, repoRoot: null });

	expect(prompts.map(prompt => [prompt.path, prompt.level])).toEqual([
		[path.join(project, ".oms", "SYSTEM.md"), "project"],
	]);
});

test("a repo-local session agent directory does not hide native project config or skills", async () => {
	const project = path.join(tempDir, "project");
	const cwd = path.join(project, "nested");
	const agentDir = path.join(project, ".oms", "agent");
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(path.join(project, ".git"), { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	vi.spyOn(os, "homedir").mockReturnValue(home);
	writeFile(path.join(project, ".oms", "SYSTEM.md"), "project system prompt\n");
	writeFile(path.join(project, ".oms", "RULES.md"), "project rule\n");
	writeFile(path.join(project, ".oms", "AGENTS.md"), "project agents\n");
	writeFile(
		path.join(project, ".oms", "skills", "project", "SKILL.md"),
		"---\nname: project\ndescription: project skill\n---\nbody\n",
	);
	const ctx: LoadContext = { cwd, home, repoRoot: project, agentDir };

	const prompts = await loadNative<SystemPrompt>(systemPromptCapability.id, ctx);
	const rules = await loadNative<Rule>(ruleCapability.id, ctx);
	const contexts = await loadNative<ContextFile>(contextFileCapability.id, ctx);
	const skills = await loadNative<Skill>(skillCapability.id, ctx);

	expect({
		prompts: prompts.map(prompt => prompt.path),
		rules: rules.map(rule => rule.path),
		contexts: contexts.map(context => context.path),
		skills: skills.map(skill => skill.path),
	}).toEqual({
		prompts: [path.join(project, ".oms", "SYSTEM.md")],
		rules: [path.join(project, ".oms", "RULES.md")],
		contexts: [path.join(project, ".oms", "AGENTS.md")],
		skills: [path.join(project, ".oms", "skills", "project", "SKILL.md")],
	});
});

test.each([undefined, ".pi"])(
	"native project discovery skips a foreign user config root without hiding a workspace above it (PI_CONFIG_DIR=%s)",
	async configDirName => {
		if (configDirName) process.env.PI_CONFIG_DIR = configDirName;
		const foreignHome = path.join(tempDir, "alice");
		const cwd = path.join(foreignHome, "scratch", "work");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(path.join(foreignHome, ".oms", "agent"), { recursive: true });
		fs.mkdirSync(path.join(foreignHome, ".oms", "plugins"), { recursive: true });
		vi.spyOn(os, "homedir").mockReturnValue(home);
		for (const [root, name] of [
			[foreignHome, "foreign"],
			[tempDir, "workspace"],
		] as const) {
			writeFile(path.join(root, ".oms", "SYSTEM.md"), `${name} system prompt\n`);
			writeFile(path.join(root, ".oms", "RULES.md"), `${name} rule\n`);
			writeFile(path.join(root, ".oms", "AGENTS.md"), `${name} agents\n`);
			writeFile(
				path.join(root, ".oms", "skills", name, "SKILL.md"),
				`---\nname: ${name}\ndescription: ${name} skill\n---\nbody\n`,
			);
		}
		const ctx: LoadContext = { cwd, home, repoRoot: null };

		const prompts = await loadNative<SystemPrompt>(systemPromptCapability.id, ctx);
		const rules = await loadNative<Rule>(ruleCapability.id, ctx);
		const contexts = await loadNative<ContextFile>(contextFileCapability.id, ctx);
		const skills = await loadNative<Skill>(skillCapability.id, ctx);

		expect({
			prompts: prompts.map(prompt => prompt.path),
			rules: rules.map(rule => rule.path),
			contexts: contexts.map(context => context.path),
			skills: skills.map(skill => skill.path),
		}).toEqual({
			prompts: [path.join(tempDir, ".oms", "SYSTEM.md")],
			rules: [path.join(tempDir, ".oms", "RULES.md")],
			contexts: [path.join(tempDir, ".oms", "AGENTS.md")],
			skills: [path.join(tempDir, ".oms", "skills", "workspace", "SKILL.md")],
		});
	},
);

test("an overridden discovery home does not make the process home a native project config root", async () => {
	const cwd = path.join(home, "scratch", "work");
	fs.mkdirSync(cwd, { recursive: true });
	vi.spyOn(os, "homedir").mockReturnValue(home);
	const ctx: LoadContext = { cwd, home: path.join(tempDir, "other-home"), repoRoot: null };

	const prompts = await loadNative<SystemPrompt>(systemPromptCapability.id, ctx);
	const rules = await loadNative<Rule>(ruleCapability.id, ctx);
	const contexts = await loadNative<ContextFile>(contextFileCapability.id, ctx);
	const skills = await loadNative<Skill>(skillCapability.id, ctx);

	expect({
		prompts: prompts.map(prompt => prompt.path),
		rules: rules.map(rule => rule.path),
		contexts: contexts.map(context => context.path),
		skills: skills.map(skill => skill.path),
	}).toEqual({ prompts: [], rules: [], contexts: [], skills: [] });
});

test("a cwd under home without a repo does not load ~/.oms files as project config", async () => {
	const cwd = path.join(home, "AppData", "Local", "Temp", "work");
	fs.mkdirSync(cwd, { recursive: true });
	const ctx: LoadContext = { cwd, home, repoRoot: null };

	const prompts = await loadNative<SystemPrompt>(systemPromptCapability.id, ctx);
	const rules = await loadNative<Rule>(ruleCapability.id, ctx);
	const contexts = await loadNative<ContextFile>(contextFileCapability.id, ctx);
	const skills = await loadNative<Skill>(skillCapability.id, ctx);

	const fromHome = (p: string) => p.startsWith(path.join(home, ".oms") + path.sep);
	expect(prompts.filter(p => fromHome(p.path))).toEqual([]);
	expect(rules.filter(r => fromHome(r.path))).toEqual([]);
	expect(contexts.filter(c => fromHome(c.path))).toEqual([]);
	expect(skills.filter(s => fromHome(s.path))).toEqual([]);
});

test("a project .oms between cwd and home is still found", async () => {
	const project = path.join(home, "scratch");
	const cwd = path.join(project, "nested");
	fs.mkdirSync(cwd, { recursive: true });
	writeFile(path.join(project, ".oms", "SYSTEM.md"), "project system prompt\n");

	const prompts = await loadNative<SystemPrompt>(systemPromptCapability.id, { cwd, home, repoRoot: null });

	expect(prompts.map(p => [p.path, p.level])).toEqual([[path.join(project, ".oms", "SYSTEM.md"), "project"]]);
});

test("noncanonical home never becomes a native project config root", async () => {
	const project = path.join(home, "scratch");
	const cwd = path.join(project, "nested");
	const link = path.join(tempDir, "home-link");
	fs.mkdirSync(cwd, { recursive: true });
	fs.symlinkSync(home, link, "dir");
	writeFile(path.join(project, ".oms", "SYSTEM.md"), "project system prompt\n");

	for (const alias of [`${home}${path.sep}`, link]) {
		const ctx: LoadContext = { cwd, home: alias, repoRoot: null };
		const prompts = await loadNative<SystemPrompt>(systemPromptCapability.id, ctx);
		const rules = await loadNative<Rule>(ruleCapability.id, ctx);
		const skills = await loadNative<Skill>(skillCapability.id, ctx);

		expect(prompts.map(p => p.path)).toEqual([path.join(project, ".oms", "SYSTEM.md")]);
		expect(rules.filter(rule => rule.path === path.join(home, ".oms", "RULES.md"))).toEqual([]);
		expect(skills.filter(skill => skill.path === path.join(home, ".oms", "skills", "operator", "SKILL.md"))).toEqual(
			[],
		);
	}

	const atHome: LoadContext = { cwd: home, home: link, repoRoot: null };
	expect((await loadNative<Rule>(ruleCapability.id, atHome)).some(rule => rule._source.level === "project")).toBe(
		false,
	);
});
