import { afterEach, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	classifyInstallerSnapshot,
	type InstallClassification,
	type SidecarSnapshot,
	type TargetSnapshot,
	verifyUpdaterCandidateBeforePublish,
} from "../scripts/install";
import { acquireLock } from "../src/lock";
import { type CliIO, runCli } from "../src/main";
import { ensureManagedRoots, type PathEnvironment, resolveUpdaterPaths } from "../src/paths";
import {
	type ConfigV1,
	OFFICIAL_UPSTREAM_URL,
	PUBLIC_FORK_URL,
	policySha256,
	RUNTIME_PATCH_PATHS,
	RUNTIME_POLICY_ID,
	SIGNER_POLICY,
	UPDATER_POLICY_ID,
	UPDATER_SOURCE_PATHS,
	UPSTREAM_TAG_POLICY,
	type UpdaterInstallV1,
} from "../src/schema";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

function capture(): { io: CliIO; stdout: string[]; stderr: string[] } {
	const stdout: string[] = [];
	const stderr: string[] = [];
	return { stdout, stderr, io: { out: text => stdout.push(text), err: text => stderr.push(text) } };
}

async function syntheticEnvironment(): Promise<PathEnvironment & NodeJS.ProcessEnv> {
	const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-cli-"));
	const home = await fs.realpath(temporaryHome);
	roots.push(home);
	return {
		HOME: home,
		XDG_DATA_HOME: path.join(home, "xdg-data"),
		XDG_CONFIG_HOME: path.join(home, "xdg-config"),
		XDG_STATE_HOME: path.join(home, "xdg-state"),
		XDG_CACHE_HOME: path.join(home, "xdg-cache"),
	};
}

describe("public command syntax", () => {
	const invalid = [
		[],
		["--help"],
		["help", "extra"],
		["status", "extra"],
		["update", "-c"],
		["update", "--check", "extra"],
		["rollback", "extra"],
		["install"],
		["bootstrap"],
	];
	for (const argv of invalid) {
		test(JSON.stringify(argv), async () => {
			const output = capture();
			const code = await runCli({
				argv,
				executable: "/synthetic/.local/bin/gjc-mcp",
				environment: { HOME: "/synthetic" },
				io: output.io,
			});
			expect(code).toBe(2);
			expect(output.stderr).toEqual(["GJC_MCP_E_USAGE"]);
		});
	}

	test("help is static and performs no filesystem access", async () => {
		const output = capture();
		const code = await runCli({
			argv: ["help"],
			executable: "/definitely/absent/gjc-mcp",
			environment: { HOME: "/definitely/absent" },
			io: output.io,
		});
		expect(code).toBe(0);
		expect(output.stderr).toEqual([]);
		expect(output.stdout.join("\n")).toContain("gjc-mcp update --check");
	});
});

