import { afterEach, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runCli } from "../src/main";
import { resolveUpdaterPaths, type UpdaterPaths } from "../src/paths";
import { publishFallbackRelease, seedBaselineNativeAddon, verifyRelease, verifyReleaseBinary } from "../src/release";
import { type ManifestV1, type StateV1, serializeManifestV1 } from "../src/schema";
import { bootstrap, type TransactionPhase } from "../src/transaction";

const roots: string[] = [];
const ZERO = "0".repeat(64);
const BASELINE_COMMIT = "aedd0df99e7c9dff420b50f7ff47bd6645627bdd";

function digest(value: string | Uint8Array): string {
	return crypto.createHash("sha256").update(value).digest("hex");
}

function gjcScript(version: string): string {
	return `#!/bin/sh\ncase "$1" in\n  --version) echo 'gjc/${version}' ;;\n  --smoke-test) exit 0 ;;\n  *) exit 0 ;;\nesac\n`;
}

async function isolatedPaths(): Promise<{ paths: UpdaterPaths; fallbackTarget: string }> {
	const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-bootstrap-e2e-"));
	const home = await fs.realpath(temporaryHome);
	roots.push(home);
	const paths = resolveUpdaterPaths({ HOME: home });
	await fs.mkdir(paths.releasesRoot, { recursive: true, mode: 0o700 });
	await fs.chmod(paths.releasesRoot, 0o700);
	await fs.mkdir(paths.binRoot, { recursive: true, mode: 0o700 });
	await fs.chmod(paths.binRoot, 0o700);
	const bunBin = path.dirname(paths.bunFallbackPath);
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
	await fs.mkdir(bunBin, { recursive: true, mode: 0o700 });
	await fs.writeFile(fallbackTarget, gjcScript("0.9.6"), { mode: 0o755 });
	await fs.chmod(fallbackTarget, 0o755);
	await fs.writeFile(
		path.join(bunBin, "bun"),
		'#!/bin/sh\nif [ "$1" = build ] && [ "$2" = --compile ] && [ "$4" = --outfile ]; then cp "$3" "$5" && chmod 755 "$5"; exit $?; fi\nexec "$@"\n',
		{ mode: 0o755 },
	);
	await fs.chmod(path.join(bunBin, "bun"), 0o755);
	await fs.symlink(fallbackTarget, paths.bunFallbackPath);
	return { paths, fallbackTarget };
}
function fallbackContext(paths: UpdaterPaths, fallbackTarget: string) {
	const bunPath = path.join(path.dirname(paths.bunFallbackPath), "bun");
	return Promise.all([fs.readFile(bunPath), fs.readFile(fallbackTarget)]).then(([bun, fallback]) => ({
		paths,
		bunPath,
		bunVersion: "1.2.0",
		bunSha256: digest(bun),
		fallbackSha256: digest(fallback),
		baselineNativeAddonSha256: ZERO,
		trustedSource: true,
	}));
}

