/**
 * In-memory registry of SSH sessions an agent opened with ad hoc credentials
 * (`xd://ssh connect`), plus name resolution shared by `bash target=`, the
 * `ssh` device, and `ssh://` URLs.
 *
 * A session is an {@link SSHConnectionTarget} whose credentials live only in
 * this process: the password (or key path) is held here for the lifetime of
 * the session so every command, transfer, and reconnect can re-authenticate —
 * nothing is written to disk. A configured host (`ssh.json`) is also a valid
 * target name; it needs no explicit connect because its credentials are on
 * disk already.
 */

import * as os from "node:os";
import * as path from "node:path";
import * as capability from "../capability";
import { type SSHHost, sshCapability } from "../capability/ssh";
import {
	closeConnection,
	ensureConnection,
	ensureHostInfo,
	getActivePortForwards,
	getCachedHostInfoSync,
	type SSHConnectionTarget,
	type SSHHostInfo,
	type SSHPortForward,
	startPortForward,
	stopAllPortForwards,
	stopPortForward,
} from "./connection-manager";

// `tools/path-utils` (home of expandTilde) pulls in the internal-url router,
// which loads the ssh:// handler, which needs this module — so expand `~` here.
function expandHome(filePath: string): string {
	if (filePath === "~") return os.homedir();
	return filePath.startsWith("~/") || filePath.startsWith("~\\")
		? path.join(os.homedir(), filePath.slice(2))
		: filePath;
}

export type SSHPortForwardInput =
	| string
	| {
			type?: "local" | "remote" | "dynamic";
			localPort?: number;
			localHost?: string;
			remotePort?: number;
			remoteHost?: string;
	  };

/** What the agent supplies to open a session; everything but `host` is optional. */
export interface SSHSessionRequest {
	/** Host name or address, or `[user@]host[:port]`. */
	host: string;
	/** Session name for later `target=` references; defaults to `user@host[:port]`. */
	name?: string;
	username?: string;
	port?: number;
	/** Local private key path (`~` expands). */
	keyPath?: string;
	password?: string;
	/** Windows hosts: run commands under a POSIX compat shell when one is found (default on). */
	compat?: boolean;
	/** Optional port forwards to establish on connect. */
	forwards?: readonly SSHPortForwardInput[];
}

export interface SSHSessionInfo {
	name: string;
	/** `[user@]host[:port]` */
	address: string;
	auth: "password" | "key" | "agent";
	/** Remote OS/shell facts, once probed. */
	hostInfo?: SSHHostInfo;
	/** True for sessions opened in this process; false for configured `ssh.json` hosts. */
	adHoc: boolean;
	/** Active port forwards / tunnels on this session or host. */
	forwards?: SSHPortForward[];
}

const sessions = new Map<string, SSHConnectionTarget>();

/** Length cap for a session name: it keys caches and on-disk host-info files. */
const MAX_SESSION_NAME = 128;

export function formatSshAddress(target: Pick<SSHConnectionTarget, "host" | "username" | "port">): string {
	const host = target.host.includes(":") && !target.host.startsWith("[") ? `[${target.host}]` : target.host;
	return `${target.username ? `${target.username}@` : ""}${host}${target.port ? `:${target.port}` : ""}`;
}

/**
 * Split a `[user@]host[:port]` destination. A bracketed IPv6 literal keeps
 * its colons; anything else with a trailing `:digits` is a port.
 */
export function parseSshDestination(value: string): { host: string; username?: string; port?: number } {
	let rest = value.trim();
	let username: string | undefined;
	const at = rest.lastIndexOf("@");
	if (at > 0) {
		username = rest.slice(0, at);
		rest = rest.slice(at + 1);
	} else if (at === 0) {
		throw new Error(`Invalid SSH destination "${value}": empty username before '@'`);
	}
	let port: number | undefined;
	let host = rest;
	const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(rest);
	if (bracketed) {
		host = bracketed[1]!;
		if (bracketed[2] !== undefined) port = Number(bracketed[2]);
	} else {
		const colon = rest.lastIndexOf(":");
		if (colon > 0 && rest.indexOf(":") === colon) {
			const digits = rest.slice(colon + 1);
			if (!/^\d+$/.test(digits)) throw new Error(`Invalid SSH destination "${value}": port must be numeric`);
			port = Number(digits);
			host = rest.slice(0, colon);
		}
	}
	if (!host) throw new Error(`Invalid SSH destination "${value}": missing host`);
	if (port !== undefined && (port < 1 || port > 65535)) {
		throw new Error(`Invalid SSH destination "${value}": port must be 1-65535`);
	}
	return { host, username, port };
}

