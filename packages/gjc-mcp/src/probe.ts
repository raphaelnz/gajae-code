import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export type OfficialSupport = "unsupported" | "full" | "partial" | "infrastructure";

export const PROBE_CASES = [
	"eligible-modes",
	"subsession-absence",
	"project-disabled",
	"autoload-false",
	"complete-global-catalog",
	"zero-tool-server",
	"cache-disabled",
	"auth-env-bare-command",
	"headers-oauth",
	"frozen-definitions",
	"cleanup-once",
] as const;
export type ProbeCase = (typeof PROBE_CASES)[number];
export type ProbeObservations = Partial<Record<ProbeCase, boolean | "infrastructure">>;

/** A deterministic, fail-closed classifier. Missing observations mean unsupported, not success. */
export function classifyOfficialSupport(observations: ProbeObservations): OfficialSupport {
	const values = PROBE_CASES.map(name => observations[name]);
	if (values.some(value => value === "infrastructure")) return "infrastructure";
	const passing = values.filter(value => value === true).length;
	if (passing === PROBE_CASES.length) return "full";
	if (passing === 0) return "unsupported";
	return "partial";
}

export interface BinaryProbeOptions {
	binary: string;
	expectedVersion: string;
	home: string;
	timeoutMs?: number;
	/** Must be set only after source/path trust and artifact hash validation. */
	trusted: boolean;
	/** Revalidated immediately before each execution when supplied by the trusted caller. */
	expectedSha256?: string;
	/** Retained for API compatibility; symlink execution is always rejected. */
	allowSymlink?: false;
}

async function execute(
	options: BinaryProbeOptions,
	args: readonly string[],
): Promise<{ success: boolean; stdout: string }> {
	if (!options.trusted || !path.isAbsolute(options.binary)) return { success: false, stdout: "" };
	const resolved = await fs.realpath(options.binary).catch(() => null);
	if (!resolved || resolved !== path.resolve(options.binary)) return { success: false, stdout: "" };
	const stat = await fs.lstat(options.binary).catch(() => null);
	if (!stat?.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o755) {
		return { success: false, stdout: "" };
	}
	if (options.expectedSha256) {
		if (!/^[0-9a-f]{64}$/.test(options.expectedSha256)) return { success: false, stdout: "" };
		const bytes = new Uint8Array(await Bun.file(options.binary).arrayBuffer());
		const actual = crypto.createHash("sha256").update(bytes).digest("hex");
		if (actual !== options.expectedSha256) return { success: false, stdout: "" };
	}
	const isolated = path.join(options.home, `.gjc-mcp-probe-${crypto.randomUUID()}`);
	await fs.mkdir(isolated, { recursive: true, mode: 0o700 });
	const isolatedRealpath = await fs.realpath(isolated).catch(() => null);
	const isolatedStat = await fs.lstat(isolated).catch(() => null);
	if (
		isolatedRealpath !== path.resolve(isolated) ||
		!isolatedStat?.isDirectory() ||
		isolatedStat.isSymbolicLink() ||
		isolatedStat.uid !== process.getuid?.() ||
		(isolatedStat.mode & 0o777) !== 0o700
	) {
		await fs.rm(isolated, { recursive: true, force: true });
		return { success: false, stdout: "" };
	}
	const executablePath = "/usr/bin:/bin";
	const child = Bun.spawn([options.binary, ...args], {
		cwd: isolated,
		env: {
			HOME: isolated,
			XDG_CONFIG_HOME: path.join(isolated, "config"),
			XDG_DATA_HOME: path.join(isolated, "data"),
			XDG_STATE_HOME: path.join(isolated, "state"),
			XDG_CACHE_HOME: path.join(isolated, "cache"),
			PATH: executablePath,
			LANG: "C",
			LC_ALL: "C",
			GJC_DISABLE_PROJECT_CONFIG: "1",
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "ignore",
	});
	const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 30_000);
	try {
		const reader = child.stdout.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			size += next.value.byteLength;
			if (size > 4096) {
				child.kill();
				await child.exited;
				return { success: false, stdout: "" };
			}
			chunks.push(next.value);
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const status = await child.exited;
		return { success: status === 0, stdout: new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim() };
	} catch {
		child.kill();
		await child.exited;
		return { success: false, stdout: "" };
	} finally {
		clearTimeout(timer);
		await fs.rm(isolated, { recursive: true, force: true });
	}
}

export async function verifyCandidateVersion(options: BinaryProbeOptions): Promise<boolean> {
	const result = await execute(options, ["--version"]);
	return result.success && result.stdout === `gjc/${options.expectedVersion}`;
}

export async function verifyCandidateSmoke(options: BinaryProbeOptions): Promise<boolean> {
	const result = await execute(options, ["--smoke-test"]);
	return result.success;
}

export async function verifyCandidateBinary(options: BinaryProbeOptions): Promise<boolean> {
	return (await verifyCandidateVersion(options)) && (await verifyCandidateSmoke(options));
}

export async function verifyFallbackBinary(options: Omit<BinaryProbeOptions, "expectedVersion">): Promise<boolean> {
	return verifyCandidateBinary({ ...options, expectedVersion: "0.9.6", allowSymlink: false });
}