async function makeRelease(paths: UpdaterPaths, version: string, kind: "official" | "patched"): Promise<ManifestV1> {
	const bytes = new TextEncoder().encode(gjcScript(version));
	const patched = kind === "patched";
	const manifest: ManifestV1 = {
		schema: 1,
		releaseId: ZERO,
		kind,
		version,
		upstreamTag: `v${version}`,
		tagObject: null,
		upstreamCommit: version === "0.9.6" ? BASELINE_COMMIT : "1".repeat(40),
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

async function preparedBootstrap(paths: UpdaterPaths, fallbackTarget: string) {
	const fallback = await publishFallbackRelease(await fallbackContext(paths, fallbackTarget));
	const candidate = await makeRelease(paths, "0.9.6", "official");
	expect((await verifyRelease(paths, fallback.releaseId)).releaseId).toBe(fallback.releaseId);
	expect((await verifyRelease(paths, candidate.releaseId)).releaseId).toBe(candidate.releaseId);
	expect(await verifyReleaseBinary(paths, fallback)).toBe(true);
	expect(await verifyReleaseBinary(paths, candidate)).toBe(true);
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
	return {
		fallback,
		candidate,
		state,
		launcherBytes: new TextEncoder().encode("#!/bin/sh\nexit 99\n"),
	};
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("isolated bootstrap through production release and transaction seams", () => {
	test("publishes a Bun fallback as a verified self-contained immutable regular 0755 executable", async () => {
		const { paths, fallbackTarget } = await isolatedPaths();
		const sourceLink = await fs.readlink(paths.bunFallbackPath);
		const sourceBytes = await fs.readFile(fallbackTarget);
		const release = await publishFallbackRelease(await fallbackContext(paths, fallbackTarget));
		const verified = await verifyRelease(paths, release.releaseId);
		const artifact = path.join(paths.releasesRoot, release.releaseId, verified.artifact.path);
		const stat = await fs.lstat(artifact);

		expect(verified.kind).toBe("bun-fallback");
		expect(stat.isFile()).toBe(true);
		expect(stat.isSymbolicLink()).toBe(false);
		expect(stat.mode & 0o777).toBe(0o755);
		expect(await verifyReleaseBinary(paths, verified)).toBe(true);
		expect(await fs.readlink(paths.bunFallbackPath)).toBe(sourceLink);
		expect(await fs.readFile(fallbackTarget)).toEqual(sourceBytes);
		expect(digest(await fs.readFile(artifact))).toBe(verified.artifact.sha256);
	});
	test("compiles the pinned fallback from its package self-reference with Bun autoinstall disabled", async () => {
		const { paths, fallbackTarget } = await isolatedPaths();
		const packageRoot = path.dirname(path.dirname(fallbackTarget));
		const bunPath = path.join(path.dirname(paths.bunFallbackPath), "bun");
		const cliPath = path.join(packageRoot, "dist", "cli.js");
		await fs.rm(bunPath);
		if (((await fs.lstat(process.execPath)).mode & 0o777) === 0o755) {
			try {
				await fs.link(process.execPath, bunPath);
			} catch {
				await fs.copyFile(process.execPath, bunPath);
			}
		} else {
			await fs.copyFile(process.execPath, bunPath);
			await fs.chmod(bunPath, 0o755);
		}
		await fs.mkdir(path.dirname(cliPath), { recursive: true, mode: 0o700 });
		await fs.writeFile(
			path.join(packageRoot, "package.json"),
			JSON.stringify({
				name: "@gajae-code/coding-agent",
				type: "module",
				exports: { "./cli": "./dist/cli.js" },
			}),
			{ mode: 0o600 },
		);
		await fs.writeFile(fallbackTarget, '#!/usr/bin/env bun\nimport "@gajae-code/coding-agent/cli";\n', {
			mode: 0o755,
		});
		await fs.chmod(fallbackTarget, 0o755);
		await fs.writeFile(
			cliPath,
			'if (process.argv[2] === "--version") console.log("gjc/0.9.6");\nif (process.argv[2] === "--smoke-test") console.log("smoke-test: ok");\n',
			{ mode: 0o600 },
		);

		const release = await publishFallbackRelease(await fallbackContext(paths, fallbackTarget));
		expect(release.kind).toBe("bun-fallback");
		expect(await verifyReleaseBinary(paths, release)).toBe(true);
	});
	test("rejects changed, moved, symlinked, or wrong-mode dependencies and a non-private managed root", async () => {
		const first = await isolatedPaths();
		const fallbackPinned = await fallbackContext(first.paths, first.fallbackTarget);
		await fs.appendFile(first.fallbackTarget, "\n# changed\n");
		await expect(publishFallbackRelease(fallbackPinned)).rejects.toMatchObject({ code: "GJC_MCP_E_VERIFY" });

		const second = await isolatedPaths();
		const bunPinned = await fallbackContext(second.paths, second.fallbackTarget);
		await fs.appendFile(bunPinned.bunPath, "\n# changed\n");
		await expect(publishFallbackRelease(bunPinned)).rejects.toMatchObject({ code: "GJC_MCP_E_VERIFY" });
		const wrongMode = await isolatedPaths();
		const wrongModePinned = await fallbackContext(wrongMode.paths, wrongMode.fallbackTarget);
		await fs.chmod(wrongMode.fallbackTarget, 0o700);
		await expect(publishFallbackRelease(wrongModePinned)).rejects.toMatchObject({
			code: "GJC_MCP_E_PATH_OWNERSHIP",
		});

		const moved = await isolatedPaths();
		const movedTarget = path.join(moved.paths.home, "moved-gjc");
		await fs.rename(moved.fallbackTarget, movedTarget);
		await fs.unlink(moved.paths.bunFallbackPath);
		await fs.symlink(movedTarget, moved.paths.bunFallbackPath);
		await expect(publishFallbackRelease(await fallbackContext(moved.paths, movedTarget))).rejects.toMatchObject({
			code: "GJC_MCP_E_PATH_OWNERSHIP",
		});

		const symlinkedBun = await isolatedPaths();
		const bunPath = path.join(path.dirname(symlinkedBun.paths.bunFallbackPath), "bun");
		const bunTarget = path.join(symlinkedBun.paths.home, "bun-target");
		await fs.rename(bunPath, bunTarget);
		await fs.symlink(bunTarget, bunPath);
		await expect(
			publishFallbackRelease(await fallbackContext(symlinkedBun.paths, symlinkedBun.fallbackTarget)),
		).rejects.toMatchObject({ code: "GJC_MCP_E_PATH_OWNERSHIP" });

		const third = await isolatedPaths();
		await fs.chmod(third.paths.releasesRoot, 0o755);
		await expect(
			publishFallbackRelease(await fallbackContext(third.paths, third.fallbackTarget)),
		).rejects.toMatchObject({
			code: "GJC_MCP_E_PATH_OWNERSHIP",
		});
	});

	test("pins the baseline native addon before copying it into a candidate worktree", async () => {
		const fixture = await isolatedPaths();
		const platform =
			process.platform === "darwin"
				? "darwin"
				: process.platform === "linux"
					? "linux"
					: process.platform === "win32"
						? "win32"
						: null;
		const architecture = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
		if (!platform || !architecture) return;

		const packageRoot = path.join(
			fixture.paths.home,
			".bun",
			"install",
			"global",
			"node_modules",
			"@gajae-code",
			`natives-${platform}-${architecture}`,
		);
		const fileName = `pi_natives.${platform}-${architecture}.node`;
		const addon = path.join(packageRoot, "native", fileName);
		const worktree = path.join(fixture.paths.home, "candidate-worktree");
		const target = path.join(worktree, "packages", "natives", "native", fileName);
		const bytes = new TextEncoder().encode("synthetic-native-addon");
		await fs.mkdir(path.dirname(addon), { recursive: true, mode: 0o700 });
		await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
		await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ version: "0.9.6" }), {
			mode: 0o600,
		});
		await fs.writeFile(addon, bytes, { mode: 0o644 });
		await fs.chmod(addon, 0o644);
		const baseContext = await fallbackContext(fixture.paths, fixture.fallbackTarget);
		const context = { ...baseContext, baselineNativeAddonSha256: digest(bytes) };
		const source = {
			worktree,
			kind: "official" as const,
			version: "0.9.6",
			upstreamTag: "v0.9.6",
			identity: { tagObject: null, commit: BASELINE_COMMIT },
			patchBase: null,
			patchTip: null,
			runtimePolicySha256: null,
			tree: "1".repeat(40),
		};

		await seedBaselineNativeAddon(context, source);
		expect(new Uint8Array(await fs.readFile(target))).toEqual(bytes);
		expect((await fs.lstat(target)).mode & 0o777).toBe(0o600);

		await fs.appendFile(addon, "changed");
		await expect(seedBaselineNativeAddon(context, source)).rejects.toMatchObject({ code: "GJC_MCP_E_VERIFY" });
		await fs.writeFile(addon, bytes);
		await fs.chmod(addon, 0o600);
		await expect(seedBaselineNativeAddon(context, source)).rejects.toMatchObject({
			code: "GJC_MCP_E_PATH_OWNERSHIP",
		});
	});
	test("prepares and verifies releases before journaling, flips pointers before installing the launcher, and records baseline authority", async () => {
		const { paths, fallbackTarget } = await isolatedPaths();
		const sourceLink = await fs.readlink(paths.bunFallbackPath);
		const sourceBytes = await fs.readFile(fallbackTarget);
		let prepared: Awaited<ReturnType<typeof preparedBootstrap>> | undefined;
		const verifications: string[] = [];
		const phases: TransactionPhase[] = [];
		const result = await bootstrap({
			paths,
			prepareBootstrap: async () => {
				expect(await Bun.file(paths.journalPath).exists()).toBe(false);
				prepared = await preparedBootstrap(paths, fallbackTarget);
				expect(await Bun.file(paths.journalPath).exists()).toBe(false);
				return prepared;
			},
			verifyBinary: async release => {
				verifications.push(release.releaseId);
				return verifyReleaseBinary(paths, release);
			},
			faults: {
				afterPhase: async phase => {
					phases.push(phase);
					if (phase === "current-written" || phase === "prelaunch-verified") {
						expect(await fs.readlink(paths.currentPath)).toBe(`releases/${prepared!.candidate.releaseId}`);
						expect(await Bun.file(paths.launcherPath).exists()).toBe(false);
					}
					if (phase === "launcher-written") {
						const launcher = await fs.lstat(paths.launcherPath);
						expect(launcher.isFile()).toBe(true);
						expect(launcher.isSymbolicLink()).toBe(false);
						expect(launcher.mode & 0o777).toBe(0o755);
					}
				},
			},
		});

		expect(result).toMatchObject({ code: "GJC_MCP_OK", changed: true, candidate: "0.9.6" });
		expect(phases).toEqual([
			"prepared",
			"previous-written",
			"current-written",
			"prelaunch-verified",
			"launcher-written",
			"post-verified",
			"state-written",
		]);
		expect(verifications).toEqual([
			prepared!.candidate.releaseId,
			prepared!.candidate.releaseId,
			prepared!.candidate.releaseId,
		]);
		expect(await fs.readlink(paths.currentPath)).toBe(`releases/${prepared!.candidate.releaseId}`);
		expect(await fs.readlink(paths.previousPath)).toBe(`releases/${prepared!.fallback.releaseId}`);
		const state = JSON.parse(await fs.readFile(paths.statePath, "utf8")) as StateV1;
		expect(state).toMatchObject({
			state: "official-managed",
			activeRelease: prepared!.candidate.releaseId,
			previousRelease: prepared!.fallback.releaseId,
			originalBun: { path: paths.bunFallbackPath, version: "0.9.6", sha256: digest(sourceBytes) },
			observedUpstreamTags: { "v0.9.6": { tagObject: null, commit: BASELINE_COMMIT } },
		});
		expect(await fs.readlink(paths.bunFallbackPath)).toBe(sourceLink);
		expect(await fs.readFile(fallbackTarget)).toEqual(sourceBytes);
		expect(await Bun.file(paths.journalPath).exists()).toBe(false);

		const dispatches: Array<{ executable: string; argv: readonly string[] }> = [];
		const exitCode = await runCli({
			argv: ["--version"],
			executable: paths.launcherPath,
			environment: { HOME: paths.home },
			io: { out: () => {}, err: () => {} },
			exec: async (executable, argv) => {
				dispatches.push({ executable, argv });
				return 0;
			},
		});
		expect(exitCode).toBe(0);
		expect(dispatches).toEqual([
			{
				executable: path.join(paths.releasesRoot, prepared!.candidate.releaseId, "bin", "gjc"),
				argv: ["gjc", "--version"],
			},
		]);
	});

	test("verification failures before and after the authority flip preserve or restore the uninstalled state", async () => {
		for (const failAt of [1, 3]) {
			const { paths, fallbackTarget } = await isolatedPaths();
			const sourceLink = await fs.readlink(paths.bunFallbackPath);
			const sourceBytes = await fs.readFile(fallbackTarget);
			const prepared = await preparedBootstrap(paths, fallbackTarget);
			let calls = 0;
			const result = await bootstrap({
				paths,
				prepareBootstrap: async () => prepared,
				verifyBinary: async release => {
					calls += 1;
					if (calls === failAt) {
						expect(await Bun.file(paths.journalPath).exists()).toBe(failAt === 3);
						expect(await Bun.file(paths.currentPath).exists()).toBe(failAt === 3);
						expect(await Bun.file(paths.launcherPath).exists()).toBe(failAt === 3);
					}
					return calls !== failAt && (await verifyReleaseBinary(paths, release));
				},
			});

			expect(result).toMatchObject({ code: "GJC_MCP_E_VERIFY", changed: false });
			expect(await Bun.file(paths.currentPath).exists()).toBe(false);
			expect(await Bun.file(paths.previousPath).exists()).toBe(false);
			expect(await Bun.file(paths.launcherPath).exists()).toBe(false);
			expect(await Bun.file(paths.statePath).exists()).toBe(false);
			expect(await Bun.file(paths.journalPath).exists()).toBe(false);
			expect(await fs.readlink(paths.bunFallbackPath)).toBe(sourceLink);
			expect(await fs.readFile(fallbackTarget)).toEqual(sourceBytes);
		}
	});
});