function authKind(target: SSHConnectionTarget): SSHSessionInfo["auth"] {
	if (target.password !== undefined) return "password";
	return target.keyPath ? "key" : "agent";
}

function toInfo(target: SSHConnectionTarget, adHoc: boolean, hostInfo?: SSHHostInfo): SSHSessionInfo {
	const forwards = getActivePortForwards(target.name);
	return {
		name: target.name,
		address: formatSshAddress(target),
		auth: authKind(target),
		hostInfo,
		adHoc,
		...(forwards.length > 0 ? { forwards } : {}),
	};
}

function formatForwardHost(host: string): string {
	const trimmed = host.trim() || "127.0.0.1";
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed;
	return trimmed.includes(":") ? `[${trimmed}]` : trimmed;
}

function validatePortNumber(port: number, label: string): number {
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`Invalid SSH ${label} port "${port}": must be an integer between 1 and 65535`);
	}
	return port;
}

function splitForwardTokens(spec: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inBrackets = false;
	for (let i = 0; i < spec.length; i++) {
		const ch = spec[i]!;
		if (ch === "[") {
			inBrackets = true;
			current += ch;
		} else if (ch === "]") {
			inBrackets = false;
			current += ch;
		} else if (ch === ":" && !inBrackets) {
			tokens.push(current);
			current = "";
		} else {
			current += ch;
		}
	}
	tokens.push(current);
	return tokens;
}

/** Parse a shorthand string or structured port-forward request into a canonical OpenSSH forward spec. */
export function parsePortForward(
	input: SSHPortForwardInput,
	defaultType: "local" | "remote" | "dynamic" = "local",
): SSHPortForward {
	if (typeof input === "string") {
		let rest = input.trim();
		let type = defaultType;
		const prefixMatch = /^(?:-(L|R|D)\s*|(L|R|D|local|remote|dynamic):)/i.exec(rest);
		if (prefixMatch) {
			const token = (prefixMatch[1] ?? prefixMatch[2] ?? "").toLowerCase();
			if (token === "l" || token === "local") type = "local";
			else if (token === "r" || token === "remote") type = "remote";
			else if (token === "d" || token === "dynamic") type = "dynamic";
			rest = rest.slice(prefixMatch[0].length).trim();
		}
		const parts = splitForwardTokens(rest);
		if (type === "dynamic") {
			if (parts.length === 1 && /^\d+$/.test(parts[0]!)) {
				const listenPort = validatePortNumber(Number(parts[0]), "dynamic listen");
				const bindAddress = "127.0.0.1";
				return { type, flag: "-D", spec: `${bindAddress}:${listenPort}`, bindAddress, listenPort };
			}
			if (parts.length === 2 && /^\d+$/.test(parts[1]!)) {
				const bindAddress = formatForwardHost(parts[0]!);
				const listenPort = validatePortNumber(Number(parts[1]), "dynamic listen");
				return { type, flag: "-D", spec: `${bindAddress}:${listenPort}`, bindAddress, listenPort };
			}
			throw new Error(
				`Invalid dynamic SSH forward "${input}": expected "[bind_address:]port" (e.g. "1080" or "127.0.0.1:1080")`,
			);
		}
		const flag = type === "remote" ? "-R" : "-L";
		if (parts.length === 3 && /^\d+$/.test(parts[0]!) && /^\d+$/.test(parts[2]!)) {
			const listenPort = validatePortNumber(Number(parts[0]), "listen");
			const bindAddress = "127.0.0.1";
			const targetHost = formatForwardHost(parts[1]!);
			const targetPort = validatePortNumber(Number(parts[2]), "target");
			return {
				type,
				flag,
				spec: `${bindAddress}:${listenPort}:${targetHost}:${targetPort}`,
				bindAddress,
				listenPort,
				targetHost,
				targetPort,
			};
		}
		if (parts.length === 4 && /^\d+$/.test(parts[1]!) && /^\d+$/.test(parts[3]!)) {
			const bindAddress = formatForwardHost(parts[0]!);
			const listenPort = validatePortNumber(Number(parts[1]), "listen");
			const targetHost = formatForwardHost(parts[2]!);
			const targetPort = validatePortNumber(Number(parts[3]), "target");
			return {
				type,
				flag,
				spec: `${bindAddress}:${listenPort}:${targetHost}:${targetPort}`,
				bindAddress,
				listenPort,
				targetHost,
				targetPort,
			};
		}
		throw new Error(
			`Invalid SSH port forward "${input}": expected "[bind_address:]port:host:hostport" (e.g. "8080:127.0.0.1:80")`,
		);
	}

	const type = input.type ?? defaultType;
	if (type === "dynamic") {
		if (input.localPort === undefined) {
			throw new Error("Dynamic SSH port forward (-D) requires local_port");
		}
		const listenPort = validatePortNumber(input.localPort, "local");
		const bindAddress = formatForwardHost(input.localHost ?? "127.0.0.1");
		return { type, flag: "-D", spec: `${bindAddress}:${listenPort}`, bindAddress, listenPort };
	}
	if (input.localPort === undefined || input.remotePort === undefined) {
		throw new Error(
			`${type === "remote" ? "Remote (-R)" : "Local (-L)"} SSH port forward requires both local_port and remote_port`,
		);
	}
	const localPort = validatePortNumber(input.localPort, "local");
	const remotePort = validatePortNumber(input.remotePort, "remote");
	const localHost = formatForwardHost(input.localHost ?? "127.0.0.1");
	const remoteHost = formatForwardHost(input.remoteHost ?? "127.0.0.1");
	if (type === "remote") {
		return {
			type,
			flag: "-R",
			spec: `${remoteHost}:${remotePort}:${localHost}:${localPort}`,
			bindAddress: remoteHost,
			listenPort: remotePort,
			targetHost: localHost,
			targetPort: localPort,
		};
	}
	return {
		type: "local",
		flag: "-L",
		spec: `${localHost}:${localPort}:${remoteHost}:${remotePort}`,
		bindAddress: localHost,
		listenPort: localPort,
		targetHost: remoteHost,
		targetPort: remotePort,
	};
}

