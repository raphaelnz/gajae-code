import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isStableCode, renderDiagnostic, type StableCode } from "./diagnostics";
import { acquireLock, inspectLock } from "./lock";
import {
	EXECUTABLE_MODE,
	ensureManagedRoots,
	type PathEnvironment,
	PRIVATE_FILE_MODE,
	resolveUpdaterPaths,
	type UpdaterPaths,
} from "./paths";
import { type ConfigV1, isConfigV1, parseUpdaterInstallV1, UPDATER_POLICY_ID } from "./schema";
import { type CommandResult, check, rollback, status, update, validateInstalledSnapshot } from "./transaction";

const HELP = `Usage:
  gjc-mcp help
  gjc-mcp status
  gjc-mcp update
  gjc-mcp update --check
  gjc-mcp rollback`;
const UPDATE_HELP = "Usage: gjc update [--check]";

export interface CliIO {
	out(text: string): void;
	err(text: string): void;
}

export interface CliOptions {
	argv?: readonly string[];
	executable?: string;
	environment?: PathEnvironment & NodeJS.ProcessEnv;
	io?: CliIO;
	exec?: (executable: string, argv: readonly string[], environment: NodeJS.ProcessEnv) => Promise<number> | number;
}

const defaultIO: CliIO = {
	out: text => process.stdout.write(`${text}\n`),
	err: text => process.stderr.write(`${text}\n`),
};

async function sha256File(target: string): Promise<string> {
	const hash = crypto.createHash("sha256");
	hash.update(await fs.readFile(target));
	return hash.digest("hex");
}

async function readJson(target: string): Promise<unknown> {
	return JSON.parse(await fs.readFile(target, "utf8")) as unknown;
}

function errno(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException).code;
}

async function readValidatedConfig(paths: UpdaterPaths): Promise<{ config?: ConfigV1; code?: StableCode }> {
	let stat: Awaited<ReturnType<typeof fs.lstat>>;
	try {
		stat = await fs.lstat(paths.configPath);
	} catch (error) {
		return { code: errno(error) === "ENOENT" ? "GJC_MCP_E_CONFIG_MISSING" : "GJC_MCP_E_CONFIG_IO" };
	}
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		stat.uid !== process.getuid?.() ||
		(stat.mode & 0o777) !== PRIVATE_FILE_MODE
	) {
		return { code: "GJC_MCP_E_CONFIG_SCHEMA" };
	}
	let config: unknown;
	try {
		config = await readJson(paths.configPath);
	} catch {
		return { code: "GJC_MCP_E_CONFIG_IO" };
	}
	return isConfigV1(config) ? { config } : { code: "GJC_MCP_E_CONFIG_SCHEMA" };
}

async function validateUpdater(paths: UpdaterPaths): Promise<StableCode | undefined> {
	let sidecarStat: Awaited<ReturnType<typeof fs.lstat>>;
	try {
		sidecarStat = await fs.lstat(paths.sidecarPath);
	} catch (error) {
		return errno(error) === "ENOENT" ? "GJC_MCP_E_UPDATER_SIDECAR_MISSING" : "GJC_MCP_E_UPDATER_SIDECAR_IO";
	}
	if (!sidecarStat.isFile() || sidecarStat.isSymbolicLink()) return "GJC_MCP_E_UPDATER_SIDECAR_TYPE";
	if (sidecarStat.uid !== process.getuid?.()) return "GJC_MCP_E_UPDATER_SIDECAR_OWNER";
	if ((sidecarStat.mode & 0o777) !== PRIVATE_FILE_MODE) return "GJC_MCP_E_UPDATER_SIDECAR_MODE";
	try {
		await ensureManagedRoots(paths, false);
	} catch {
		return "GJC_MCP_E_PATH_PRECONDITION";
	}
	let sidecarText: string;
	try {
		sidecarText = await fs.readFile(paths.sidecarPath, "utf8");
	} catch {
		return "GJC_MCP_E_UPDATER_SIDECAR_IO";
	}
	const parsed = parseUpdaterInstallV1(sidecarText);
	if (!parsed.ok) return "GJC_MCP_E_UPDATER_SIDECAR_SCHEMA";
	const sidecar = parsed.value;
	if (sidecar.installedPath !== paths.updaterPath || path.resolve(sidecar.installedPath) !== paths.updaterPath)
		return "GJC_MCP_E_UPDATER_PATH";
	let updaterStat: Awaited<ReturnType<typeof fs.lstat>>;
	try {
		updaterStat = await fs.lstat(paths.updaterPath);
	} catch (error) {
		return errno(error) === "ENOENT" ? "GJC_MCP_E_UPDATER_MISSING" : "GJC_MCP_E_UPDATER_IO";
	}
	if (!updaterStat.isFile() || updaterStat.isSymbolicLink()) return "GJC_MCP_E_UPDATER_TYPE";
	if (updaterStat.uid !== process.getuid?.() || sidecar.ownerUid !== process.getuid?.())
		return "GJC_MCP_E_UPDATER_OWNER";
	if ((updaterStat.mode & 0o777) !== EXECUTABLE_MODE || sidecar.mode !== EXECUTABLE_MODE)
		return "GJC_MCP_E_UPDATER_MODE";
	try {
		if ((await sha256File(paths.updaterPath)) !== sidecar.artifactSha256) return "GJC_MCP_E_UPDATER_HASH";
	} catch {
		return "GJC_MCP_E_UPDATER_IO";
	}
	const configResult = await readValidatedConfig(paths);
	if (!configResult.config) return configResult.code ?? "GJC_MCP_E_CONFIG_SCHEMA";
	const config = configResult.config;
	const approval = config.approvedUpdaterSources[sidecar.sourceCommit];
	if (
		!approval ||
		approval.updaterPolicySha256 !== sidecar.updaterPathPolicySha256 ||
		approval.artifactSha256 !== sidecar.artifactSha256 ||
		config.updaterSourcePolicies[UPDATER_POLICY_ID].sha256 !== sidecar.updaterPathPolicySha256
	) {
		return "GJC_MCP_E_UPDATER_SOURCE_UNAPPROVED";
	}
	return undefined;
}