describe("managed launcher syntax and validation order", () => {
	const syntax: Array<[readonly string[], number, string | undefined]> = [
		[["update", "--help"], 0, undefined],
		[["update", "-h"], 0, undefined],
		[["update", "--bad"], 2, "GJC_MCP_E_MANAGED_UPDATE_ARGS"],
		[["update", "-c"], 2, "GJC_MCP_E_MANAGED_UPDATE_ARGS"],
		[["update", "--check", "extra"], 2, "GJC_MCP_E_MANAGED_UPDATE_ARGS"],
	];
	for (const [argv, expected, diagnostic] of syntax) {
		test(argv.join(" "), async () => {
			const output = capture();
			const code = await runCli({
				argv,
				executable: "/synthetic/.local/bin/gjc",
				environment: { HOME: "/synthetic" },
				io: output.io,
			});
			expect(code).toBe(expected);
			if (diagnostic) expect(output.stderr).toEqual([diagnostic]);
		});
	}

	test("update dispatch reports missing sidecar before updater and config", async () => {
		const environment = await syntheticEnvironment();
		const output = capture();
		let executed = false;
		const code = await runCli({
			argv: ["update"],
			executable: path.join(environment.HOME!, ".local", "bin", "gjc"),
			environment,
			io: output.io,
			exec: () => {
				executed = true;
				return 0;
			},
		});
		expect(code).toBe(1);
		expect(output.stderr).toEqual(["GJC_MCP_E_UPDATER_SIDECAR_MISSING"]);
		expect(executed).toBeFalse();
	});

	test("normal launch checks journal before current", async () => {
		const environment = await syntheticEnvironment();
		const paths = resolveUpdaterPaths(environment);
		await fs.mkdir(path.dirname(paths.journalPath), { recursive: true });
		await fs.writeFile(paths.journalPath, "not-json");
		const output = capture();
		const code = await runCli({ argv: ["--version"], executable: paths.launcherPath, environment, io: output.io });
		expect(code).toBe(1);
		expect(output.stderr[0]).toBe("GJC_MCP_E_RECOVERY_REQUIRED");
		expect(output.stderr).not.toContain("GJC_MCP_E_CURRENT_MISSING");
	});

	test("normal launch reports current missing when no journal exists", async () => {
		const environment = await syntheticEnvironment();
		const paths = resolveUpdaterPaths(environment);
		const output = capture();
		const code = await runCli({ argv: [], executable: paths.launcherPath, environment, io: output.io });
		expect(code).toBe(1);
		expect(output.stderr[0]).toBe("GJC_MCP_E_CURRENT_MISSING");
		expect(output.stderr.join("\n")).not.toContain(environment.HOME!);
	});
});

