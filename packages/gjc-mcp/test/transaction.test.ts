import { afterEach, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveUpdaterPaths, type UpdaterPaths } from "../src/paths";
import { type ManifestV1, type StateV1, serializeManifestV1 } from "../src/schema";
import { bootstrap, check, rollback, status, type TransactionPhase, update } from "../src/transaction";

const roots: string[] = [];
const ZERO = "0".repeat(64);
function digest(value: string | Uint8Array): string {
	return crypto.createHash("sha256").update(value).digest("hex");
}

async function fixture(): Promise<{
	paths: UpdaterPaths;
	fallback: ManifestV1;
	first: ManifestV1;
	second: ManifestV1;
	state: StateV1;
}> {
	const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-transaction-"));
	const home = await fs.realpath(temporaryHome);
	roots.push(home);
	const paths = resolveUpdaterPaths({ HOME: home });
	await fs.mkdir(paths.releasesRoot, { recursive: true, mode: 0o700 });
	await fs.mkdir(paths.binRoot, { recursive: true, mode: 0o700 });
	await fs.mkdir(paths.stateRoot, { recursive: true, mode: 0o700 });
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
	await fs.mkdir(path.dirname(paths.bunFallbackPath), { recursive: true, mode: 0o700 });
	await fs.writeFile(fallbackTarget, "synthetic-bun-fallback", { mode: 0o755 });
	await fs.chmod(fallbackTarget, 0o755);
	await fs.symlink(fallbackTarget, paths.bunFallbackPath);
	const make = async (version: string, kind: ManifestV1["kind"], byte: string): Promise<ManifestV1> => {
		const artifact = new TextEncoder().encode(byte);
		const base: ManifestV1 = {
			schema: 1,
			releaseId: ZERO,
			kind,
			version,
			upstreamTag: `v${version}`,
			tagObject: null,
			upstreamCommit: version === "0.9.6" ? "aedd0df99e7c9dff420b50f7ff47bd6645627bdd" : "1".repeat(40),
			patchBase: null,
			patchTip: null,
			runtimePolicySha256: null,
			tree: version === "0.9.6" ? "aedd0df99e7c9dff420b50f7ff47bd6645627bdd" : "1".repeat(40),
			artifact: { path: "bin/gjc", sha256: digest(artifact), size: artifact.length, mode: 0o755 },
			build: { bunVersion: "1.2.0", lockSha256: ZERO, commandId: "coding-agent-build-v1" },
			probeContract: 1,
			createdAt: "2026-07-10T00:00:00.000Z",
		};
		base.releaseId = digest(JSON.stringify({ ...base, releaseId: ZERO }));
		const root = path.join(paths.releasesRoot, base.releaseId);
		await fs.mkdir(path.join(root, "bin"), { recursive: true, mode: 0o700 });
		await Bun.write(path.join(root, "bin/gjc"), artifact);
		await fs.chmod(path.join(root, "bin/gjc"), 0o755);
		await Bun.write(path.join(root, "manifest.json"), serializeManifestV1(base));
		await fs.chmod(path.join(root, "manifest.json"), 0o600);
		return base;
	};
	const fallback = await make("0.9.6", "bun-fallback", "fallback");
	const first = await make("0.9.6", "official", "first");
	const second = await make("0.9.7", "official", "second");
	const state: StateV1 = {
		schema: 1,
		state: "installing",
		activeRelease: null,
		previousRelease: null,
		observedUpstreamTags: {},
		originalBun: { path: paths.bunFallbackPath, version: "0.9.6", sha256: digest("synthetic-bun-fallback") },
		launcherSha256: null,
		lastRun: null,
	};
	return { paths, fallback, first, second, state };
}

