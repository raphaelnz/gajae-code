import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isStableCode, type StableCode } from "./diagnostics";
import {
	applyPinnedPatch,
	classifyPinnedPatchSupport,
	type GitEnvironment,
	materializeWorktree,
	type OfficialCandidate,
	removeWorktree,
	resolveCommitTree,
	resolveOfficialRelease,
	resolvePinnedForkCommit,
	validatePathPolicy,
} from "./git";
import {
	DIRECTORY_MODE,
	EXECUTABLE_MODE,
	ensureManagedRoots,
	PRIVATE_FILE_MODE,
	resolveUpdaterPaths,
	type UpdaterPaths,
} from "./paths";
import {
	type BuildContext,
	buildBaselineFallbackRelease,
	buildCandidateRelease,
	type ReleaseSource,
	verifyPinnedFallbackSource,
	verifyRelease,
	verifyReleaseBinary,
} from "./release";
import {
	type ConfigV1,
	isConfigV1,
	type JournalV1,
	type ManifestV1,
	parseJournalV1,
	parseManifestV1,
	parseStateV1,
	preservesObservedTagHistory,
	RUNTIME_PATCH_PATHS,
	RUNTIME_POLICY_ID,
	type StateV1,
	serializeJournalV1,
	serializeStateV1,
	type TagIdentityV1,
} from "./schema";

export interface CommandResult {
	code: StableCode;
	changed: boolean;
	candidate?: string;
	diagnostics?: StableCode[];
}
export type TransactionPhase = JournalV1["phase"];
export interface TransactionFaults {
	afterPhase?: (phase: TransactionPhase) => void | Promise<void>;
}
export interface PreparedUpdate {
	release: ManifestV1;
	selectedTag: { name: string; identity: TagIdentityV1 };
}
export interface CommandOptions {
	paths?: UpdaterPaths;
	prepareUpdate?: (state: StateV1, current: ManifestV1) => Promise<PreparedUpdate | null>;
	prepareBootstrap?: () => Promise<{
		fallback: ManifestV1;
		candidate: ManifestV1;
		state: StateV1;
		launcherBytes: Uint8Array;
	}>;
	verifyBinary?: (release: ManifestV1) => Promise<boolean>;
	faults?: TransactionFaults;
}

const BASELINE_TAG = {
	name: "v0.9.6",
	identity: { tagObject: null, commit: "aedd0df99e7c9dff420b50f7ff47bd6645627bdd" },
} as const;
class EngineError extends Error {
	constructor(readonly code: StableCode) {
		super(code);
		this.name = "EngineError";
	}
}

interface DefaultEngine {
	paths: UpdaterPaths;
	environment: GitEnvironment;
	patch: { tip: string; base: string; policySha256: string };
	config: ConfigV1;
}

async function readConfig(paths: UpdaterPaths): Promise<ConfigV1> {
	let stat: Awaited<ReturnType<typeof fs.lstat>>;
	try {
		stat = await fs.lstat(paths.configPath);
	} catch (error) {
		throw new EngineError(
			(error as NodeJS.ErrnoException).code === "ENOENT" ? "GJC_MCP_E_CONFIG_MISSING" : "GJC_MCP_E_CONFIG_IO",
		);
	}
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		stat.uid !== process.getuid?.() ||
		(stat.mode & 0o777) !== PRIVATE_FILE_MODE
	)
		throw new EngineError("GJC_MCP_E_PATH_OWNERSHIP");
	let value: unknown;
	try {
		value = JSON.parse(await Bun.file(paths.configPath).text()) as unknown;
	} catch {
		throw new EngineError("GJC_MCP_E_CONFIG_SCHEMA");
	}
	if (!isConfigV1(value)) throw new EngineError("GJC_MCP_E_CONFIG_SCHEMA");
	return value;
}

async function hashFile(file: string): Promise<string> {
	return crypto
		.createHash("sha256")
		.update(new Uint8Array(await Bun.file(file).arrayBuffer()))
		.digest("hex");
}

