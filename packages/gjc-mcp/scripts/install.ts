import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { renderDiagnostic, type StableCode } from "../src/diagnostics";
import { acquireLock } from "../src/lock";
import { EXECUTABLE_MODE, ensureManagedRoots, PRIVATE_FILE_MODE, resolveUpdaterPaths } from "../src/paths";
import {
	type ConfigV1,
	isConfigV1,
	isHex40,
	isHex64,
	parseStateV1,
	parseUpdaterInstallV1,
	serializeUpdaterInstallV1,
	UPDATER_POLICY_ID,
	type UpdaterInstallV1,
} from "../src/schema";
import { bootstrap } from "../src/transaction";

interface InstallMetadata {
	sourceCommit: string;
	policySha256: string;
	config: ConfigV1;
}

export interface TargetSnapshot {
	present: boolean;
	valid: boolean;
	hash?: string;
}

export interface SidecarSnapshot {
	present: boolean;
	valid: boolean;
	value?: UpdaterInstallV1;
}

export type InstallClassification =
	| "fresh"
	| "orphan-candidate"
	| "healthy-equal"
	| "healthy-old"
	| "rename-before-sidecar";

function fail(code: StableCode, exitCode: 1 | 2 = 1): never {
	process.stderr.write(`${renderDiagnostic({ code })}\n`);
	process.exit(exitCode);
}

function parseArguments(argv: readonly string[]): string | undefined {
	if (argv.length === 0) return undefined;
	if (argv.length === 2 && argv[0] === "--expected-old-sha" && isHex64(argv[1])) return argv[1];
	fail("GJC_MCP_E_USAGE", 2);
}

function metadataFromEnvironment(): InstallMetadata {
	const sourceCommit = process.env.GJC_MCP_INSTALL_SOURCE_COMMIT;
	const policySha256 = process.env.GJC_MCP_INSTALL_POLICY_SHA256;
	const configText = process.env.GJC_MCP_INSTALL_CONFIG_JSON;
	if (!isHex40(sourceCommit) || !isHex64(policySha256) || configText === undefined)
		fail("GJC_MCP_E_APPROVAL_REQUIRED");
	let config: unknown;
	try {
		config = JSON.parse(configText) as unknown;
	} catch {
		fail("GJC_MCP_E_CONFIG_SCHEMA");
	}
	if (!isConfigV1(config)) fail("GJC_MCP_E_CONFIG_SCHEMA");
	const approval = config.approvedUpdaterSources[sourceCommit];
	if (
		!approval ||
		approval.updaterPolicySha256 !== policySha256 ||
		config.updaterSourcePolicies[UPDATER_POLICY_ID].sha256 !== policySha256
	)
		fail("GJC_MCP_E_UPDATER_SOURCE_UNAPPROVED");
	return { sourceCommit, policySha256, config };
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function hashFile(target: string): Promise<string> {
	return hashBytes(await fs.readFile(target));
}

async function snapshotTarget(target: string, uid: number): Promise<TargetSnapshot> {
	try {
		const stat = await fs.lstat(target);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o777) !== EXECUTABLE_MODE)
			return { present: true, valid: false };
		return { present: true, valid: true, hash: await hashFile(target) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { present: false, valid: false };
		return { present: true, valid: false };
	}
}

async function snapshotSidecar(target: string, uid: number): Promise<SidecarSnapshot> {
	try {
		const stat = await fs.lstat(target);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o777) !== PRIVATE_FILE_MODE)
			return { present: true, valid: false };
		const parsed = parseUpdaterInstallV1(await fs.readFile(target, "utf8"));
		if (!parsed.ok || parsed.value.ownerUid !== uid) return { present: true, valid: false };
		return { present: true, valid: true, value: parsed.value };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { present: false, valid: false };
		return { present: true, valid: false };
	}
}

function sidecarDescribes(value: UpdaterInstallV1, installedPath: string, hash: string): boolean {
	return value.installedPath === installedPath && value.artifactSha256 === hash && value.mode === EXECUTABLE_MODE;
}

export function classifyInstallerSnapshot(
	target: TargetSnapshot,
	sidecar: SidecarSnapshot,
	candidateHash: string,
	installedPath: string,
	expectedOld: string | undefined,
): InstallClassification | undefined {
	if (!target.present && !sidecar.present && expectedOld === undefined) return "fresh";
	if (target.valid && target.hash === candidateHash && !sidecar.present && expectedOld === undefined)
		return "orphan-candidate";
	if (!target.valid || !sidecar.valid || !sidecar.value || !target.hash) return undefined;
	const old = sidecar.value;
	if (target.hash === candidateHash && sidecarDescribes(old, installedPath, candidateHash)) return "healthy-equal";
	if (
		target.hash !== candidateHash &&
		sidecarDescribes(old, installedPath, target.hash) &&
		expectedOld === target.hash
	)
		return "healthy-old";
	if (target.hash === candidateHash && expectedOld !== undefined && sidecarDescribes(old, installedPath, expectedOld))
		return "rename-before-sidecar";
	return undefined;
}