async function installed() {
	const value = await fixture();
	const result = await bootstrap({
		paths: value.paths,
		prepareBootstrap: async () => ({
			fallback: value.fallback,
			candidate: value.first,
			state: value.state,
			launcherBytes: new TextEncoder().encode("launcher"),
		}),
		verifyBinary: async () => true,
	});
	expect(result.code).toBe("GJC_MCP_OK");
	return value;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("journal phase fault injection and recovery", () => {
	const bootstrapPhases = [
		"prepared",
		"previous-written",
		"current-written",
		"prelaunch-verified",
		"launcher-written",
		"post-verified",
		"state-written",
	] satisfies TransactionPhase[];
	for (const phase of bootstrapPhases) {
		test(`bootstrap fault after ${phase} recovers on bootstrap`, async () => {
			const value = await fixture();
			const prepareBootstrap = async () => ({
				fallback: value.fallback,
				candidate: value.first,
				state: value.state,
				launcherBytes: new TextEncoder().encode("launcher"),
			});
			const failed = await bootstrap({
				paths: value.paths,
				prepareBootstrap,
				verifyBinary: async () => true,
				faults: {
					afterPhase: seen => {
						if (seen === phase) throw new Error("fault");
					},
				},
			});
			expect(failed.code).not.toBe("GJC_MCP_OK");
			expect(await Bun.file(value.paths.journalPath).exists()).toBe(true);

			const recoveryVerified: string[] = [];
			const recovered = await bootstrap({
				paths: value.paths,
				prepareBootstrap,
				verifyBinary: async release => {
					recoveryVerified.push(release.releaseId);
					return true;
				},
			});
			expect(recovered).toMatchObject({ code: "GJC_MCP_OK", changed: true });
			expect(await Bun.file(value.paths.journalPath).exists()).toBe(false);
			expect(await fs.readlink(value.paths.currentPath)).toBe(`releases/${value.first.releaseId}`);
			expect(await fs.readlink(value.paths.previousPath)).toBe(`releases/${value.fallback.releaseId}`);
			expect(JSON.parse(await Bun.file(value.paths.statePath).text())).toMatchObject({
				activeRelease: value.first.releaseId,
				previousRelease: value.fallback.releaseId,
			});
			expect(await Bun.file(value.paths.launcherPath).text()).toBe("launcher");
			expect(recoveryVerified).toContain(value.first.releaseId);
		});
	}

	const transactionPhases = [
		"prepared",
		"previous-written",
		"current-written",
		"post-verified",
		"state-written",
	] satisfies TransactionPhase[];
	for (const operation of ["update", "rollback"] as const)
		for (const phase of transactionPhases) {
			test(`${operation} fault after ${phase} recovers on the next ${operation} call`, async () => {
				const value = await installed();
				const faults = {
					afterPhase: (seen: TransactionPhase) => {
						if (seen === phase) throw new Error("fault");
					},
				};
				const failed =
					operation === "update"
						? await update({
								paths: value.paths,
								prepareUpdate: async () => ({
									release: value.second,
									selectedTag: { name: "v0.9.7", identity: { tagObject: null, commit: "1".repeat(40) } },
								}),
								verifyBinary: async () => true,
								faults,
							})
						: await rollback({ paths: value.paths, verifyBinary: async () => true, faults });
				expect(failed.code).not.toBe("GJC_MCP_OK");
				expect(await Bun.file(value.paths.journalPath).exists()).toBe(true);

				const recoveryVerified: string[] = [];
				const verifyBinary = async (release: ManifestV1) => {
					recoveryVerified.push(release.releaseId);
					return true;
				};
				const recovered =
					operation === "update"
						? await update({
								paths: value.paths,
								prepareUpdate: async () => ({
									release: value.second,
									selectedTag: {
										name: "v0.9.7",
										identity: { tagObject: null, commit: "1".repeat(40) },
									},
								}),
								verifyBinary,
							})
						: await rollback({ paths: value.paths, verifyBinary });
				expect(recovered).toMatchObject({ code: "GJC_MCP_OK", changed: true });
				expect(await Bun.file(value.paths.journalPath).exists()).toBe(false);
				const expectedCurrent = operation === "update" ? value.second.releaseId : value.fallback.releaseId;
				expect(await fs.readlink(value.paths.currentPath)).toBe(`releases/${expectedCurrent}`);
				expect(await fs.readlink(value.paths.previousPath)).toBe(`releases/${value.first.releaseId}`);
				expect(JSON.parse(await Bun.file(value.paths.statePath).text())).toMatchObject({
					activeRelease: expectedCurrent,
					previousRelease: value.first.releaseId,
				});
				expect(recoveryVerified).toContain(expectedCurrent);
			});
		}
});

test("commit-forward recovery retains its journal when the previous release is corrupt", async () => {
	const value = await installed();
	await update({
		paths: value.paths,
		prepareUpdate: async () => ({
			release: value.second,
			selectedTag: { name: "v0.9.7", identity: { tagObject: null, commit: "1".repeat(40) } },
		}),
		verifyBinary: async () => true,
		faults: {
			afterPhase: phase => {
				if (phase === "state-written") throw new Error("fault");
			},
		},
	});
	await Bun.write(path.join(value.paths.releasesRoot, value.first.releaseId, "bin/gjc"), "corrupt");

	const recovered = await update({
		paths: value.paths,
		prepareUpdate: async () => {
			throw new Error("must not continue after failed recovery validation");
		},
		verifyBinary: async () => true,
	});
	expect(recovered).toMatchObject({ code: "GJC_MCP_E_RESTORE_FAILED", changed: false });
	expect(await Bun.file(value.paths.journalPath).exists()).toBe(true);
});

test("injected candidate verifier failure precedes the journal and preserves installed bytes", async () => {
	const value = await installed();
	const before = await snapshot(value.paths);
	const result = await update({
		paths: value.paths,
		prepareUpdate: async () => ({
			release: value.second,
			selectedTag: { name: "v0.9.7", identity: { tagObject: null, commit: "1".repeat(40) } },
		}),
		verifyBinary: async release => release.releaseId !== value.second.releaseId,
	});
	expect(result).toMatchObject({ code: "GJC_MCP_E_VERIFY", changed: false });
	expect(await snapshot(value.paths)).toEqual(before);
});

test("post-flip verifier failure restores current, previous, state, launcher, and removes journal", async () => {
	const value = await installed();
	const before = await snapshot(value.paths);
	let candidateVerifications = 0;
	const result = await update({
		paths: value.paths,
		prepareUpdate: async () => ({
			release: value.second,
			selectedTag: { name: "v0.9.7", identity: { tagObject: null, commit: "1".repeat(40) } },
		}),
		verifyBinary: async release => release.releaseId !== value.second.releaseId || ++candidateVerifications < 2,
	});
	expect(result).toMatchObject({ code: "GJC_MCP_E_VERIFY", changed: false });
	expect(await snapshot(value.paths)).toEqual(before);
});
test("state-write failure after the flip restores verified old bytes and removes the journal", async () => {
	const value = await installed();
	const before = await snapshot(value.paths);
	const backup = `${value.paths.statePath}.test-backup`;
	let candidateVerifications = 0;
	let sabotaged = false;
	const result = await update({
		paths: value.paths,
		prepareUpdate: async () => ({
			release: value.second,
			selectedTag: { name: "v0.9.7", identity: { tagObject: null, commit: "1".repeat(40) } },
		}),
		verifyBinary: async release => {
			if (release.releaseId === value.second.releaseId && ++candidateVerifications === 2) {
				await fs.rename(value.paths.statePath, backup);
				await fs.mkdir(value.paths.statePath);
				sabotaged = true;
			} else if (release.releaseId === value.first.releaseId && sabotaged) {
				await fs.rm(value.paths.statePath, { recursive: true });
				await fs.rename(backup, value.paths.statePath);
				sabotaged = false;
			}
			return true;
		},
	});
	expect(result).toMatchObject({ code: "GJC_MCP_E_VERIFY", changed: false });
	expect(sabotaged).toBe(false);
	expect(await snapshot(value.paths)).toEqual(before);
});

test("a corrupt failed candidate cannot prevent restoration of the verified old release", async () => {
	const value = await installed();
	await update({
		paths: value.paths,
		prepareUpdate: async () => ({
			release: value.second,
			selectedTag: { name: "v0.9.7", identity: { tagObject: null, commit: "1".repeat(40) } },
		}),
		verifyBinary: async () => true,
		faults: {
			afterPhase: phase => {
				if (phase === "current-written") throw new Error("fault");
			},
		},
	});
	await Bun.write(path.join(value.paths.releasesRoot, value.second.releaseId, "bin/gjc"), "corrupt");
	const verified: string[] = [];
	const recovered = await rollback({
		paths: value.paths,
		verifyBinary: async release => {
			verified.push(release.releaseId);
			return release.releaseId !== value.second.releaseId;
		},
	});
	expect(recovered).toMatchObject({ code: "GJC_MCP_OK", changed: true });
	expect(verified).toContain(value.first.releaseId);
	expect(verified).not.toContain(value.second.releaseId);
	expect(await fs.readlink(value.paths.currentPath)).toBe(`releases/${value.fallback.releaseId}`);
	expect(await fs.readlink(value.paths.previousPath)).toBe(`releases/${value.first.releaseId}`);
});

test("check recovers an interrupted transaction and continues candidate discovery", async () => {
	const value = await installed();
	await update({
		paths: value.paths,
		prepareUpdate: async () => ({
			release: value.second,
			selectedTag: { name: "v0.9.7", identity: { tagObject: null, commit: "1".repeat(40) } },
		}),
		verifyBinary: async () => true,
		faults: {
			afterPhase: phase => {
				if (phase === "current-written") throw new Error("fault");
			},
		},
	});
	let prepared = false;
	const result = await check({
		paths: value.paths,
		prepareUpdate: async () => {
			prepared = true;
			return {
				release: value.second,
				selectedTag: {
					name: "v0.9.7",
					identity: { tagObject: null, commit: "1".repeat(40) },
				},
			};
		},
		verifyBinary: async () => true,
	});
	expect(result).toMatchObject({ code: "GJC_MCP_OK", changed: true, candidate: "0.9.7" });
	expect(prepared).toBe(true);
	expect(await Bun.file(value.paths.journalPath).exists()).toBe(false);
});
test("check is byte-for-byte read-only and reports a candidate", async () => {
	const value = await installed();
	const before = await snapshot(value.paths);
	const result = await check({
		paths: value.paths,
		prepareUpdate: async () => ({
			release: value.second,
			selectedTag: { name: "v0.9.7", identity: { tagObject: null, commit: "1".repeat(40) } },
		}),
	});
	expect(result).toMatchObject({ code: "GJC_MCP_OK", changed: false, candidate: "0.9.7" });
	expect(await snapshot(value.paths)).toEqual(before);
});

test("prepare failure leaves current immutable", async () => {
	const value = await installed();
	const before = await snapshot(value.paths);
	const result = await update({
		paths: value.paths,
		prepareUpdate: async () => {
			throw new Error("build failed");
		},
	});
	expect(result).toEqual({ code: "GJC_MCP_E_VERIFY", changed: false });
	expect(await snapshot(value.paths)).toEqual(before);
});

test("rollback swaps current and previous while preserving observed tag history", async () => {
	const value = await installed();
	await update({
		paths: value.paths,
		prepareUpdate: async () => ({
			release: value.second,
			selectedTag: { name: "v0.9.7", identity: { tagObject: null, commit: "1".repeat(40) } },
		}),
		verifyBinary: async () => true,
	});
	const result = await rollback({ paths: value.paths, verifyBinary: async () => true });
	expect(result.code).toBe("GJC_MCP_OK");
	expect(await fs.readlink(value.paths.currentPath)).toContain(value.first.releaseId);
	const state = JSON.parse(await Bun.file(value.paths.statePath).text()) as StateV1;
	expect(state.observedUpstreamTags["v0.9.7"]?.commit).toBe("1".repeat(40));
});

test("status performs no writes", async () => {
	const value = await installed();
	const before = await snapshot(value.paths);
	expect((await status({ paths: value.paths })).code).toBe("GJC_MCP_OK");
	expect(await snapshot(value.paths)).toEqual(before);
});

async function snapshot(paths: UpdaterPaths): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	for (const [name, file] of Object.entries({
		current: paths.currentPath,
		previous: paths.previousPath,
		state: paths.statePath,
		journal: paths.journalPath,
		launcher: paths.launcherPath,
	})) {
		try {
			result[name] = (await fs.lstat(file)).isSymbolicLink()
				? await fs.readlink(file)
				: digest(new Uint8Array(await Bun.file(file).arrayBuffer()));
		} catch {
			result[name] = "absent";
		}
	}
	return result;
}