async function readBunVersion(bunPath: string, expectedSha256: string): Promise<string> {
	const stat = await fs.lstat(bunPath).catch(() => null);
	if (
		!stat?.isFile() ||
		stat.isSymbolicLink() ||
		stat.uid !== process.getuid?.() ||
		(stat.mode & 0o777) !== EXECUTABLE_MODE
	)
		throw new EngineError("GJC_MCP_E_PATH_OWNERSHIP");
	if ((await hashFile(bunPath)) !== expectedSha256) throw new EngineError("GJC_MCP_E_VERIFY");
	const child = Bun.spawn([bunPath, "--version"], {
		env: { HOME: path.dirname(path.dirname(bunPath)), PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "ignore",
	});
	const bytes = new Uint8Array(await new Response(child.stdout).arrayBuffer());
	if ((await child.exited) !== 0 || bytes.byteLength > 64) throw new EngineError("GJC_MCP_E_BUILD");
	const version = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
	if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) throw new EngineError("GJC_MCP_E_BUILD");
	return version;
}

async function defaultEngine(paths: UpdaterPaths): Promise<DefaultEngine> {
	await ensureManagedRoots(paths, false).catch(() => {
		throw new EngineError("GJC_MCP_E_PATH_OWNERSHIP");
	});
	const config = await readConfig(paths);
	const policy = config.runtimePatchPolicies[RUNTIME_POLICY_ID];
	const approvals = Object.entries(config.approvedRuntimePatchTips).filter(
		([, approval]) => approval.runtimePolicySha256 === policy.sha256 && approval.branch === "standalone-mcp-autoload",
	);
	if (approvals.length !== 1) throw new EngineError("GJC_MCP_E_APPROVAL_REQUIRED");
	const [approvedTip, approval] = approvals[0]!;
	if (approval.mergeBase !== BASELINE_TAG.identity.commit) throw new EngineError("GJC_MCP_E_PATCH_UNAPPROVED");
	const environment: GitEnvironment = {
		home: path.join(paths.cacheRoot, "git-home"),
		xdgConfigHome: path.join(paths.cacheRoot, "git-config"),
		sshAuthSock: process.env.SSH_AUTH_SOCK,
		sshKnownHosts: path.join(paths.home, ".ssh", "known_hosts"),
	};
	await fs.mkdir(environment.home, { recursive: true, mode: DIRECTORY_MODE });
	await fs.mkdir(environment.xdgConfigHome, { recursive: true, mode: DIRECTORY_MODE });
	const tip = await resolvePinnedForkCommit(paths.sourceRoot, "standalone-mcp-autoload", approvedTip, environment);
	await validatePathPolicy(paths.sourceRoot, approval.mergeBase, tip, policy.paths, environment);
	return { paths, environment, patch: { tip, base: approval.mergeBase, policySha256: policy.sha256 }, config };
}
async function buildContext(engine: DefaultEngine): Promise<BuildContext> {
	const trust = engine.config.bootstrapArtifacts;
	const bunPath = engine.paths.bunRuntimePath;
	return {
		paths: engine.paths,
		bunPath,
		bunVersion: await readBunVersion(bunPath, trust.bunSha256),
		bunSha256: trust.bunSha256,
		fallbackSha256: trust.fallbackSha256,
		baselineNativeAddonSha256: trust.baselineNativeAddonSha256,
		trustedSource: true,
	};
}

function supportError(support: "partial" | "infrastructure"): EngineError {
	return new EngineError(support === "partial" ? "GJC_MCP_E_OFFICIAL_PARTIAL" : "GJC_MCP_E_PROBE_INFRA");
}

async function resolveCandidate(
	engine: DefaultEngine,
	currentVersion: string,
	observed: Readonly<Record<string, TagIdentityV1>>,
): Promise<OfficialCandidate | null> {
	const resolved = await resolveOfficialRelease(engine.paths.sourceRoot, currentVersion, observed, engine.environment);
	return resolved.selected;
}

async function candidateSupport(engine: DefaultEngine, candidate: OfficialCandidate): Promise<"unsupported" | "full"> {
	let support: "unsupported" | "full" | "partial" | "infrastructure";
	try {
		support = await classifyPinnedPatchSupport(
			engine.paths.sourceRoot,
			candidate.identity.commit,
			engine.patch.base,
			engine.patch.tip,
			RUNTIME_PATCH_PATHS,
			engine.environment,
		);
	} catch {
		support = "infrastructure";
	}
	if (support === "partial" || support === "infrastructure") throw supportError(support);
	return support;
}

