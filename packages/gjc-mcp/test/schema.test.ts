import { describe, expect, test } from "bun:test";
import {
	type ConfigV1,
	canonicalPolicyJson,
	isConfigV1,
	isManifestV1,
	isStateV1,
	OFFICIAL_UPSTREAM_URL,
	PUBLIC_FORK_URL,
	policySha256,
	preservesObservedTagHistory,
	RUNTIME_PATCH_BRANCH,
	RUNTIME_PATCH_PATHS,
	RUNTIME_POLICY_ID,
	type StateV1,
	UPDATER_POLICY_ID,
	UPDATER_SOURCE_BRANCH,
	UPDATER_SOURCE_PATHS,
} from "../src/schema";

const H40_A = "a".repeat(40);
const H40_B = "b".repeat(40);
const H64_A = "a".repeat(64);
const NOW = "2026-07-10T00:00:00Z";
const RUNTIME_POLICY_SHA256 = "06b36379cdd81ad725451717051bf497e3376d7ebe580d23b3040f0c806d67e0";
const UPDATER_POLICY_SHA256 = "94b553b6f37e10c0f64e171bd97e542afdff5a48b6100ca33218670684e64ba5";

function config(): ConfigV1 {
	return {
		schema: 1,
		upstreamUrl: OFFICIAL_UPSTREAM_URL,
		forkUrl: PUBLIC_FORK_URL,
		upstreamTagPolicy: "official-stable-reachable-v1",
		signerPolicy: "origin-history-and-pins-v1",
		bootstrapArtifacts: {
			bunSha256: H64_A,
			fallbackSha256: "b".repeat(64),
			baselineNativeAddonSha256: "c".repeat(64),
		},
		runtimePatchPolicies: {
			[RUNTIME_POLICY_ID]: {
				schema: 1,
				id: RUNTIME_POLICY_ID,
				paths: [...RUNTIME_PATCH_PATHS].sort(),
				sha256: RUNTIME_POLICY_SHA256,
			},
		},
		updaterSourcePolicies: {
			[UPDATER_POLICY_ID]: {
				schema: 1,
				id: UPDATER_POLICY_ID,
				paths: [...UPDATER_SOURCE_PATHS].sort(),
				sha256: UPDATER_POLICY_SHA256,
			},
		},
		approvedRuntimePatchTips: {},
		approvedUpdaterSources: {},
	};
}

