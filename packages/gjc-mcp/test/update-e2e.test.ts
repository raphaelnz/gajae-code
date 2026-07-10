import { afterEach, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveUpdaterPaths, type UpdaterPaths } from "../src/paths";
import { verifyRelease, verifyReleaseBinary } from "../src/release";
import { type ManifestV1, type StateV1, serializeManifestV1 } from "../src/schema";
import { bootstrap, check, rollback, update } from "../src/transaction";

const roots: string[] = [];
const ZERO = "0".repeat(64);
const BASELINE_COMMIT = "aedd0df99e7c9dff420b50f7ff47bd6645627bdd";

function digest(value: string | Uint8Array): string {
	return crypto.createHash("sha256").update(value).digest("hex");
}

function executable(version: string): Uint8Array {
	return new TextEncoder().encode(
		`#!/bin/sh\ncase "$1" in\n  --version) echo 'gjc/${version}' ;;\n  --smoke-test) exit 0 ;;\n  *) exit 0 ;;\nesac\n`,
	);
}

async function makeRelease(
	paths: UpdaterPaths,
	version: string,
	kind: ManifestV1["kind"],
	commit: string,
): Promise<ManifestV1> {
	const bytes = executable(version);
	const patched = kind === "patched";
	const manifest: ManifestV1 = {
		schema: 1,
		releaseId: ZERO,
		kind,
		version,
		upstreamTag: `v${version}`,
		tagObject: null,
		upstreamCommit: commit,
		patchBase: patched ? "2".repeat(40) : null,
		patchTip: patched ? "3".repeat(40) : null,
		runtimePolicySha256: patched ? "4".repeat(64) : null,
		tree: "5".repeat(40),
		artifact: { path: "bin/gjc", sha256: digest(bytes), size: bytes.byteLength, mode: 0o755 },
		build: { bunVersion: "1.2.0", lockSha256: ZERO, commandId: "coding-agent-build-v1" },
		probeContract: 1,
		createdAt: "2026-07-10T00:00:00.000Z",
	};
	manifest.releaseId = digest(JSON.stringify({ ...manifest, releaseId: ZERO }));
	const root = path.join(paths.releasesRoot, manifest.releaseId);
	await fs.mkdir(path.join(root, "bin"), { recursive: true, mode: 0o700 });
	await fs.chmod(root, 0o700);
	await fs.writeFile(path.join(root, "bin", "gjc"), bytes, { mode: 0o755 });
	await fs.chmod(path.join(root, "bin", "gjc"), 0o755);
	await fs.writeFile(path.join(root, "manifest.json"), serializeManifestV1(manifest), { mode: 0o600 });
	await fs.chmod(path.join(root, "manifest.json"), 0o600);
	return manifest;
}

interface InstalledFixture {
	paths: UpdaterPaths;
	fallback: ManifestV1;
	initial: ManifestV1;
	official: ManifestV1;
	patched: ManifestV1;
}

async function installedFixture(): Promise<InstalledFixture> {
	const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-update-e2e-"));
	const home = await fs.realpath(temporaryHome);
	roots.push(home);
	const paths = resolveUpdaterPaths({ HOME: home });
	await fs.mkdir(paths.releasesRoot, { recursive: true, mode: 0o700 });
	await fs.chmod(paths.releasesRoot, 0o700);
	await fs.mkdir(paths.binRoot, { recursive: true, mode: 0o700 });
	await fs.chmod(paths.binRoot, 0o700);
	await fs.mkdir(path.dirname(paths.bunFallbackPath), { recursive: true, mode: 0o700 });
	const fallbackTarget = path.join(
		home,
		".bun",
		"install",
		"global",
		"node_modules",
		"@gajae-code",
		"coding-agent",
		"bin",
		"gjc.js",
	);
	await fs.mkdir(path.dirname(fallbackTarget), { recursive: true, mode: 0o700 });
	await fs.writeFile(fallbackTarget, executable("0.9.6"), { mode: 0o755 });
	await fs.chmod(fallbackTarget, 0o755);
	await fs.symlink(fallbackTarget, paths.bunFallbackPath);

	const fallback = await makeRelease(paths, "0.9.6", "bun-fallback", BASELINE_COMMIT);
	const initial = await makeRelease(paths, "0.9.6", "official", BASELINE_COMMIT);
	const official = await makeRelease(paths, "0.9.7", "official", "1".repeat(40));
	const patched = await makeRelease(paths, "0.9.8", "patched", "6".repeat(40));
	const state: StateV1 = {
		schema: 1,
		state: "installing",
		activeRelease: null,
		previousRelease: null,
		observedUpstreamTags: {},
		originalBun: {
			path: paths.bunFallbackPath,
			version: "0.9.6",
			sha256: digest(new Uint8Array(await Bun.file(paths.bunFallbackPath).arrayBuffer())),
		},
		launcherSha256: null,
		lastRun: null,
	};
	const result = await bootstrap({
		paths,
		prepareBootstrap: async () => ({
			fallback,
			candidate: initial,
			state,
			launcherBytes: new TextEncoder().encode("#!/bin/sh\nexit 99\n"),
		}),
		verifyBinary: release => verifyReleaseBinary(paths, release),
	});
	expect(result).toMatchObject({ code: "GJC_MCP_OK", changed: true });
	return { paths, fallback, initial, official, patched };
}