async function sourceForCandidate(
	engine: DefaultEngine,
	candidate: OfficialCandidate,
	worktree: string,
): Promise<ReleaseSource> {
	const support = await candidateSupport(engine, candidate);
	await materializeWorktree(engine.paths.sourceRoot, worktree, candidate.identity.commit, engine.environment);
	if (support === "full") {
		return {
			worktree,
			kind: "official",
			version: candidate.version,
			upstreamTag: candidate.name,
			identity: candidate.identity,
			patchBase: null,
			patchTip: null,
			runtimePolicySha256: null,
			tree: await resolveCommitTree(engine.paths.sourceRoot, candidate.identity.commit, engine.environment),
		};
	}
	const tree = await applyPinnedPatch(worktree, engine.patch.base, engine.patch.tip, engine.environment);
	return {
		worktree,
		kind: "patched",
		version: candidate.version,
		upstreamTag: candidate.name,
		identity: candidate.identity,
		patchBase: engine.patch.base,
		patchTip: engine.patch.tip,
		runtimePolicySha256: engine.patch.policySha256,
		tree,
	};
}

async function defaultCheck(paths: UpdaterPaths, state: StateV1, current: ManifestV1): Promise<string | undefined> {
	const engine = await defaultEngine(paths);
	const candidate = await resolveCandidate(engine, current.version, state.observedUpstreamTags);
	if (!candidate) return undefined;
	await candidateSupport(engine, candidate);
	return candidate.version;
}

async function defaultPrepareUpdate(
	paths: UpdaterPaths,
	state: StateV1,
	current: ManifestV1,
): Promise<PreparedUpdate | null> {
	const engine = await defaultEngine(paths);
	const candidate = await resolveCandidate(engine, current.version, state.observedUpstreamTags);
	if (!candidate) return null;
	const worktree = path.join(paths.worktreesRoot, `candidate-${crypto.randomUUID()}`);
	try {
		const source = await sourceForCandidate(engine, candidate, worktree);
		const release = await buildCandidateRelease(await buildContext(engine), source);
		return { release, selectedTag: { name: candidate.name, identity: candidate.identity } };
	} finally {
		await removeWorktree(paths.sourceRoot, worktree, engine.environment);
	}
}

async function defaultPrepareBootstrap(
	paths: UpdaterPaths,
): Promise<{ fallback: ManifestV1; candidate: ManifestV1; state: StateV1; launcherBytes: Uint8Array }> {
	const engine = await defaultEngine(paths);
	const resolved = await resolveOfficialRelease(
		paths.sourceRoot,
		"0.0.0",
		{ [BASELINE_TAG.name]: BASELINE_TAG.identity },
		engine.environment,
	);
	const candidate = resolved.candidates.find(entry => entry.name === BASELINE_TAG.name);
	if (
		!candidate ||
		candidate.identity.tagObject !== BASELINE_TAG.identity.tagObject ||
		candidate.identity.commit !== BASELINE_TAG.identity.commit
	) {
		throw new EngineError("GJC_MCP_E_TAG_RETARGET");
	}
	const worktree = path.join(paths.worktreesRoot, `bootstrap-${crypto.randomUUID()}`);
	const fallbackWorktree = path.join(paths.worktreesRoot, `bootstrap-fallback-${crypto.randomUUID()}`);
	try {
		const context = await buildContext(engine);
		await materializeWorktree(paths.sourceRoot, fallbackWorktree, candidate.identity.commit, engine.environment);
		const fallbackSource: ReleaseSource = {
			worktree: fallbackWorktree,
			kind: "official",
			version: candidate.version,
			upstreamTag: candidate.name,
			identity: candidate.identity,
			patchBase: null,
			patchTip: null,
			runtimePolicySha256: null,
			tree: await resolveCommitTree(paths.sourceRoot, candidate.identity.commit, engine.environment),
		};
		const fallback = await buildBaselineFallbackRelease(context, fallbackSource);
		const source = await sourceForCandidate(engine, candidate, worktree);
		const release = await buildCandidateRelease(context, source);
		const launcherBytes = new Uint8Array(await Bun.file(paths.updaterPath).arrayBuffer());
		const state: StateV1 = {
			schema: 1,
			state: "installing",
			activeRelease: null,
			previousRelease: null,
			observedUpstreamTags: {},
			originalBun: {
				path: paths.bunFallbackPath,
				version: "0.9.6",
				sha256: engine.config.bootstrapArtifacts.fallbackSha256,
			},
			launcherSha256: null,
			lastRun: null,
		};
		return { fallback, candidate: release, state, launcherBytes };
	} finally {
		await removeWorktree(paths.sourceRoot, worktree, engine.environment);
		await removeWorktree(paths.sourceRoot, fallbackWorktree, engine.environment);
	}
}