/** The target a session request resolves to, before any connection is made. */
export function sessionTargetFromRequest(request: SSHSessionRequest): SSHConnectionTarget {
	const destination = parseSshDestination(request.host);
	const username = request.username?.trim() || destination.username;
	const port = request.port ?? destination.port;
	if (request.port !== undefined && (!Number.isInteger(request.port) || request.port < 1 || request.port > 65535)) {
		throw new Error("SSH port must be an integer between 1 and 65535");
	}
	// `user`/`port` fill in what the destination lacks; a disagreement is a typo, never a silent override.
	if (request.username !== undefined && destination.username && request.username.trim() !== destination.username) {
		throw new Error(
			`Conflicting usernames: "${request.username}" and "${destination.username}" in "${request.host}"`,
		);
	}
	if (request.port !== undefined && destination.port !== undefined && request.port !== destination.port) {
		throw new Error(`Conflicting ports: ${request.port} and ${destination.port} in "${request.host}"`);
	}
	const target: SSHConnectionTarget = { name: "", host: destination.host, username, port };
	const name = request.name?.trim() || formatSshAddress(target);
	if (name.length > MAX_SESSION_NAME || /[\s/\\]/.test(name)) {
		throw new Error(
			`Invalid session name "${name}": no whitespace or slashes, at most ${MAX_SESSION_NAME} characters`,
		);
	}
	target.name = name;
	if (request.keyPath?.trim()) target.keyPath = path.resolve(expandHome(request.keyPath.trim()));
	if (request.password !== undefined) target.password = request.password;
	if (request.compat !== undefined) target.compat = request.compat;
	return target;
}

/**
 * Authenticate against the host and register the session. A session name
 * that is already open with the same address is replaced (its credentials are
 * refreshed); a name that belongs to a configured host or to a session with a
 * different address is refused so `target=` can never silently change host.
 */
export async function openSession(request: SSHSessionRequest, cwd?: string): Promise<SSHSessionInfo> {
	const target = sessionTargetFromRequest(request);
	const existing = sessions.get(target.name);
	if (existing && formatSshAddress(existing) !== formatSshAddress(target)) {
		throw new Error(
			`Session "${target.name}" is already open to ${formatSshAddress(existing)}; disconnect it first or pick another name`,
		);
	}
	if (!existing) {
		const configured = (await loadConfiguredHosts(cwd)).find(host => host.name === target.name);
		if (configured) {
			throw new Error(
				`"${target.name}" is a configured host in ssh.json (${formatSshAddress(configured)}); use it as target directly, or choose another session name`,
			);
		}
	}
	if (existing) await closeConnection(existing.name);
	await ensureConnection(target);
	sessions.set(target.name, target);
	const hostInfo = await ensureHostInfo(target);
	if (request.forwards?.length) {
		for (const item of request.forwards) {
			await startPortForward(target, parsePortForward(item));
		}
	}
	return toInfo(target, true, hostInfo);
}