interface RuntimeTarget {
	artifact: string;
	releaseId: string;
}

async function validateRuntime(paths: UpdaterPaths): Promise<{ target?: RuntimeTarget; code?: StableCode }> {
	try {
		await fs.lstat(paths.journalPath);
		return { code: "GJC_MCP_E_RECOVERY_REQUIRED" };
	} catch (error) {
		if (errno(error) !== "ENOENT") return { code: "GJC_MCP_E_RECOVERY_REQUIRED" };
	}
	try {
		const snapshot = await validateInstalledSnapshot(paths);
		return {
			target: {
				artifact: path.join(paths.releasesRoot, snapshot.currentId, snapshot.current.artifact.path),
				releaseId: snapshot.currentId,
			},
		};
	} catch (error) {
		const code =
			typeof error === "object" && error !== null && "code" in error && isStableCode(error.code)
				? error.code
				: "GJC_MCP_E_VERIFY";
		return { code };
	}
}

function emitResult(result: CommandResult, io: CliIO): number {
	const codes = result.diagnostics?.length ? result.diagnostics : [result.code];
	for (const code of codes) {
		const identifiers =
			result.candidate === undefined
				? undefined
				: [
						{
							kind: "tag" as const,
							value: result.candidate.startsWith("v") ? result.candidate : `v${result.candidate}`,
						},
					];
		const message = renderDiagnostic({ code, identifiers });
		if (code === "GJC_MCP_OK") io.out(message);
		else io.err(message);
	}
	return result.code === "GJC_MCP_OK" ? 0 : 1;
}

async function nativeExec(
	executable: string,
	argv: readonly string[],
	environment: NodeJS.ProcessEnv,
): Promise<number> {
	type Execve = (file: string, args: string[], env: Record<string, string>) => never;
	const execve = (process as NodeJS.Process & { execve?: Execve }).execve;
	if (!execve) return 1;
	const cleanEnvironment: Record<string, string> = {};
	for (const [key, value] of Object.entries(environment)) if (value !== undefined) cleanEnvironment[key] = value;
	return execve(executable, [...argv], cleanEnvironment);
}

function managedUpdateArgs(
	argv: readonly string[],
): { dispatch?: readonly string[]; help?: boolean; invalid?: boolean } | undefined {
	if (argv[0] !== "update") return undefined;
	if (argv.length === 1) return { dispatch: ["gjc-mcp", "update"] };
	if (argv.length === 2 && argv[1] === "--check") return { dispatch: ["gjc-mcp", "update", "--check"] };
	if (argv.length === 2 && (argv[1] === "--help" || argv[1] === "-h")) return { help: true };
	return { invalid: true };
}

type UpdaterCommand = "status" | "update" | "check" | "rollback";

function parseUpdaterCommand(argv: readonly string[]): UpdaterCommand | undefined {
	if (argv.length === 1 && argv[0] === "status") return "status";
	if (argv.length === 1 && argv[0] === "update") return "update";
	if (argv.length === 2 && argv[0] === "update" && argv[1] === "--check") return "check";
	if (argv.length === 1 && argv[0] === "rollback") return "rollback";
	return undefined;
}