function binaryVerifier(paths: UpdaterPaths, options: CommandOptions): (release: ManifestV1) => Promise<boolean> {
	return options.verifyBinary ?? (release => verifyReleaseBinary(paths, release));
}

async function atomicWrite(file: string, content: string | Uint8Array, mode = PRIVATE_FILE_MODE): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true, mode: DIRECTORY_MODE });
	const temporary = `${file}.tmp-${crypto.randomUUID()}`;
	const handle = await fs.open(temporary, "wx", mode);
	try {
		await handle.writeFile(content);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await fs.rename(temporary, file);
	const parent = await fs.open(path.dirname(file), "r");
	try {
		await parent.sync();
	} finally {
		await parent.close();
	}
}

async function atomicPointer(file: string, paths: UpdaterPaths, release: string): Promise<void> {
	if (!/^[0-9a-f]{64}$/.test(release)) throw new Error("invalid release id");
	const target = path.join("releases", release);
	const temporary = `${file}.tmp-${crypto.randomUUID()}`;
	await fs.symlink(target, temporary);
	await fs.rename(temporary, file);
	const parent = await fs.open(path.dirname(file), "r");
	try {
		await parent.sync();
	} finally {
		await parent.close();
	}
	await readPointer(file, paths);
}

async function readPointer(file: string, paths: UpdaterPaths): Promise<string | null> {
	let target: string;
	try {
		target = await fs.readlink(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	if (!/^releases\/[0-9a-f]{64}$/.test(target)) throw new Error("invalid pointer");
	const resolved = path.resolve(path.dirname(file), target);
	if (path.dirname(resolved) !== paths.releasesRoot) throw new Error("pointer escape");
	return path.basename(resolved);
}

async function syncParent(file: string): Promise<void> {
	const parent = await fs.open(path.dirname(file), "r");
	try {
		await parent.sync();
	} finally {
		await parent.close();
	}
}

async function removeManagedPath(file: string): Promise<void> {
	await fs.rm(file, { force: true });
	await syncParent(file);
}

async function readOptionalState(paths: UpdaterPaths): Promise<StateV1 | null> {
	try {
		return await readState(paths);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

async function restoreSnapshot(
	paths: UpdaterPaths,
	journal: JournalV1,
	oldState: StateV1 | null,
	verifyBinary: (release: ManifestV1) => Promise<boolean>,
): Promise<void> {
	if (
		journal.oldCurrent &&
		journal.oldPrevious &&
		oldState?.state !== "installing" &&
		oldState?.launcherSha256 !== journal.launcherExpectedSha256
	) {
		throw new EngineError("GJC_MCP_E_RESTORE_FAILED");
	}
	if (journal.oldCurrent) {
		const oldCurrent = await verifyRelease(paths, journal.oldCurrent);
		if (!(await verifyBinary(oldCurrent))) throw new EngineError("GJC_MCP_E_RESTORE_FAILED");
	}
	if (journal.oldPrevious) await verifyRelease(paths, journal.oldPrevious);

	if (journal.oldPrevious) await atomicPointer(paths.previousPath, paths, journal.oldPrevious);
	else await removeManagedPath(paths.previousPath);
	if (journal.oldCurrent) await atomicPointer(paths.currentPath, paths, journal.oldCurrent);
	else await removeManagedPath(paths.currentPath);

	if (oldState) await atomicWrite(paths.statePath, serializeStateV1(oldState));
	else await removeManagedPath(paths.statePath);
	if (journal.operation === "bootstrap") await removeManagedPath(paths.launcherPath);

	if (journal.oldCurrent && journal.oldPrevious && oldState?.state !== "installing") {
		const restored = await validateInstalledSnapshot(paths);
		if (restored.currentId !== journal.oldCurrent || restored.previousId !== journal.oldPrevious) {
			throw new EngineError("GJC_MCP_E_RESTORE_FAILED");
		}
	} else {
		if (
			(await readPointer(paths.currentPath, paths)) !== journal.oldCurrent ||
			(await readPointer(paths.previousPath, paths)) !== journal.oldPrevious
		) {
			throw new EngineError("GJC_MCP_E_RESTORE_FAILED");
		}
		const restoredState = await readOptionalState(paths);
		if (
			(oldState === null) !== (restoredState === null) ||
			(oldState && restoredState && serializeStateV1(oldState) !== serializeStateV1(restoredState))
		) {
			throw new EngineError("GJC_MCP_E_RESTORE_FAILED");
		}
	}
	await removeManagedPath(paths.journalPath);
}

async function readState(paths: UpdaterPaths): Promise<StateV1> {
	const parsed = parseStateV1(await Bun.file(paths.statePath).text());
	if (!parsed.ok) throw new Error("invalid state");
	return parsed.value;
}
async function readManifest(paths: UpdaterPaths, id: string): Promise<ManifestV1> {
	const parsed = parseManifestV1(await Bun.file(path.join(paths.releasesRoot, id, "manifest.json")).text());
	if (!parsed.ok || parsed.value.releaseId !== id) throw new Error("invalid manifest");
	return parsed.value;
}
async function phase(journal: JournalV1, next: TransactionPhase, options: CommandOptions): Promise<JournalV1> {
	const changed = { ...journal, phase: next };
	await atomicWrite((options.paths ?? resolveUpdaterPaths()).journalPath, serializeJournalV1(changed));
	await options.faults?.afterPhase?.(next);
	return changed;
}

async function perform(journal: JournalV1, nextState: StateV1, options: CommandOptions): Promise<void> {
	const paths = options.paths ?? resolveUpdaterPaths();
	const verifyBinary = binaryVerifier(paths, options);
	const oldState = await readOptionalState(paths);
	if (oldState && !preservesObservedTagHistory(oldState, nextState)) throw new Error("tag history changed");

	const newManifest = await readManifest(paths, journal.newCurrent);
	if (!(await verifyBinary(newManifest))) throw new Error("prepublish verify failed");
	let launcher: Uint8Array | undefined;
	if (journal.operation === "bootstrap") {
		launcher = (await options.prepareBootstrap?.())?.launcherBytes;
		if (!launcher || crypto.createHash("sha256").update(launcher).digest("hex") !== journal.launcherExpectedSha256) {
			throw new Error("launcher mismatch");
		}
	}

	let record = journal;
	await atomicWrite(paths.journalPath, serializeJournalV1(record));
	await options.faults?.afterPhase?.("prepared");
	try {
		await atomicPointer(paths.previousPath, paths, record.newPrevious);
		record = await phase(record, "previous-written", options);
		await atomicPointer(paths.currentPath, paths, record.newCurrent);
		record = await phase(record, "current-written", options);
		if (record.operation === "bootstrap") {
			if (!(await verifyBinary(newManifest))) throw new Error("prelaunch verify failed");
			record = await phase(record, "prelaunch-verified", options);
			await atomicWrite(paths.launcherPath, launcher!, EXECUTABLE_MODE);
			record = await phase(record, "launcher-written", options);
		}
		if (!(await verifyBinary(newManifest))) throw new Error("post verify failed");
		record = await phase(record, "post-verified", options);
		await atomicWrite(paths.statePath, serializeStateV1(nextState));
		record = await phase(record, "state-written", options);
		await removeManagedPath(paths.journalPath);
	} catch (error) {
		if (options.faults) throw error;
		const durableJournal = await pending(paths).catch(() => null);
		if (durableJournal?.phase === "state-written") throw error;
		try {
			await restoreSnapshot(paths, journal, oldState, verifyBinary);
		} catch {
			throw new EngineError("GJC_MCP_E_RESTORE_FAILED");
		}
		throw error;
	}
}

async function pending(paths: UpdaterPaths): Promise<JournalV1 | null> {
	try {
		const parsed = parseJournalV1(await Bun.file(paths.journalPath).text());
		if (!parsed.ok) throw new Error("invalid journal");
		return parsed.value;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

async function restoreInterrupted(
	paths: UpdaterPaths,
	journal: JournalV1,
	options: CommandOptions,
): Promise<"committed" | "rolled-back"> {
	const verifyBinary = binaryVerifier(paths, options);
	const state = await readOptionalState(paths);
	const stateCommitsNewRelease =
		state?.activeRelease === journal.newCurrent &&
		state.previousRelease === journal.newPrevious &&
		state.state !== "installing";

	if (stateCommitsNewRelease && state) {
		if (state.launcherSha256 !== journal.launcherExpectedSha256) {
			throw new EngineError("GJC_MCP_E_RESTORE_FAILED");
		}
		await atomicPointer(paths.previousPath, paths, journal.newPrevious);
		await atomicPointer(paths.currentPath, paths, journal.newCurrent);
		const restored = await validateInstalledSnapshot(paths).catch(() => {
			throw new EngineError("GJC_MCP_E_RESTORE_FAILED");
		});
		if (
			restored.currentId !== journal.newCurrent ||
			restored.previousId !== journal.newPrevious ||
			!(await verifyBinary(restored.current))
		) {
			throw new EngineError("GJC_MCP_E_RESTORE_FAILED");
		}
		await removeManagedPath(paths.journalPath);
		return "committed";
	}

	if (
		state &&
		!(
			state.state === "installing" ||
			(state.activeRelease === journal.oldCurrent && state.previousRelease === journal.oldPrevious)
		)
	) {
		throw new EngineError("GJC_MCP_E_RESTORE_FAILED");
	}
	try {
		await restoreSnapshot(paths, journal, state, verifyBinary);
	} catch {
		throw new EngineError("GJC_MCP_E_RESTORE_FAILED");
	}
	return "rolled-back";
}

function codeFor(error: unknown): StableCode {
	if (typeof error === "object" && error !== null && "code" in error && isStableCode(error.code)) return error.code;
	return "GJC_MCP_E_VERIFY";
}

export interface InstalledSnapshot {
	state: StateV1;
	currentId: string;
	previousId: string;
	current: ManifestV1;
	previous: ManifestV1;
}

export async function validateInstalledSnapshot(paths: UpdaterPaths): Promise<InstalledSnapshot> {
	const currentId = await readPointer(paths.currentPath, paths);
	if (!currentId) throw new EngineError("GJC_MCP_E_CURRENT_MISSING");
	const previousId = await readPointer(paths.previousPath, paths);
	if (!previousId) throw new EngineError("GJC_MCP_E_PREVIOUS_MISSING");
	if (previousId === currentId) throw new EngineError("GJC_MCP_E_PREVIOUS_EQUAL");
	const state = await readState(paths);
	if (state.originalBun.path !== paths.bunFallbackPath) {
		throw new EngineError("GJC_MCP_E_STATE_MISMATCH");
	}
	await verifyPinnedFallbackSource(paths, state.originalBun.sha256);
	if (
		state.state === "installing" ||
		state.activeRelease !== currentId ||
		state.previousRelease !== previousId ||
		!state.launcherSha256
	) {
		throw new EngineError("GJC_MCP_E_STATE_MISMATCH");
	}
	const launcherStat = await fs.lstat(paths.launcherPath).catch(() => null);
	if (
		!launcherStat?.isFile() ||
		launcherStat.isSymbolicLink() ||
		launcherStat.uid !== process.getuid?.() ||
		(launcherStat.mode & 0o777) !== EXECUTABLE_MODE ||
		(await hashFile(paths.launcherPath)) !== state.launcherSha256
	) {
		throw new EngineError("GJC_MCP_E_STATE_MISMATCH");
	}
	const current = await verifyRelease(paths, currentId);
	const previous = await verifyRelease(paths, previousId);
	return { state, currentId, previousId, current, previous };
}

async function readInstalledSnapshot(paths: UpdaterPaths, options: CommandOptions): Promise<InstalledSnapshot> {
	const snapshot = await validateInstalledSnapshot(paths);
	if ((!options.prepareUpdate || options.verifyBinary) && !(await binaryVerifier(paths, options)(snapshot.current))) {
		throw new EngineError("GJC_MCP_E_VERIFY");
	}
	return snapshot;
}

export async function status(options: CommandOptions = {}): Promise<CommandResult> {
	const paths = options.paths ?? resolveUpdaterPaths();
	const diagnostics: StableCode[] = [];
	try {
		if (await pending(paths)) diagnostics.push("GJC_MCP_E_RECOVERY_REQUIRED");
	} catch {
		diagnostics.push("GJC_MCP_E_RECOVERY_REQUIRED");
	}
	let current: string | null = null;
	try {
		current = await readPointer(paths.currentPath, paths);
		if (!current) diagnostics.push("GJC_MCP_E_CURRENT_MISSING");
		else await verifyRelease(paths, current);
	} catch {
		diagnostics.push("GJC_MCP_E_CURRENT_ESCAPE");
	}
	try {
		const state = await readState(paths);
		if (current && state.activeRelease !== current) diagnostics.push("GJC_MCP_E_STATE_MISMATCH");
	} catch {
		diagnostics.push("GJC_MCP_E_STATE_SCHEMA");
	}
	try {
		const previous = await readPointer(paths.previousPath, paths);
		if (!previous) diagnostics.push("GJC_MCP_E_PREVIOUS_MISSING");
		else if (previous === current) diagnostics.push("GJC_MCP_E_PREVIOUS_EQUAL");
		else await verifyRelease(paths, previous);
	} catch {
		diagnostics.push("GJC_MCP_E_PREVIOUS_CORRUPT");
	}
	return { code: diagnostics[0] ?? "GJC_MCP_OK", changed: false, diagnostics };
}

export async function check(options: CommandOptions = {}): Promise<CommandResult> {
	const paths = options.paths ?? resolveUpdaterPaths();
	try {
		let recovered = false;
		const interrupted = await pending(paths);
		if (interrupted) {
			await restoreInterrupted(paths, interrupted, options);
			recovered = true;
		}
		const snapshot = await readInstalledSnapshot(paths, options);
		if (options.prepareUpdate) {
			const prepared = await options.prepareUpdate(snapshot.state, snapshot.current);
			return { code: "GJC_MCP_OK", changed: recovered, candidate: prepared?.release.version };
		}
		return {
			code: "GJC_MCP_OK",
			changed: recovered,
			candidate: await defaultCheck(paths, snapshot.state, snapshot.current),
		};
	} catch (error) {
		return { code: codeFor(error), changed: false };
	}
}

export async function update(options: CommandOptions = {}): Promise<CommandResult> {
	const paths = options.paths ?? resolveUpdaterPaths();
	try {
		let recovered = false;
		const interrupted = await pending(paths);
		if (interrupted) {
			const outcome = await restoreInterrupted(paths, interrupted, options);
			recovered = true;
			if (outcome === "committed" && interrupted.operation === "update") {
				return { code: "GJC_MCP_OK", changed: true };
			}
		}
		const snapshot = await readInstalledSnapshot(paths, options);
		const prepared = options.prepareUpdate
			? await options.prepareUpdate(snapshot.state, snapshot.current)
			: await defaultPrepareUpdate(paths, snapshot.state, snapshot.current);
		if (!prepared) return { code: "GJC_MCP_OK", changed: recovered };
		await verifyRelease(paths, prepared.release.releaseId);
		const runId = crypto.randomUUID();
		const nextState: StateV1 = {
			...snapshot.state,
			state: prepared.release.kind === "official" ? "official-managed" : "patched-managed",
			activeRelease: prepared.release.releaseId,
			previousRelease: snapshot.currentId,
			observedUpstreamTags: {
				...snapshot.state.observedUpstreamTags,
				[prepared.selectedTag.name]: prepared.selectedTag.identity,
			},
			lastRun: { runId, command: "update", code: "GJC_MCP_OK", at: new Date().toISOString() },
		};
		const journal: JournalV1 = {
			schema: 1,
			runId,
			operation: "update",
			phase: "prepared",
			oldCurrent: snapshot.currentId,
			oldPrevious: snapshot.previousId,
			newCurrent: prepared.release.releaseId,
			newPrevious: snapshot.currentId,
			selectedTag: prepared.selectedTag,
			launcherExpectedSha256: snapshot.state.launcherSha256!,
			startedAt: new Date().toISOString(),
		};
		await perform(journal, nextState, options);
		return { code: "GJC_MCP_OK", changed: true, candidate: prepared.release.version };
	} catch (error) {
		return { code: codeFor(error), changed: false };
	}
}

export async function rollback(options: CommandOptions = {}): Promise<CommandResult> {
	const paths = options.paths ?? resolveUpdaterPaths();
	try {
		const interrupted = await pending(paths);
		if (interrupted) {
			const outcome = await restoreInterrupted(paths, interrupted, options);
			if (outcome === "committed" && interrupted.operation === "rollback") {
				return { code: "GJC_MCP_OK", changed: true };
			}
		}
		const snapshot = await readInstalledSnapshot(paths, options);
		const runId = crypto.randomUUID();
		const nextState: StateV1 = {
			...snapshot.state,
			state: snapshot.previous.kind === "official" ? "official-managed" : "patched-managed",
			activeRelease: snapshot.previousId,
			previousRelease: snapshot.currentId,
			lastRun: { runId, command: "rollback", code: "GJC_MCP_OK", at: new Date().toISOString() },
		};
		const journal: JournalV1 = {
			schema: 1,
			runId,
			operation: "rollback",
			phase: "prepared",
			oldCurrent: snapshot.currentId,
			oldPrevious: snapshot.previousId,
			newCurrent: snapshot.previousId,
			newPrevious: snapshot.currentId,
			selectedTag: null,
			launcherExpectedSha256: snapshot.state.launcherSha256!,
			startedAt: new Date().toISOString(),
		};
		await perform(journal, nextState, options);
		return { code: "GJC_MCP_OK", changed: true };
	} catch (error) {
		return { code: codeFor(error), changed: false };
	}
}

export async function bootstrap(options: CommandOptions = {}): Promise<CommandResult> {
	const paths = options.paths ?? resolveUpdaterPaths();
	try {
		const interrupted = await pending(paths);
		if (interrupted) {
			const outcome = await restoreInterrupted(paths, interrupted, options);
			if (outcome === "committed" && interrupted.operation === "bootstrap") {
				return { code: "GJC_MCP_OK", changed: true };
			}
		}
		if ((await readPointer(paths.currentPath, paths)) !== null)
			return { code: "GJC_MCP_E_STATE_MISMATCH", changed: false };
		const bootstrapState = await readOptionalState(paths);
		if (bootstrapState && bootstrapState.state !== "installing")
			return { code: "GJC_MCP_E_STATE_MISMATCH", changed: false };
		const launcherExists = await fs.lstat(paths.launcherPath).then(
			() => true,
			error => {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
				throw error;
			},
		);
		if (launcherExists) return { code: "GJC_MCP_E_STATE_MISMATCH", changed: false };
		const prepareBootstrap = options.prepareBootstrap ?? (() => defaultPrepareBootstrap(paths));
		const prepared = await prepareBootstrap();
		await verifyRelease(paths, prepared.fallback.releaseId);
		await verifyRelease(paths, prepared.candidate.releaseId);
		const runId = crypto.randomUUID();
		const launcherHash = crypto.createHash("sha256").update(prepared.launcherBytes).digest("hex");
		const selectedTag = {
			name: prepared.candidate.upstreamTag,
			identity: { tagObject: prepared.candidate.tagObject, commit: prepared.candidate.upstreamCommit },
		};
		const state: StateV1 = {
			...prepared.state,
			state: prepared.candidate.kind === "official" ? "official-managed" : "patched-managed",
			activeRelease: prepared.candidate.releaseId,
			previousRelease: prepared.fallback.releaseId,
			launcherSha256: launcherHash,
			observedUpstreamTags: {
				...prepared.state.observedUpstreamTags,
				[BASELINE_TAG.name]: BASELINE_TAG.identity,
				[selectedTag.name]: selectedTag.identity,
			},
			lastRun: { runId, command: "install", code: "GJC_MCP_OK", at: new Date().toISOString() },
		};
		const journal: JournalV1 = {
			schema: 1,
			runId,
			operation: "bootstrap",
			phase: "prepared",
			oldCurrent: null,
			oldPrevious: null,
			newCurrent: prepared.candidate.releaseId,
			newPrevious: prepared.fallback.releaseId,
			selectedTag,
			launcherExpectedSha256: launcherHash,
			startedAt: new Date().toISOString(),
		};
		await perform(journal, state, {
			...options,
			prepareBootstrap: async () => prepared,
			verifyBinary: binaryVerifier(paths, options),
		});
		return { code: "GJC_MCP_OK", changed: true, candidate: prepared.candidate.version };
	} catch (error) {
		return { code: codeFor(error), changed: false };
	}
}