async function fsyncDirectory(directory: string): Promise<void> {
	const handle = await fs.open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function atomicWrite(target: string, bytes: Uint8Array | string, mode: number): Promise<void> {
	const directory = path.dirname(target);
	const temporary = path.join(
		directory,
		`.${path.basename(target)}.install.${crypto.randomBytes(12).toString("hex")}`,
	);
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(temporary, "wx", mode);
		await handle.writeFile(bytes);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await fs.rename(temporary, target);
		await fsyncDirectory(directory);
	} catch (error) {
		await handle?.close().catch(() => undefined);
		await fs.unlink(temporary).catch(() => undefined);
		throw error;
	}
}

async function publishCandidate(target: string, candidate: Uint8Array, candidateHash: string): Promise<void> {
	const directory = path.dirname(target);
	const temporary = path.join(directory, `.gjc-mcp.install.${crypto.randomBytes(12).toString("hex")}`);
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(temporary, "wx", EXECUTABLE_MODE);
		await handle.writeFile(candidate);
		await handle.chmod(EXECUTABLE_MODE);
		await handle.sync();
		await handle.close();
		handle = undefined;
		if ((await hashFile(temporary)) !== candidateHash) throw new Error("candidate verification failed");
		await fsyncDirectory(directory);
		await fs.rename(temporary, target);
		await fsyncDirectory(directory);
	} catch (error) {
		await handle?.close().catch(() => undefined);
		await fs.unlink(temporary).catch(() => undefined);
		throw error;
	}
}

async function runAbsolute(executable: string, args: readonly string[]): Promise<boolean> {
	try {
		const child = Bun.spawn([executable, ...args], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			env: process.env,
		});
		return (await child.exited) === 0;
	} catch {
		return false;
	}
}

export async function verifyUpdaterCandidateBeforePublish(
	candidatePath: string,
	expectedSha256: string,
): Promise<boolean> {
	const uid = process.getuid?.();
	if (uid === undefined) return false;
	const snapshot = await snapshotTarget(candidatePath, uid);
	if (!snapshot.valid || snapshot.hash !== expectedSha256) return false;
	return runAbsolute(candidatePath, ["help"]);
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const object = value as Record<string, unknown>;
		return `{${Object.keys(object)
			.sort()
			.map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
			.join(",")}}`;
	}
	const scalar = JSON.stringify(value);
	if (scalar === undefined) throw new TypeError("non-JSON value");
	return scalar;
}

async function configExistsAndMatches(configPath: string, config: ConfigV1): Promise<boolean> {
	try {
		const stat = await fs.lstat(configPath);
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			stat.uid !== process.getuid?.() ||
			(stat.mode & 0o777) !== PRIVATE_FILE_MODE
		)
			fail("GJC_MCP_E_PATH_OWNERSHIP");
		let existing: unknown;
		try {
			existing = JSON.parse(await fs.readFile(configPath, "utf8")) as unknown;
		} catch {
			fail("GJC_MCP_E_CONFIG_SCHEMA");
		}
		if (!isConfigV1(existing) || canonicalJson(existing) !== canonicalJson(config))
			fail("GJC_MCP_E_APPROVAL_REQUIRED");
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function installConfig(configPath: string, config: ConfigV1, exists: boolean): Promise<void> {
	if (exists) {
		await configExistsAndMatches(configPath, config);
		return;
	}
	await atomicWrite(configPath, `${JSON.stringify(config)}\n`, PRIVATE_FILE_MODE);
}

async function shouldBootstrap(statePath: string): Promise<boolean> {
	try {
		const stat = await fs.lstat(statePath);
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			stat.uid !== process.getuid?.() ||
			(stat.mode & 0o777) !== PRIVATE_FILE_MODE
		)
			fail("GJC_MCP_E_STATE_SCHEMA");
		const parsed = parseStateV1(await fs.readFile(statePath, "utf8"));
		if (!parsed.ok) fail("GJC_MCP_E_STATE_SCHEMA");
		return parsed.value.state === "installing";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		throw error;
	}
}