/** Close the connection and forget the session's credentials. False when no such session is open. */
export async function closeSession(name: string): Promise<boolean> {
	const target = sessions.get(name);
	if (!target) return false;
	sessions.delete(name);
	await closeConnection(target.name);
	return true;
}

export function getSession(name: string): SSHConnectionTarget | undefined {
	return sessions.get(name);
}

/** Sessions opened in this process, with whatever host info has been probed so far. */
export function openSessions(): SSHSessionInfo[] {
	return [...sessions.values()].map(target => toInfo(target, true, getCachedHostInfoSync(target)));
}

/** Open sessions first, then configured hosts that are not shadowed by a session of the same name. */
export async function listSessions(cwd?: string): Promise<SSHSessionInfo[]> {
	const configured = (await loadConfiguredHosts(cwd))
		.filter(host => !sessions.has(host.name))
		.map(host => {
			const target = configuredTarget(host);
			return toInfo(target, false, getCachedHostInfoSync(target));
		});
	return [...openSessions(), ...configured];
}

async function loadConfiguredHosts(cwd?: string): Promise<SSHHost[]> {
	const result = await capability.loadCapability<SSHHost>(sshCapability.id, cwd ? { cwd } : {});
	return result.items;
}

export function configuredTarget(host: SSHHost): SSHConnectionTarget {
	return {
		name: host.name,
		host: host.host,
		username: host.username,
		port: host.port,
		keyPath: host.keyPath,
		password: host.password,
		compat: host.compat,
	};
}

/**
 * Resolve a `target=` name: an open session first, then a configured host.
 * Returns undefined when neither exists so the caller can explain how to
 * connect.
 */
export async function resolveSessionTarget(name: string, cwd?: string): Promise<SSHConnectionTarget | undefined> {
	const open = sessions.get(name);
	if (open) return open;
	const configured = (await loadConfiguredHosts(cwd)).find(host => host.name === name);
	return configured ? configuredTarget(configured) : undefined;
}

/** Establish one or more SSH port forwards on an open session or configured host. */
export async function forwardSessionPorts(
	name: string,
	inputs: readonly SSHPortForwardInput[],
	cwd?: string,
): Promise<{ session: SSHSessionInfo; forwards: SSHPortForward[] }> {
	if (inputs.length === 0) {
		throw new Error("forward requires at least one port forward specification");
	}
	const target = await resolveSessionTarget(name, cwd);
	if (!target) {
		throw new Error(
			`Unknown SSH target "${name}". Open a session first (op="connect") or pass a configured ssh.json host name.`,
		);
	}
	const parsed = inputs.map(item => parsePortForward(item));
	const established: SSHPortForward[] = [];
	for (const forward of parsed) {
		established.push(await startPortForward(target, forward));
	}
	const adHoc = sessions.has(target.name);
	return {
		session: toInfo(target, adHoc, getCachedHostInfoSync(target)),
		forwards: established,
	};
}

/** Cancel specific port forwards (or all active forwards when `inputs` is empty) on a session or host. */
export async function unforwardSessionPorts(
	name: string,
	inputs: readonly SSHPortForwardInput[] = [],
	cwd?: string,
): Promise<{ session: SSHSessionInfo; removed: number }> {
	const target = await resolveSessionTarget(name, cwd);
	if (!target) {
		throw new Error(`Unknown SSH target "${name}".`);
	}
	let removed = 0;
	if (inputs.length === 0) {
		removed = await stopAllPortForwards(target);
	} else {
		const parsed = inputs.map(item => parsePortForward(item));
		for (const forward of parsed) {
			if (await stopPortForward(target, forward)) removed++;
		}
	}
	const adHoc = sessions.has(target.name);
	return {
		session: toInfo(target, adHoc, getCachedHostInfoSync(target)),
		removed,
	};
}

/** Close every ad hoc session (process shutdown). */
export async function closeAllSessions(): Promise<void> {
	for (const name of [...sessions.keys()]) await closeSession(name);
}
