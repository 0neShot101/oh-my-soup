import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** Run a test against a tmux CLI that answers one client format query. */
export async function withFakeTmux<T>(format: string, reply: string, run: (binDir: string) => Promise<T>): Promise<T> {
	const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tmux-client-"));
	try {
		const tmux = path.join(binDir, "tmux");
		await Bun.write(
			tmux,
			`#!/bin/sh
[ "$1" = "display-message" ] && [ "$2" = "-p" ] && [ "$3" = '${format}' ] || exit 64
printf 'called\\n' >> "$0.log"
printf "%s\\n" "${reply}"
`,
		);
		await fs.chmod(tmux, 0o755);
		return await run(binDir);
	} finally {
		await fs.rm(binDir, { force: true, recursive: true });
	}
}
