import { afterEach, describe, expect, it, vi } from "bun:test";
import { ensureTool } from "@oh-my-pi/pi-coding-agent/utils/tools-manager";
import * as ptree from "@oh-my-pi/pi-utils/ptree";

describe("ensureTool signal abort handling", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns undefined without spawning installer when signal is already aborted", async () => {
		const execSpy = vi.spyOn(ptree, "exec");
		const signal = AbortSignal.abort(new Error("pre-aborted"));

		const result = await ensureTool("trafilatura", { signal, silent: true });
		if (!result) {
			expect(execSpy).not.toHaveBeenCalled();
		}
	});

	it("does not fall through to pip if uv is aborted", async () => {
		const controller = new AbortController();
		const executedCommands: string[][] = [];

		vi.spyOn(ptree, "exec").mockImplementation(async cmd => {
			executedCommands.push(cmd);
			if (cmd.some(arg => arg.includes("uv"))) {
				controller.abort(new Error("aborted during uv"));
				return {
					stdout: "",
					stderr: "aborted",
					exitCode: null,
					ok: false,
					exitError: new ptree.AbortError("aborted", "cancelled"),
				};
			}
			return {
				stdout: "",
				stderr: "",
				exitCode: 0,
				ok: true,
			};
		});

		const result = await ensureTool("trafilatura", { signal: controller.signal, silent: true });
		if (!result) {
			const ranPip = executedCommands.some(cmd => cmd.some(arg => arg.includes("pip")));
			expect(ranPip).toBe(false);
		}
	});
});
