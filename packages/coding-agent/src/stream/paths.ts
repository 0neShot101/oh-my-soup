import { ipcEndpoint } from "@oh-my-soup/pi-natives";
import { getDaemonRuntimeDir } from "@oh-my-soup/pi-utils";
import { canonicalProjectDir } from "../launch/paths";

/**
 * Resolve the local IPC endpoint `oms stream` listens on for one project
 * directory. Shares the daemon broker's canonical-cwd hashing so every oms
 * process in the same directory agrees on the endpoint.
 */
export async function streamSocketEndpoint(projectDir: string): Promise<string> {
	return ipcEndpoint(getDaemonRuntimeDir(await canonicalProjectDir(projectDir)), "stream");
}