function appendDiagnostic(diagnostics: StableCode[], code: StableCode | undefined): void {
	if (code && !diagnostics.includes(code)) diagnostics.push(code);
}

async function updaterStatus(paths: UpdaterPaths): Promise<CommandResult> {
	const diagnostics: StableCode[] = [];
	appendDiagnostic(diagnostics, await validateUpdater(paths));
	const lock = await inspectLock(paths.lockPath);
	if (lock.state !== "absent") appendDiagnostic(diagnostics, lock.code);
	const config = await readValidatedConfig(paths);
	appendDiagnostic(diagnostics, config.code);
	const local = await status({ paths });
	for (const code of local.diagnostics ?? [local.code]) appendDiagnostic(diagnostics, code);
	const runtime = await validateRuntime(paths);
	appendDiagnostic(diagnostics, runtime.code);
	return { code: diagnostics[0] ?? "GJC_MCP_OK", changed: false, diagnostics };
}

async function runLocked(paths: UpdaterPaths, operation: () => Promise<CommandResult>): Promise<CommandResult> {
	const acquired = await acquireLock(paths.lockPath);
	if (!acquired.ok) return { code: acquired.code, changed: false };
	try {
		return await operation();
	} finally {
		await acquired.lock.release();
	}
}

export async function runCli(options: CliOptions = {}): Promise<number> {
	const argv = options.argv ?? process.argv.slice(2);
	const executable = options.executable ?? process.execPath;
	const environment: PathEnvironment & NodeJS.ProcessEnv = options.environment ?? process.env;
	const io = options.io ?? defaultIO;
	const exec = options.exec ?? nativeExec;
	const basename = path.basename(executable);
	if (basename === "gjc-mcp") {
		if (argv.length === 1 && argv[0] === "help") {
			io.out(HELP);
			return 0;
		}
		const command = parseUpdaterCommand(argv);
		if (!command) {
			io.err(renderDiagnostic({ code: "GJC_MCP_E_USAGE" }));
			return 2;
		}
		let paths: UpdaterPaths;
		try {
			paths = resolveUpdaterPaths(environment);
		} catch {
			io.err(renderDiagnostic({ code: "GJC_MCP_E_PATH_PRECONDITION" }));
			return 1;
		}
		try {
			if (command === "status") return emitResult(await updaterStatus(paths), io);
			const updaterFault = await validateUpdater(paths);
			if (updaterFault) return emitResult({ code: updaterFault, changed: false }, io);
			const result = await runLocked(paths, () => {
				if (command === "check") return check({ paths });
				if (command === "update") return update({ paths });
				return rollback({ paths });
			});
			return emitResult(result, io);
		} catch {
			io.err(renderDiagnostic({ code: "GJC_MCP_E_PATH_PRECONDITION" }));
			return 1;
		}
	}
	if (basename !== "gjc") {
		io.err(renderDiagnostic({ code: "GJC_MCP_E_USAGE" }));
		return 2;
	}
	const managed = managedUpdateArgs(argv);
	if (managed?.help) {
		io.out(UPDATE_HELP);
		return 0;
	}
	if (managed?.invalid) {
		io.err(renderDiagnostic({ code: "GJC_MCP_E_MANAGED_UPDATE_ARGS" }));
		return 2;
	}
	let paths: UpdaterPaths;
	try {
		paths = resolveUpdaterPaths(environment);
	} catch {
		io.err(renderDiagnostic({ code: "GJC_MCP_E_PATH_PRECONDITION" }));
		return 1;
	}
	{
		if (managed?.dispatch) {
			const fault = await validateUpdater(paths);
			if (fault) {
				io.err(renderDiagnostic({ code: fault }));
				return 1;
			}
			const code = await exec(paths.updaterPath, managed.dispatch, environment);
			if (code === 1) io.err(renderDiagnostic({ code: "GJC_MCP_E_UPDATER_EXEC" }));
			return code;
		}
		const runtime = await validateRuntime(paths);
		if (!runtime.target || runtime.code) {
			io.err(renderDiagnostic({ code: runtime.code ?? "GJC_MCP_E_VERIFY" }));
			io.err("Recovery: run gjc-mcp status");
			io.err("Recovery: run gjc-mcp rollback");
			return 1;
		}
		const code = await exec(runtime.target.artifact, ["gjc", ...argv], environment);
		if (code === 1) io.err(renderDiagnostic({ code: "GJC_MCP_E_RUNTIME_EXEC" }));
		return code;
	}
}

if (import.meta.main) process.exitCode = await runCli();