function hasManagedPathPrecedence(paths: ReturnType<typeof resolveUpdaterPaths>): boolean {
	const entries = (process.env.PATH ?? "")
		.split(path.delimiter)
		.filter(entry => path.isAbsolute(entry))
		.map(entry => path.resolve(entry));
	const managedIndex = entries.indexOf(paths.binRoot);
	const bunIndex = entries.indexOf(path.dirname(paths.bunFallbackPath));
	return managedIndex >= 0 && bunIndex >= 0 && managedIndex < bunIndex;
}

export async function install(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
	const expectedOld = parseArguments(argv);
	const metadata = metadataFromEnvironment();
	const paths = resolveUpdaterPaths();
	if (!hasManagedPathPrecedence(paths)) fail("GJC_MCP_E_PATH_PRECONDITION");
	const uid = process.getuid?.();
	if (uid === undefined) fail("GJC_MCP_E_PATH_OWNERSHIP");
	const candidatePath = path.resolve(import.meta.dir, "..", "dist", "gjc-mcp");
	let candidate: Uint8Array;
	try {
		candidate = await fs.readFile(candidatePath);
	} catch {
		fail("GJC_MCP_E_INSTALL_INCOMPLETE");
	}
	const candidateHash = await hashBytes(candidate);
	const approval = metadata.config.approvedUpdaterSources[metadata.sourceCommit];
	if (approval?.artifactSha256 !== candidateHash) fail("GJC_MCP_E_UPDATER_SOURCE_UNAPPROVED");
	if (!(await verifyUpdaterCandidateBeforePublish(candidatePath, candidateHash))) fail("GJC_MCP_E_VERIFY");
	try {
		await ensureManagedRoots(paths, true);
	} catch {
		fail("GJC_MCP_E_PATH_PRECONDITION");
	}
	const [target, sidecar] = await Promise.all([
		snapshotTarget(paths.updaterPath, uid),
		snapshotSidecar(paths.sidecarPath, uid),
	]);
	const classification = classifyInstallerSnapshot(target, sidecar, candidateHash, paths.updaterPath, expectedOld);
	if (!classification) fail("GJC_MCP_E_PATH_OWNERSHIP");
	if (
		classification === "healthy-equal" &&
		(sidecar.value?.sourceCommit !== metadata.sourceCommit ||
			sidecar.value.updaterPathPolicySha256 !== metadata.policySha256)
	) {
		fail("GJC_MCP_E_PATH_OWNERSHIP");
	}
	if (classification === "healthy-old") {
		const approved = metadata.config.approvedUpdaterSources[metadata.sourceCommit];
		if (
			!approved ||
			approved.artifactSha256 !== candidateHash ||
			approved.updaterPolicySha256 !== metadata.policySha256
		)
			fail("GJC_MCP_E_UPDATER_SOURCE_UNAPPROVED");
	}
	const configExists = await configExistsAndMatches(paths.configPath, metadata.config);
	try {
		if (classification === "fresh" || classification === "healthy-old")
			await publishCandidate(paths.updaterPath, candidate, candidateHash);
		if ((await hashFile(paths.updaterPath)) !== candidateHash) fail("GJC_MCP_E_VERIFY");
		if (classification !== "healthy-equal") {
			const sidecarValue: UpdaterInstallV1 = {
				schema: 1,
				installedPath: paths.updaterPath,
				artifactSha256: candidateHash,
				sourceCommit: metadata.sourceCommit,
				updaterPathPolicySha256: metadata.policySha256,
				ownerUid: uid,
				mode: EXECUTABLE_MODE,
				installedAt: new Date().toISOString(),
			};
			await atomicWrite(paths.sidecarPath, serializeUpdaterInstallV1(sidecarValue), PRIVATE_FILE_MODE);
		}
		const finalTarget = await snapshotTarget(paths.updaterPath, uid);
		const finalSidecar = await snapshotSidecar(paths.sidecarPath, uid);
		if (
			!finalTarget.valid ||
			finalTarget.hash !== candidateHash ||
			!finalSidecar.valid ||
			!finalSidecar.value ||
			!sidecarDescribes(finalSidecar.value, paths.updaterPath, candidateHash)
		)
			fail("GJC_MCP_E_VERIFY");
		await installConfig(paths.configPath, metadata.config, configExists);
		if (await shouldBootstrap(paths.statePath)) {
			const acquired = await acquireLock(paths.lockPath);
			if (!acquired.ok) fail(acquired.code);
			let bootstrapResult: Awaited<ReturnType<typeof bootstrap>>;
			try {
				bootstrapResult = await bootstrap({ paths });
			} finally {
				await acquired.lock.release();
			}
			if (bootstrapResult.code !== "GJC_MCP_OK") fail(bootstrapResult.code);
		}
		return 0;
	} catch {
		fail("GJC_MCP_E_INSTALL_INCOMPLETE");
	}
}

if (import.meta.main) process.exitCode = await install();