async function managedSnapshot(paths: UpdaterPaths, releases: readonly ManifestV1[]): Promise<Record<string, string>> {
	const snapshot: Record<string, string> = {};
	for (const [name, target] of Object.entries({
		current: paths.currentPath,
		previous: paths.previousPath,
		state: paths.statePath,
		journal: paths.journalPath,
		launcher: paths.launcherPath,
		fallback: paths.bunFallbackPath,
	})) {
		try {
			const stat = await fs.lstat(target);
			snapshot[name] = stat.isSymbolicLink()
				? `link:${await fs.readlink(target)}`
				: `file:${stat.mode & 0o777}:${digest(await fs.readFile(target))}`;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			snapshot[name] = "absent";
		}
	}
	for (const release of releases) {
		const root = path.join(paths.releasesRoot, release.releaseId);
		const artifact = path.join(root, release.artifact.path);
		snapshot[`release:${release.releaseId}`] = `${(await fs.lstat(artifact)).mode & 0o777}:${digest(
			await fs.readFile(artifact),
		)}:${digest(await fs.readFile(path.join(root, "manifest.json")))}`;
	}
	return snapshot;
}

async function versionOf(paths: UpdaterPaths, release: ManifestV1): Promise<string> {
	const binary = path.join(paths.releasesRoot, release.releaseId, release.artifact.path);
	const child = Bun.spawn([binary, "--version"], {
		env: { HOME: paths.home, PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "ignore",
	});
	const output = await new Response(child.stdout).text();
	expect(await child.exited).toBe(0);
	return output.trim();
}

function prepared(release: ManifestV1) {
	return {
		release,
		selectedTag: {
			name: release.upstreamTag,
			identity: { tagObject: release.tagObject, commit: release.upstreamCommit },
		},
	};
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("isolated update and rollback transactions", () => {
	test("no-op update and check leave every managed byte, pointer, and prepared release immutable", async () => {
		const fixture = await installedFixture();
		const releases = [fixture.fallback, fixture.initial, fixture.official, fixture.patched];
		const beforeNoop = await managedSnapshot(fixture.paths, releases);
		const noOp = await update({
			paths: fixture.paths,
			prepareUpdate: async () => null,
			verifyBinary: release => verifyReleaseBinary(fixture.paths, release),
		});
		expect(noOp).toEqual({ code: "GJC_MCP_OK", changed: false });
		expect(await managedSnapshot(fixture.paths, releases)).toEqual(beforeNoop);

		const beforeCheck = await managedSnapshot(fixture.paths, releases);
		let checks = 0;
		const checked = await check({
			paths: fixture.paths,
			prepareUpdate: async (state, current) => {
				checks += 1;
				expect(state.activeRelease).toBe(fixture.initial.releaseId);
				expect(current.releaseId).toBe(fixture.initial.releaseId);
				return prepared(fixture.official);
			},
		});
		expect(checked).toMatchObject({ code: "GJC_MCP_OK", changed: false, candidate: "0.9.7" });
		expect(checks).toBe(1);
		expect(await managedSnapshot(fixture.paths, releases)).toEqual(beforeCheck);
	});

	test("activates an official release and rollback swaps versions, pointers, state, and final smoke callbacks", async () => {
		const fixture = await installedFixture();
		const updateVerifications: string[] = [];
		const updated = await update({
			paths: fixture.paths,
			prepareUpdate: async (state, current) => {
				expect(state.activeRelease).toBe(fixture.initial.releaseId);
				expect(current.version).toBe("0.9.6");
				return prepared(fixture.official);
			},
			verifyBinary: async release => {
				updateVerifications.push(release.releaseId);
				return verifyReleaseBinary(fixture.paths, release);
			},
		});
		expect(updated).toMatchObject({ code: "GJC_MCP_OK", changed: true, candidate: "0.9.7" });
		expect(updateVerifications).toEqual([
			fixture.initial.releaseId,
			fixture.official.releaseId,
			fixture.official.releaseId,
		]);
		expect(await fs.readlink(fixture.paths.currentPath)).toBe(`releases/${fixture.official.releaseId}`);
		expect(await fs.readlink(fixture.paths.previousPath)).toBe(`releases/${fixture.initial.releaseId}`);
		expect(await versionOf(fixture.paths, await verifyRelease(fixture.paths, fixture.official.releaseId))).toBe(
			"gjc/0.9.7",
		);
		let state = JSON.parse(await fs.readFile(fixture.paths.statePath, "utf8")) as StateV1;
		expect(state).toMatchObject({
			state: "official-managed",
			activeRelease: fixture.official.releaseId,
			previousRelease: fixture.initial.releaseId,
			observedUpstreamTags: { "v0.9.7": { tagObject: null, commit: "1".repeat(40) } },
		});

		const rollbackVerifications: string[] = [];
		const rolledBack = await rollback({
			paths: fixture.paths,
			verifyBinary: async release => {
				rollbackVerifications.push(release.releaseId);
				return verifyReleaseBinary(fixture.paths, release);
			},
		});
		expect(rolledBack).toMatchObject({ code: "GJC_MCP_OK", changed: true });
		expect(rollbackVerifications).toEqual([
			fixture.official.releaseId,
			fixture.initial.releaseId,
			fixture.initial.releaseId,
		]);
		expect(await fs.readlink(fixture.paths.currentPath)).toBe(`releases/${fixture.initial.releaseId}`);
		expect(await fs.readlink(fixture.paths.previousPath)).toBe(`releases/${fixture.official.releaseId}`);
		state = JSON.parse(await fs.readFile(fixture.paths.statePath, "utf8")) as StateV1;
		expect(state).toMatchObject({
			state: "official-managed",
			activeRelease: fixture.initial.releaseId,
			previousRelease: fixture.official.releaseId,
		});
		expect(await versionOf(fixture.paths, fixture.initial)).toBe("gjc/0.9.6");
		expect(await versionOf(fixture.paths, fixture.official)).toBe("gjc/0.9.7");
		expect(await verifyReleaseBinary(fixture.paths, fixture.initial)).toBe(true);
		expect(await verifyReleaseBinary(fixture.paths, fixture.official)).toBe(true);
		expect(await Bun.file(fixture.paths.journalPath).exists()).toBe(false);
	});

	test("activates an injected patched candidate and records patched-managed authority", async () => {
		const fixture = await installedFixture();
		const result = await update({
			paths: fixture.paths,
			prepareUpdate: async () => prepared(fixture.patched),
			verifyBinary: release => verifyReleaseBinary(fixture.paths, release),
		});
		expect(result).toMatchObject({ code: "GJC_MCP_OK", changed: true, candidate: "0.9.8" });
		expect(await fs.readlink(fixture.paths.currentPath)).toBe(`releases/${fixture.patched.releaseId}`);
		expect(await fs.readlink(fixture.paths.previousPath)).toBe(`releases/${fixture.initial.releaseId}`);
		const state = JSON.parse(await fs.readFile(fixture.paths.statePath, "utf8")) as StateV1;
		expect(state).toMatchObject({
			state: "patched-managed",
			activeRelease: fixture.patched.releaseId,
			previousRelease: fixture.initial.releaseId,
			observedUpstreamTags: { "v0.9.8": { tagObject: null, commit: "6".repeat(40) } },
		});
		expect(await verifyReleaseBinary(fixture.paths, fixture.patched)).toBe(true);
	});

	test("rejects independent corruption of every installed authority component", async () => {
		const cases: Array<[string, (fixture: InstalledFixture) => Promise<void>]> = [
			[
				"current",
				async fixture => {
					await fs.unlink(fixture.paths.currentPath);
					await fs.symlink(`releases/${fixture.fallback.releaseId}`, fixture.paths.currentPath);
				},
			],
			[
				"previous",
				async fixture => {
					await fs.appendFile(
						path.join(fixture.paths.releasesRoot, fixture.fallback.releaseId, fixture.fallback.artifact.path),
						"corrupt",
					);
				},
			],
			[
				"state",
				async fixture => {
					const state = JSON.parse(await fs.readFile(fixture.paths.statePath, "utf8")) as StateV1;
					state.activeRelease = fixture.fallback.releaseId;
					await fs.writeFile(fixture.paths.statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
				},
			],
			[
				"launcher",
				async fixture => {
					await fs.appendFile(fixture.paths.launcherPath, "corrupt");
				},
			],
			[
				"fallback",
				async fixture => {
					await fs.appendFile(await fs.realpath(fixture.paths.bunFallbackPath), "corrupt");
				},
			],
		];

		for (const [component, mutate] of cases) {
			const fixture = await installedFixture();
			await mutate(fixture);
			const result = await check({
				paths: fixture.paths,
				prepareUpdate: async () => null,
				verifyBinary: async () => true,
			});
			expect(result.code, component).not.toBe("GJC_MCP_OK");
		}
	});
	test("candidate binary verifier failure occurs before journaling and preserves installed authority", async () => {
		const fixture = await installedFixture();
		const releases = [fixture.fallback, fixture.initial, fixture.official, fixture.patched];
		const before = await managedSnapshot(fixture.paths, releases);
		const seen: string[] = [];
		const result = await update({
			paths: fixture.paths,
			prepareUpdate: async () => prepared(fixture.official),
			verifyBinary: async release => {
				seen.push(release.releaseId);
				return (
					release.releaseId !== fixture.official.releaseId && (await verifyReleaseBinary(fixture.paths, release))
				);
			},
		});
		expect(result).toMatchObject({ code: "GJC_MCP_E_VERIFY", changed: false });
		expect(seen).toEqual([fixture.initial.releaseId, fixture.official.releaseId]);
		expect(await managedSnapshot(fixture.paths, releases)).toEqual(before);
		expect(await Bun.file(fixture.paths.journalPath).exists()).toBe(false);
	});
});
