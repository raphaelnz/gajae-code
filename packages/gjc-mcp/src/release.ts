import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DIRECTORY_MODE, EXECUTABLE_MODE, PRIVATE_FILE_MODE, type UpdaterPaths } from "./paths";
import { verifyCandidateBinary } from "./probe";
import { BUILD_COMMAND_ID, isManifestV1, type ManifestV1, serializeManifestV1, type TagIdentityV1 } from "./schema";

export class ReleaseError extends Error {
	constructor(readonly code: "GJC_MCP_E_BUILD" | "GJC_MCP_E_VERIFY" | "GJC_MCP_E_PATH_OWNERSHIP") {
		super(code);
		this.name = "ReleaseError";
	}
}

export interface ReleaseSource {
	worktree: string;
	kind: "official" | "patched";
	version: string;
	upstreamTag: string;
	identity: TagIdentityV1;
	patchBase: string | null;
	patchTip: string | null;
	runtimePolicySha256: string | null;
	tree: string;
}
export interface BuildContext {
	paths: UpdaterPaths;
	bunPath: string;
	bunVersion: string;
	/** Approved SHA-256 of the exact Bun executable used for builds. */
	bunSha256: string;
	/** Approved SHA-256 of the resolved v0.9.6 fallback entry point. */
	fallbackSha256: string;
	/** Approved SHA-256 of the platform-specific v0.9.6 native addon. */
	baselineNativeAddonSha256: string;
	trustedSource: boolean;
}

const BASELINE_TREE = "25df3453b59976ac793350ebe9dce51edd9b26cc";

const RUNTIME_CONTRACT_TESTS = [
	"packages/coding-agent/test/sdk-mcp-discovery.test.ts",
	"packages/coding-agent/test/standalone-mcp-mode-isolation.test.ts",
	"packages/coding-agent/test/standalone-mcp-auth-e2e.test.ts",
	"packages/coding-agent/test/mcp-lifecycle-cleanup.test.ts",
	"packages/coding-agent/test/gjc-plugin-mcp-session.test.ts",
	"packages/coding-agent/test/acp-mcp-isolation.test.ts",
	"packages/coding-agent/test/sdk-session-isolation.test.ts",
] as const;