async function trustedUpdaterEnvironment(): Promise<{
	environment: PathEnvironment & NodeJS.ProcessEnv;
	paths: ReturnType<typeof resolveUpdaterPaths>;
}> {
	const environment = await syntheticEnvironment();
	const paths = resolveUpdaterPaths(environment);
	await ensureManagedRoots(paths, true);
	const updaterBytes = new TextEncoder().encode("synthetic updater");
	const artifactSha256 = crypto.createHash("sha256").update(updaterBytes).digest("hex");
	const sourceCommit = "c".repeat(40);
	const runtimePolicy = {
		schema: 1 as const,
		id: RUNTIME_POLICY_ID,
		paths: [...RUNTIME_PATCH_PATHS].sort(),
		sha256: "",
	};
	runtimePolicy.sha256 = policySha256({ ...runtimePolicy, sha256: "0".repeat(64) });
	const updaterPolicy = {
		schema: 1 as const,
		id: UPDATER_POLICY_ID,
		paths: [...UPDATER_SOURCE_PATHS].sort(),
		sha256: "",
	};
	updaterPolicy.sha256 = policySha256({ ...updaterPolicy, sha256: "0".repeat(64) });
	const config: ConfigV1 = {
		schema: 1,
		upstreamUrl: OFFICIAL_UPSTREAM_URL,
		forkUrl: PUBLIC_FORK_URL,
		upstreamTagPolicy: UPSTREAM_TAG_POLICY,
		signerPolicy: SIGNER_POLICY,
		bootstrapArtifacts: {
			bunSha256: "1".repeat(64),
			fallbackSha256: "2".repeat(64),
			baselineNativeAddonSha256: "3".repeat(64),
		},
		runtimePatchPolicies: { [RUNTIME_POLICY_ID]: runtimePolicy },
		updaterSourcePolicies: { [UPDATER_POLICY_ID]: updaterPolicy },
		approvedRuntimePatchTips: {},
		approvedUpdaterSources: {
			[sourceCommit]: {
				mergeBase: "a".repeat(40),
				branch: "gjc-mcp-controller-v1",
				updaterPolicySha256: updaterPolicy.sha256,
				artifactSha256,
				approvedAt: "2026-07-10T00:00:00.000Z",
			},
		},
	};
	const sidecar: UpdaterInstallV1 = {
		schema: 1,
		installedPath: paths.updaterPath,
		artifactSha256,
		sourceCommit,
		updaterPathPolicySha256: updaterPolicy.sha256,
		ownerUid: process.getuid!(),
		mode: 0o755,
		installedAt: "2026-07-10T00:00:00.000Z",
	};
	await fs.mkdir(path.dirname(paths.updaterPath), { recursive: true, mode: 0o700 });
	await fs.mkdir(path.dirname(paths.sidecarPath), { recursive: true, mode: 0o700 });
	await fs.mkdir(path.dirname(paths.configPath), { recursive: true, mode: 0o700 });
	await fs.writeFile(paths.updaterPath, updaterBytes, { mode: 0o755 });
	await fs.chmod(paths.updaterPath, 0o755);
	await fs.writeFile(paths.sidecarPath, `${JSON.stringify(sidecar)}\n`, { mode: 0o600 });
	await fs.chmod(paths.sidecarPath, 0o600);
	await fs.writeFile(paths.configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
	await fs.chmod(paths.configPath, 0o600);
	return { environment, paths };
}

function lockRecord(pid: number): string {
	return `${JSON.stringify({ schema: 1, pid, uid: process.getuid!(), token: "a".repeat(32), createdAt: "2026-07-10T00:00:00.000Z" })}\n`;
}

describe("public updater validation, status, and locking", () => {
	test("bootstrap is usage-invalid without touching the isolated home", async () => {
		const environment = await syntheticEnvironment();
		const output = capture();
		expect(
			await runCli({
				argv: ["bootstrap"],
				executable: path.join(environment.HOME!, ".local/bin/gjc-mcp"),
				environment,
				io: output.io,
			}),
		).toBe(2);
		expect(output.stderr).toEqual(["GJC_MCP_E_USAGE"]);
		expect(await fs.readdir(environment.HOME!)).toEqual([]);
	});

	test("status aggregates updater, lock, config, and local diagnostics", async () => {
		const environment = await syntheticEnvironment();
		const paths = resolveUpdaterPaths(environment);
		await fs.mkdir(path.dirname(paths.lockPath), { recursive: true, mode: 0o700 });
		await fs.writeFile(paths.lockPath, lockRecord(process.pid), { mode: 0o600 });
		const output = capture();
		expect(await runCli({ argv: ["status"], executable: paths.updaterPath, environment, io: output.io })).toBe(1);
		expect(output.stderr).toEqual(
			expect.arrayContaining([
				"GJC_MCP_E_UPDATER_SIDECAR_MISSING",
				"GJC_MCP_E_BUSY",
				"GJC_MCP_E_CONFIG_MISSING",
				"GJC_MCP_E_CURRENT_MISSING",
				"GJC_MCP_E_STATE_SCHEMA",
				"GJC_MCP_E_PREVIOUS_MISSING",
			]),
		);
	});

	for (const argv of [["update"], ["update", "--check"], ["rollback"]]) {
		test(`${argv.join(" ")} validates the updater before inspecting the lock`, async () => {
			const environment = await syntheticEnvironment();
			const paths = resolveUpdaterPaths(environment);
			await fs.mkdir(path.dirname(paths.lockPath), { recursive: true, mode: 0o700 });
			await fs.writeFile(paths.lockPath, "malformed", { mode: 0o600 });
			const output = capture();
			expect(await runCli({ argv, executable: paths.updaterPath, environment, io: output.io })).toBe(1);
			expect(output.stderr).toEqual(["GJC_MCP_E_UPDATER_SIDECAR_MISSING"]);
			expect(await Bun.file(paths.lockPath).text()).toBe("malformed");
		});
	}

	const lockCases: Array<[string, string, string]> = [
		["live", lockRecord(process.pid), "GJC_MCP_E_BUSY"],
		["malformed", "not-json", "GJC_MCP_E_LOCK_MALFORMED"],
	];
	for (const [name, contents, expected] of lockCases) {
		test(`${name} lock has a stable diagnostic`, async () => {
			const { environment, paths } = await trustedUpdaterEnvironment();
			await fs.mkdir(path.dirname(paths.lockPath), { recursive: true, mode: 0o700 });
			await fs.writeFile(paths.lockPath, contents, { mode: 0o600 });
			const output = capture();
			expect(
				await runCli({ argv: ["update", "--check"], executable: paths.updaterPath, environment, io: output.io }),
			).toBe(1);
			expect(output.stderr).toEqual([expected]);
		});
	}

	for (const argv of [["update"], ["update", "--check"], ["rollback"]]) {
		test(`${argv.join(" ")} replaces a stale lock, holds it for the operation, and releases it`, async () => {
			const { environment, paths } = await trustedUpdaterEnvironment();
			await fs.mkdir(path.dirname(paths.lockPath), { recursive: true, mode: 0o700 });
			await fs.writeFile(paths.lockPath, lockRecord(2_147_483_647), { mode: 0o600 });
			const output = capture();
			expect(await runCli({ argv, executable: paths.updaterPath, environment, io: output.io })).toBe(1);
			expect(output.stderr).toEqual(["GJC_MCP_E_CURRENT_MISSING"]);
			expect(await Bun.file(paths.lockPath).exists()).toBe(false);
		});
	}

	test("serializes concurrent stale-lock takeover so only one transaction acquires authority", async () => {
		const environment = await syntheticEnvironment();
		const paths = resolveUpdaterPaths(environment);
		await ensureManagedRoots(paths, true);
		await fs.writeFile(paths.lockPath, lockRecord(2_147_483_647), { mode: 0o600 });

		const results = await Promise.all([acquireLock(paths.lockPath), acquireLock(paths.lockPath)]);
		const acquired = results.filter(result => result.ok);
		const rejected = results.filter(result => !result.ok);

		expect(acquired).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect(rejected[0]).toMatchObject({ ok: false, code: "GJC_MCP_E_BUSY" });
		if (acquired[0]?.ok) await acquired[0].lock.release();
		expect(await Bun.file(`${paths.lockPath}.takeover`).exists()).toBe(false);
		expect(await Bun.file(paths.lockPath).exists()).toBe(false);
	});
	test("recovers an abandoned takeover guard owned by a dead process", async () => {
		const environment = await syntheticEnvironment();
		const paths = resolveUpdaterPaths(environment);
		await ensureManagedRoots(paths, true);
		await fs.writeFile(`${paths.lockPath}.takeover`, lockRecord(2_147_483_647), { mode: 0o600 });

		const acquired = await acquireLock(paths.lockPath);
		expect(acquired.ok).toBe(true);
		if (acquired.ok) await acquired.lock.release();
		expect(await Bun.file(`${paths.lockPath}.takeover`).exists()).toBe(false);
		expect(await Bun.file(paths.lockPath).exists()).toBe(false);
	});
	test("serializes concurrent recovery of both an abandoned guard and stale primary lock", async () => {
		const environment = await syntheticEnvironment();
		const paths = resolveUpdaterPaths(environment);
		await ensureManagedRoots(paths, true);
		await fs.writeFile(paths.lockPath, lockRecord(2_147_483_647), { mode: 0o600 });
		await fs.writeFile(`${paths.lockPath}.takeover`, lockRecord(2_147_483_647), { mode: 0o600 });

		const results = await Promise.all([acquireLock(paths.lockPath), acquireLock(paths.lockPath)]);
		const acquired = results.filter(result => result.ok);
		expect(acquired).toHaveLength(1);
		expect(results.filter(result => !result.ok)).toHaveLength(1);
		if (acquired[0]?.ok) await acquired[0].lock.release();
		expect(await Bun.file(`${paths.lockPath}.takeover`).exists()).toBe(false);
		expect(await Bun.file(`${paths.lockPath}.takeover.claim`).exists()).toBe(false);
		expect(await Bun.file(paths.lockPath).exists()).toBe(false);
	});

	test("recovers an abandoned identity claim before taking over the dead guard", async () => {
		const environment = await syntheticEnvironment();
		const paths = resolveUpdaterPaths(environment);
		await ensureManagedRoots(paths, true);
		const guardPath = `${paths.lockPath}.takeover`;
		await fs.writeFile(guardPath, lockRecord(2_147_483_647), { mode: 0o600 });
		await fs.link(guardPath, `${guardPath}.claim`);

		const acquired = await acquireLock(paths.lockPath);
		expect(acquired.ok).toBe(true);
		if (acquired.ok) await acquired.lock.release();
		expect(await Bun.file(guardPath).exists()).toBe(false);
		expect(await Bun.file(`${guardPath}.claim`).exists()).toBe(false);
		expect(await Bun.file(paths.lockPath).exists()).toBe(false);
	});
});
describe("updater install snapshot classifications", () => {
	test("rejects a failing updater candidate before installed target or sidecar bytes can change", async () => {
		const environment = await syntheticEnvironment();
		const paths = resolveUpdaterPaths(environment);
		const candidatePath = path.join(environment.HOME!, "candidate-gjc-mcp");
		const candidateBytes = new TextEncoder().encode("#!/bin/sh\nexit 9\n");
		const oldTarget = new TextEncoder().encode("old-updater");
		const oldSidecar = new TextEncoder().encode("old-sidecar");
		await fs.mkdir(path.dirname(paths.updaterPath), { recursive: true, mode: 0o755 });
		await fs.mkdir(path.dirname(paths.sidecarPath), { recursive: true, mode: 0o700 });
		await fs.writeFile(paths.updaterPath, oldTarget, { mode: 0o755 });
		await fs.writeFile(paths.sidecarPath, oldSidecar, { mode: 0o600 });
		await fs.writeFile(candidatePath, candidateBytes, { mode: 0o755 });
		await fs.chmod(candidatePath, 0o755);
		const candidateHash = crypto.createHash("sha256").update(candidateBytes).digest("hex");

		expect(await verifyUpdaterCandidateBeforePublish(candidatePath, candidateHash)).toBe(false);
		expect(new Uint8Array(await fs.readFile(paths.updaterPath))).toEqual(oldTarget);
		expect(new Uint8Array(await fs.readFile(paths.sidecarPath))).toEqual(oldSidecar);
	});
	const candidate = "a".repeat(64);
	const old = "b".repeat(64);
	const installedPath = "/synthetic/.local/bin/gjc-mcp";
	const sidecarValue = (hash: string): UpdaterInstallV1 => ({
		schema: 1,
		installedPath,
		artifactSha256: hash,
		sourceCommit: "c".repeat(40),
		updaterPathPolicySha256: "d".repeat(64),
		ownerUid: 501,
		mode: 493,
		installedAt: "2026-07-10T00:00:00.000Z",
	});
	const cases: Array<
		[string, TargetSnapshot, SidecarSnapshot, string | undefined, InstallClassification | undefined]
	> = [
		["fresh", { present: false, valid: false }, { present: false, valid: false }, undefined, "fresh"],
		[
			"orphan candidate",
			{ present: true, valid: true, hash: candidate },
			{ present: false, valid: false },
			undefined,
			"orphan-candidate",
		],
		[
			"healthy equal",
			{ present: true, valid: true, hash: candidate },
			{ present: true, valid: true, value: sidecarValue(candidate) },
			undefined,
			"healthy-equal",
		],
		[
			"healthy equal after completed replacement",
			{ present: true, valid: true, hash: candidate },
			{ present: true, valid: true, value: sidecarValue(candidate) },
			old,
			"healthy-equal",
		],
		[
			"healthy old",
			{ present: true, valid: true, hash: old },
			{ present: true, valid: true, value: sidecarValue(old) },
			old,
			"healthy-old",
		],
		[
			"rename before sidecar",
			{ present: true, valid: true, hash: candidate },
			{ present: true, valid: true, value: sidecarValue(old) },
			old,
			"rename-before-sidecar",
		],
		["unowned target", { present: true, valid: false }, { present: false, valid: false }, undefined, undefined],
		[
			"unexpected expected old",
			{ present: true, valid: true, hash: old },
			{ present: true, valid: true, value: sidecarValue(old) },
			candidate,
			undefined,
		],
		[
			"sidecar only",
			{ present: false, valid: false },
			{ present: true, valid: true, value: sidecarValue(old) },
			undefined,
			undefined,
		],
	];
	for (const [name, target, sidecar, expectedOld, classification] of cases) {
		test(name, () => {
			expect(classifyInstallerSnapshot(target, sidecar, candidate, installedPath, expectedOld)).toBe(classification);
		});
	}
});
