import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { encodeArchive } from "../src/ar/write";
import * as dirs from "../src/dirs";
import { getManagedBunEnv, getManagedPythonEnv } from "../src/env";
import { TempDir } from "../src/temp";

afterEach(() => vi.restoreAllMocks());

describe("managed dependency storage", () => {
	it.each(["default", "override"] as const)(
		"installs a usable runtime without creating ~/.bun (%s)",
		async mode => {
			using temp = TempDir.createSync("@oms-dependency-storage-");
			const home = temp.join("home");
			await fs.mkdir(home);
			const archive = await encodeArchive("tar.gz", [
				[
					"package/package.json",
					JSON.stringify({ name: "oms-storage-fixture", version: "1.0.0", main: "index.js" }),
				],
				["package/index.js", "module.exports = (left, right) => left * right;"],
			]);
			const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(archive) });
			const customCache = temp.join("custom-cache");
			try {
				const proc = Bun.spawn(
					[
						process.execPath,
						path.join(import.meta.dir, "fixtures", "managed-dependency-install.ts"),
						path.join(home, ".oms", "runtime"),
						`http://127.0.0.1:${server.port}/package.tgz`,
					],
					{
						cwd: home,
						env: {
							...process.env,
							HOME: home,
							USERPROFILE: home,
							PI_CONFIG_DIR: ".oms",
							PI_CODING_AGENT_DIR: path.join(home, ".oms", "agent"),
							OMS_PROFILE: "",
							OMP_PROFILE: "",
							PI_PROFILE: "",
							XDG_CACHE_HOME: "",
							XDG_DATA_HOME: "",
							XDG_STATE_HOME: "",
							BUN_INSTALL_CACHE_DIR: mode === "override" ? customCache : "",
							// Source fixtures must not create their own cache before importing the installer.
							BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
						},
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				const [code, stdout, stderr] = await Promise.all([
					proc.exited,
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
				]);
				expect(code, stderr).toBe(0);
				expect(JSON.parse(stdout)).toEqual({ value: 42 });
				expect(await fs.readdir(home)).toEqual([".oms"]);
				const managedCache = path.join(home, ".oms", "dependencies", "bun", "cache");
				expect((await fs.stat(mode === "override" ? customCache : managedCache)).isDirectory()).toBe(true);
				if (mode === "override") await expect(fs.stat(managedCache)).rejects.toMatchObject({ code: "ENOENT" });
			} finally {
				server.stop(true);
			}
		},
		30_000,
	);

	it("defaults only missing Python storage variables without redirecting home, XDG, or configured caches", () => {
		using temp = TempDir.createSync("@oms-python-storage-");
		vi.spyOn(dirs, "getManagedDependencyDir").mockImplementation(name => temp.join("dependencies", name));
		const base = Object.freeze({
			HOME: temp.join("home"),
			XDG_CONFIG_HOME: temp.join("user-config"),
			PIP_CACHE_DIR: temp.join("custom-pip-cache"),
			UV_PYTHON_INSTALL_DIR: temp.join("custom-python"),
			UV_CACHE_DIR: "",
		});
		const env = getManagedPythonEnv(base);
		expect(env.UV_CACHE_DIR).toBe(temp.join("dependencies", "uv", "cache"));
		expect(env.PIP_CACHE_DIR).toBe(base.PIP_CACHE_DIR);
		expect(env.UV_PYTHON_INSTALL_DIR).toBe(base.UV_PYTHON_INSTALL_DIR);
		expect(env.HOME).toBe(base.HOME);
		expect(env.XDG_CONFIG_HOME).toBe(base.XDG_CONFIG_HOME);
		expect(env.PYTHONUSERBASE).toBeUndefined();
		expect(base.UV_CACHE_DIR).toBe("");
	});

	it("preserves explicitly disabled Bun transpiler caching", () => {
		for (const disabled of ["", "0"]) {
			const env = getManagedBunEnv({ BUN_RUNTIME_TRANSPILER_CACHE_PATH: disabled });
			expect(env.BUN_RUNTIME_TRANSPILER_CACHE_PATH).toBe(disabled);
		}
	});

	it.skipIf(process.platform !== "win32")("honors case-insensitive Windows Python cache overrides", () => {
		const env = getManagedPythonEnv({ pip_cache_dir: "C:\\cache\\pip", uv_cache_dir: "C:\\cache\\uv" });
		expect(env.pip_cache_dir).toBe("C:\\cache\\pip");
		expect(env.uv_cache_dir).toBe("C:\\cache\\uv");
		expect(env.PIP_CACHE_DIR).toBeUndefined();
		expect(env.UV_CACHE_DIR).toBeUndefined();
	});
});