function sha256(bytes: Uint8Array): string {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}
async function hashFile(file: string): Promise<string> {
	return sha256(new Uint8Array(await Bun.file(file).arrayBuffer()));
}
function isWithin(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function requireOwnedDirectory(directory: string, mode?: number): Promise<string> {
	const resolved = await fs.realpath(directory).catch(() => null);
	if (!resolved || resolved !== path.resolve(directory)) throw new ReleaseError("GJC_MCP_E_PATH_OWNERSHIP");
	const stat = await fs.lstat(directory).catch(() => null);
	if (
		!stat?.isDirectory() ||
		stat.isSymbolicLink() ||
		stat.uid !== process.getuid?.() ||
		(mode !== undefined && (stat.mode & 0o777) !== mode)
	)
		throw new ReleaseError("GJC_MCP_E_PATH_OWNERSHIP");
	return resolved;
}

async function requireCanonicalFile(
	file: string,
	expectedSha256: string,
	options: { root?: string; allowSymlink?: boolean; mode?: number } = {},
): Promise<string> {
	if (!/^[0-9a-f]{64}$/.test(expectedSha256) || !path.isAbsolute(file)) throw new ReleaseError("GJC_MCP_E_VERIFY");
	const linkStat = await fs.lstat(file).catch(() => null);
	if (!linkStat || linkStat.uid !== process.getuid?.() || (!options.allowSymlink && linkStat.isSymbolicLink()))
		throw new ReleaseError("GJC_MCP_E_PATH_OWNERSHIP");
	const resolved = await fs.realpath(file).catch(() => null);
	if (!resolved || (!options.allowSymlink && resolved !== path.resolve(file)))
		throw new ReleaseError("GJC_MCP_E_PATH_OWNERSHIP");
	if (options.root) {
		const root = await fs.realpath(options.root).catch(() => null);
		const rootStat = await fs.lstat(options.root).catch(() => null);
		if (
			!root ||
			root !== path.resolve(options.root) ||
			!rootStat?.isDirectory() ||
			rootStat.isSymbolicLink() ||
			rootStat.uid !== process.getuid?.() ||
			!isWithin(root, resolved)
		)
			throw new ReleaseError("GJC_MCP_E_PATH_OWNERSHIP");
	}
	const stat = await fs.lstat(resolved).catch(() => null);
	if (
		!stat?.isFile() ||
		stat.isSymbolicLink() ||
		stat.uid !== process.getuid?.() ||
		(stat.mode & 0o777) !== (options.mode ?? EXECUTABLE_MODE)
	)
		throw new ReleaseError("GJC_MCP_E_PATH_OWNERSHIP");
	if ((await hashFile(resolved)) !== expectedSha256) throw new ReleaseError("GJC_MCP_E_VERIFY");
	return resolved;
}

async function requireManagedReleaseRoot(paths: UpdaterPaths, create: boolean): Promise<string> {
	if (!path.isAbsolute(paths.dataRoot) || !path.isAbsolute(paths.releasesRoot))
		throw new ReleaseError("GJC_MCP_E_PATH_OWNERSHIP");
	if (!isWithin(path.resolve(paths.dataRoot), path.resolve(paths.releasesRoot)))
		throw new ReleaseError("GJC_MCP_E_PATH_OWNERSHIP");
	if (create) {
		await fs.mkdir(paths.dataRoot, { recursive: true, mode: DIRECTORY_MODE });
		await requireOwnedDirectory(paths.dataRoot, DIRECTORY_MODE);
		await fs.mkdir(paths.releasesRoot, { recursive: true, mode: DIRECTORY_MODE });
	}
	const dataRoot = await requireOwnedDirectory(paths.dataRoot, DIRECTORY_MODE);
	const releasesRoot = await requireOwnedDirectory(paths.releasesRoot, DIRECTORY_MODE);
	if (!isWithin(dataRoot, releasesRoot)) throw new ReleaseError("GJC_MCP_E_PATH_OWNERSHIP");
	return releasesRoot;
}

async function requireTrustedBun(context: BuildContext): Promise<string> {
	return requireCanonicalFile(context.bunPath, context.bunSha256, {
		root: context.paths.home,
		mode: EXECUTABLE_MODE,
	});
}
async function requireTrustedBuildBin(context: BuildContext, bun: string, home: string): Promise<string> {
	await requireOwnedDirectory(home, DIRECTORY_MODE);
	const directory = path.join(home, ".trusted-bin");
	await fs.mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
	await requireOwnedDirectory(directory, DIRECTORY_MODE);
	const stagedBun = path.join(directory, "bun");
	const stat = await fs.lstat(stagedBun).catch(() => null);
	if (!stat) {
		await fs.copyFile(bun, stagedBun);
		await fs.chmod(stagedBun, EXECUTABLE_MODE);
	}
	await requireCanonicalFile(stagedBun, context.bunSha256, {
		root: directory,
		mode: EXECUTABLE_MODE,
	});
	return directory;
}

async function runBuild(context: BuildContext, command: readonly string[], cwd: string, home: string): Promise<void> {
	const bun = await requireTrustedBun(context);
	const trustedBin = await requireTrustedBuildBin(context, bun, home);
	const child = Bun.spawn([bun, ...command], {
		cwd,
		env: {
			HOME: home,
			XDG_CONFIG_HOME: path.join(home, "config"),
			XDG_DATA_HOME: path.join(home, "data"),
			XDG_STATE_HOME: path.join(home, "state"),
			XDG_CACHE_HOME: path.join(home, "cache"),
			PATH: `${trustedBin}:/usr/bin:/bin`,
			LANG: "C",
			LC_ALL: "C",
			CI: "1",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0",
			BUN_CONFIG_NO_INSTALL: "1",
		},
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	if ((await child.exited) !== 0) throw new ReleaseError("GJC_MCP_E_BUILD");
}

export async function seedBaselineNativeAddon(context: BuildContext, source: ReleaseSource): Promise<void> {
	if (source.version !== "0.9.6") return;
	const platform =
		process.platform === "darwin"
			? "darwin"
			: process.platform === "linux"
				? "linux"
				: process.platform === "win32"
					? "win32"
					: null;
	const architecture = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
	if (!platform || !architecture) throw new ReleaseError("GJC_MCP_E_BUILD");
	const packageRoot = path.join(
		context.paths.home,
		".bun",
		"install",
		"global",
		"node_modules",
		"@gajae-code",
		`natives-${platform}-${architecture}`,
	);
	let packageVersion: unknown;
	try {
		packageVersion = (await Bun.file(path.join(packageRoot, "package.json")).json()).version;
	} catch {
		throw new ReleaseError("GJC_MCP_E_BUILD");
	}
	if (packageVersion !== source.version) throw new ReleaseError("GJC_MCP_E_BUILD");
	const fileName = `pi_natives.${platform}-${architecture}.node`;
	const installedAddonPath = path.join(packageRoot, "native", fileName);
	const installedAddon = await requireCanonicalFile(installedAddonPath, context.baselineNativeAddonSha256, {
		root: context.paths.home,
		mode: 0o644,
	});
	const target = path.join(source.worktree, "packages", "natives", "native", fileName);
	await fs.copyFile(installedAddon, target);
	await fs.chmod(target, PRIVATE_FILE_MODE);
}

async function atomicWrite(file: string, bytes: string | Uint8Array, mode: number): Promise<void> {
	const temporary = `${file}.tmp-${crypto.randomUUID()}`;
	const handle = await fs.open(temporary, "wx", mode);
	try {
		await handle.writeFile(bytes);
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

function releaseId(manifest: ManifestV1): string {
	return sha256(new TextEncoder().encode(JSON.stringify({ ...manifest, releaseId: "0".repeat(64) })));
}

async function publish(
	paths: UpdaterPaths,
	binary: string,
	manifestInput: Omit<ManifestV1, "releaseId" | "artifact">,
): Promise<ManifestV1> {
	await requireManagedReleaseRoot(paths, false);
	const binaryStat = await fs.lstat(binary).catch(() => null);
	if (
		!binaryStat?.isFile() ||
		binaryStat.isSymbolicLink() ||
		binaryStat.uid !== process.getuid?.() ||
		(binaryStat.mode & 0o777) !== EXECUTABLE_MODE
	)
		throw new ReleaseError("GJC_MCP_E_PATH_OWNERSHIP");
	const bytes = new Uint8Array(await Bun.file(binary).arrayBuffer());
	const manifest: ManifestV1 = {
		...manifestInput,
		releaseId: "0".repeat(64),
		artifact: { path: "bin/gjc", sha256: sha256(bytes), size: bytes.byteLength, mode: EXECUTABLE_MODE },
	};
	manifest.releaseId = releaseId(manifest);
	if (!isManifestV1(manifest)) throw new ReleaseError("GJC_MCP_E_VERIFY");
	const destination = path.join(await requireManagedReleaseRoot(paths, false), manifest.releaseId);
	const existing = await fs.lstat(destination).catch(() => null);
	if (!existing) {
		const staging = path.join(paths.releasesRoot, `.tmp-${crypto.randomUUID()}`);
		await fs.mkdir(path.join(staging, "bin"), { recursive: true, mode: DIRECTORY_MODE });
		await atomicWrite(path.join(staging, "bin", "gjc"), bytes, EXECUTABLE_MODE);
		await atomicWrite(path.join(staging, "manifest.json"), serializeManifestV1(manifest), PRIVATE_FILE_MODE);
		await fs.rename(staging, destination);
	}
	await verifyRelease(paths, manifest.releaseId);
	return manifest;
}

export async function verifyRelease(paths: UpdaterPaths, id: string): Promise<ManifestV1> {
	if (!/^[0-9a-f]{64}$/.test(id)) throw new ReleaseError("GJC_MCP_E_VERIFY");
	const root = path.join(paths.releasesRoot, id);
	const releasesRoot = await requireManagedReleaseRoot(paths, false);
	if (path.resolve(root) !== path.join(releasesRoot, id)) throw new ReleaseError("GJC_MCP_E_PATH_OWNERSHIP");
	const rootStat = await fs.lstat(root).catch(() => null);
	if (
		!rootStat?.isDirectory() ||
		rootStat.isSymbolicLink() ||
		rootStat.uid !== process.getuid?.() ||
		(rootStat.mode & 0o777) !== DIRECTORY_MODE
	)
		throw new ReleaseError("GJC_MCP_E_PATH_OWNERSHIP");
	await requireOwnedDirectory(path.join(root, "bin"), DIRECTORY_MODE);
	const manifestStat = await fs.lstat(path.join(root, "manifest.json")).catch(() => null);
	if (
		!manifestStat?.isFile() ||
		manifestStat.isSymbolicLink() ||
		manifestStat.uid !== process.getuid?.() ||
		(manifestStat.mode & 0o777) !== PRIVATE_FILE_MODE
	)
		throw new ReleaseError("GJC_MCP_E_PATH_OWNERSHIP");
	let value: unknown;
	try {
		value = JSON.parse(await Bun.file(path.join(root, "manifest.json")).text());
	} catch {
		throw new ReleaseError("GJC_MCP_E_VERIFY");
	}
	if (!isManifestV1(value) || value.releaseId !== id || releaseId(value) !== id)
		throw new ReleaseError("GJC_MCP_E_VERIFY");
	const binary = path.resolve(root, value.artifact.path);
	if (!isWithin(root, binary) || binary !== path.join(root, "bin", "gjc"))
		throw new ReleaseError("GJC_MCP_E_PATH_OWNERSHIP");
	const stat = await fs.lstat(binary).catch(() => null);
	if (
		!stat?.isFile() ||
		stat.isSymbolicLink() ||
		stat.uid !== process.getuid?.() ||
		(stat.mode & 0o777) !== EXECUTABLE_MODE ||
		stat.size !== value.artifact.size ||
		(await hashFile(binary)) !== value.artifact.sha256
	)
		throw new ReleaseError("GJC_MCP_E_VERIFY");
	return value;
}
export async function verifyReleaseBinary(paths: UpdaterPaths, release: ManifestV1): Promise<boolean> {
	try {
		const verified = await verifyRelease(paths, release.releaseId);
		if (verified.releaseId !== release.releaseId) return false;
		return await verifyCandidateBinary({
			binary: path.join(paths.releasesRoot, release.releaseId, release.artifact.path),
			expectedVersion: release.version,
			expectedSha256: verified.artifact.sha256,
			home: paths.cacheRoot,
			trusted: true,
		});
	} catch {
		return false;
	}
}

export async function buildCandidateRelease(context: BuildContext, source: ReleaseSource): Promise<ManifestV1> {
	if (!context.trustedSource || !path.isAbsolute(source.worktree)) throw new ReleaseError("GJC_MCP_E_VERIFY");
	await requireManagedReleaseRoot(context.paths, true);
	const home = path.join(context.paths.worktreesRoot, `.build-home-${crypto.randomUUID()}`);
	await fs.mkdir(home, { recursive: true, mode: DIRECTORY_MODE });
	try {
		await runBuild(context, ["install", "--frozen-lockfile"], source.worktree, home);
		await seedBaselineNativeAddon(context, source);
		await runBuild(context, ["--cwd=packages/coding-agent", "run", "check:types"], source.worktree, home);
		await runBuild(context, ["test", ...RUNTIME_CONTRACT_TESTS], source.worktree, home);
		await runBuild(context, ["--cwd=packages/coding-agent", "run", "build"], source.worktree, home);
		const binary = path.join(source.worktree, "packages/coding-agent/dist/gjc");
		await fs.chmod(binary, EXECUTABLE_MODE);
		const binarySha256 = await hashFile(binary);
		if (
			!(await verifyCandidateBinary({
				binary,
				expectedVersion: source.version,
				expectedSha256: binarySha256,
				home,
				trusted: true,
			}))
		)
			throw new ReleaseError("GJC_MCP_E_VERIFY");
		return await publish(context.paths, binary, {
			schema: 1,
			kind: source.kind,
			version: source.version,
			upstreamTag: source.upstreamTag,
			tagObject: source.identity.tagObject,
			upstreamCommit: source.identity.commit,
			patchBase: source.patchBase,
			patchTip: source.patchTip,
			runtimePolicySha256: source.runtimePolicySha256,
			tree: source.tree,
			build: {
				bunVersion: context.bunVersion,
				lockSha256: await hashFile(path.join(source.worktree, "bun.lock")),
				commandId: BUILD_COMMAND_ID,
			},
			probeContract: 1,
			createdAt: new Date().toISOString(),
		});
	} finally {
		await fs.rm(home, { recursive: true, force: true });
	}
}

export async function verifyPinnedFallbackSource(paths: UpdaterPaths, expectedSha256: string): Promise<string> {
	const fallback = await requireCanonicalFile(paths.bunFallbackPath, expectedSha256, {
		root: paths.home,
		allowSymlink: true,
		mode: EXECUTABLE_MODE,
	});
	const expectedFallback = path.join(
		paths.home,
		".bun",
		"install",
		"global",
		"node_modules",
		"@gajae-code",
		"coding-agent",
		"bin",
		"gjc.js",
	);
	if (fallback !== expectedFallback) throw new ReleaseError("GJC_MCP_E_PATH_OWNERSHIP");
	return fallback;
}

export async function buildBaselineFallbackRelease(context: BuildContext, source: ReleaseSource): Promise<ManifestV1> {
	if (
		!context.trustedSource ||
		!path.isAbsolute(source.worktree) ||
		source.kind !== "official" ||
		source.version !== "0.9.6" ||
		source.upstreamTag !== "v0.9.6" ||
		source.identity.tagObject !== null ||
		source.identity.commit !== "aedd0df99e7c9dff420b50f7ff47bd6645627bdd" ||
		source.patchBase !== null ||
		source.patchTip !== null ||
		source.runtimePolicySha256 !== null ||
		source.tree !== BASELINE_TREE
	)
		throw new ReleaseError("GJC_MCP_E_VERIFY");
	await verifyPinnedFallbackSource(context.paths, context.fallbackSha256);
	await requireManagedReleaseRoot(context.paths, true);
	const home = path.join(context.paths.worktreesRoot, `.fallback-build-home-${crypto.randomUUID()}`);
	await fs.mkdir(home, { recursive: true, mode: DIRECTORY_MODE });
	try {
		await runBuild(context, ["install", "--frozen-lockfile"], source.worktree, home);
		await seedBaselineNativeAddon(context, source);
		await runBuild(context, ["--cwd=packages/coding-agent", "run", "check:types"], source.worktree, home);
		await runBuild(context, ["--cwd=packages/coding-agent", "run", "build"], source.worktree, home);
		await verifyPinnedFallbackSource(context.paths, context.fallbackSha256);
		const binary = path.join(source.worktree, "packages/coding-agent/dist/gjc");
		await fs.chmod(binary, EXECUTABLE_MODE);
		const binarySha256 = await hashFile(binary);
		if (
			!(await verifyCandidateBinary({
				binary,
				expectedVersion: source.version,
				expectedSha256: binarySha256,
				home,
				trusted: true,
			}))
		)
			throw new ReleaseError("GJC_MCP_E_VERIFY");
		return await publish(context.paths, binary, {
			schema: 1,
			kind: "bun-fallback",
			version: source.version,
			upstreamTag: source.upstreamTag,
			tagObject: source.identity.tagObject,
			upstreamCommit: source.identity.commit,
			patchBase: null,
			patchTip: null,
			runtimePolicySha256: null,
			tree: source.tree,
			build: {
				bunVersion: context.bunVersion,
				lockSha256: await hashFile(path.join(source.worktree, "bun.lock")),
				commandId: BUILD_COMMAND_ID,
			},
			probeContract: 1,
			createdAt: new Date().toISOString(),
		});
	} finally {
		await fs.rm(home, { recursive: true, force: true });
	}
}