function state(): StateV1 {
	return {
		schema: 1,
		state: "official-managed",
		activeRelease: H64_A,
		previousRelease: null,
		observedUpstreamTags: { "v0.9.6": { tagObject: null, commit: H40_A } },
		originalBun: { path: "/synthetic/.bun/bin/gjc", version: "0.9.6", sha256: H64_A },
		launcherSha256: H64_A,
		lastRun: null,
	};
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

describe("ConfigV1 trust roots", () => {
	test("has no approvedTags field and accepts only the fixed source identities", () => {
		const valid = config();
		expect(isConfigV1(valid)).toBeTrue();
		expect("approvedTags" in valid).toBeFalse();

		const mutations: Array<(value: any) => void> = [
			value => {
				value.bootstrapArtifacts.bunSha256 = "short";
			},
			value => {
				value.approvedTags = {};
			},
			value => {
				value.upstreamUrl = "https://example.invalid/gajae-code.git";
			},
			value => {
				value.forkUrl = "git@github.com:attacker/gajae-code.git";
			},
			value => {
				value.approvedRuntimePatchTips[H40_A] = {
					mergeBase: H40_B,
					branch: "main",
					runtimePolicySha256: H64_A,
					approvedAt: NOW,
				};
			},
			value => {
				value.approvedUpdaterSources[H40_A] = {
					mergeBase: H40_B,
					branch: "main",
					updaterPolicySha256: H64_A,
					artifactSha256: H64_A,
					approvedAt: NOW,
				};
			},
		];
		for (const mutate of mutations) {
			const candidate = clone(valid) as any;
			mutate(candidate);
			expect(isConfigV1(candidate)).toBeFalse();
		}
		expect(RUNTIME_PATCH_BRANCH).toBe("standalone-mcp-autoload");
		expect(UPDATER_SOURCE_BRANCH).toBe("gjc-mcp-controller-v1");
	});

	test("binds the complete current allowlists to independently pinned canonical hashes", () => {
		const valid = config();
		const runtime = valid.runtimePatchPolicies[RUNTIME_POLICY_ID];
		const updater = valid.updaterSourcePolicies[UPDATER_POLICY_ID];
		expect(policySha256(runtime)).toBe(RUNTIME_POLICY_SHA256);
		expect(policySha256(updater)).toBe(UPDATER_POLICY_SHA256);
		expect(canonicalPolicyJson(runtime)).toBe(
			JSON.stringify({ schema: 1, id: RUNTIME_POLICY_ID, paths: [...RUNTIME_PATCH_PATHS].sort() }),
		);
		expect(canonicalPolicyJson(updater)).toBe(
			JSON.stringify({ schema: 1, id: UPDATER_POLICY_ID, paths: [...UPDATER_SOURCE_PATHS].sort() }),
		);

		for (const mutate of [
			(value: any) => value.runtimePatchPolicies[RUNTIME_POLICY_ID].paths.pop(),
			(value: any) => value.updaterSourcePolicies[UPDATER_POLICY_ID].paths.reverse(),
			(value: any) => {
				value.runtimePatchPolicies[RUNTIME_POLICY_ID].paths[0] = "../escape";
			},
			(value: any) => {
				value.updaterSourcePolicies[UPDATER_POLICY_ID].sha256 = H64_A;
			},
		]) {
			const candidate = clone(valid) as any;
			mutate(candidate);
			expect(isConfigV1(candidate)).toBeFalse();
		}
	});

	test("rejects unknown fields and truncated or extended object hashes at every pin boundary", () => {
		const base = config();
		base.approvedRuntimePatchTips[H40_A] = {
			mergeBase: H40_B,
			branch: RUNTIME_PATCH_BRANCH,
			runtimePolicySha256: RUNTIME_POLICY_SHA256,
			approvedAt: NOW,
		};
		base.approvedUpdaterSources[H40_A] = {
			mergeBase: H40_B,
			branch: UPDATER_SOURCE_BRANCH,
			updaterPolicySha256: UPDATER_POLICY_SHA256,
			artifactSha256: H64_A,
			approvedAt: NOW,
		};
		expect(isConfigV1(base)).toBeTrue();
		for (const mutate of [
			(value: any) => {
				value.unknown = true;
			},
			(value: any) => {
				value.approvedRuntimePatchTips[H40_A].unknown = true;
			},
			(value: any) => {
				value.approvedRuntimePatchTips[H40_A].mergeBase = H40_B.slice(1);
			},
			(value: any) => {
				value.approvedUpdaterSources[H40_A].artifactSha256 += "0";
			},
			(value: any) => {
				value.approvedUpdaterSources[H40_A.slice(1)] = value.approvedUpdaterSources[H40_A];
				delete value.approvedUpdaterSources[H40_A];
			},
		]) {
			const candidate = clone(base) as any;
			mutate(candidate);
			expect(isConfigV1(candidate)).toBeFalse();
		}
	});
});

describe("state identity history", () => {
	test("requires append-only observed tag identities", () => {
		const previous = state();
		const appended = clone(previous);
		appended.observedUpstreamTags["v0.9.7"] = { tagObject: H40_B, commit: H40_B };
		expect(preservesObservedTagHistory(previous, appended)).toBeTrue();

		const removed = clone(previous);
		delete removed.observedUpstreamTags["v0.9.6"];
		const retargeted = clone(previous);
		retargeted.observedUpstreamTags["v0.9.6"] = { tagObject: H40_B, commit: H40_B };
		expect(preservesObservedTagHistory(previous, removed)).toBeFalse();
		expect(preservesObservedTagHistory(previous, retargeted)).toBeFalse();
	});

	test("pins the captured Bun fallback to exactly v0.9.6", () => {
		const valid = state();
		expect(isStateV1(valid)).toBeTrue();
		for (const version of ["0.9.5", "0.9.7", "v0.9.6", "0.9.6+local"]) {
			const candidate = clone(valid) as any;
			candidate.originalBun.version = version;
			expect(isStateV1(candidate)).toBeFalse();
		}
	});

	test("accepts only a self-consistent stable v0.9.6 manifest identity", () => {
		const manifest: any = {
			schema: 1,
			releaseId: H64_A,
			kind: "official",
			version: "0.9.6",
			upstreamTag: "v0.9.6",
			tagObject: null,
			upstreamCommit: H40_A,
			patchBase: null,
			patchTip: null,
			runtimePolicySha256: null,
			tree: H40_B,
			artifact: { path: "bin/gjc", sha256: H64_A, size: 1, mode: 0o755 },
			build: { bunVersion: "1.2.0", lockSha256: H64_A, commandId: "coding-agent-build-v1" },
			probeContract: 1,
			createdAt: NOW,
		};
		expect(isManifestV1(manifest)).toBeTrue();
		for (const [field, value] of [
			["version", "0.9.6-rc.1"],
			["upstreamTag", "v0.9.7"],
			["upstreamCommit", H40_A.slice(1)],
		]) {
			const candidate = clone(manifest);
			candidate[field] = value;
			expect(isManifestV1(candidate)).toBeFalse();
		}
	});
});
