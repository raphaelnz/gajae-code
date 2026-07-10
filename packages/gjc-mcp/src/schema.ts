import * as crypto from "node:crypto";
import * as path from "node:path";
import type { StableCode } from "./diagnostics";
import { isStableCode } from "./diagnostics";
import { EXECUTABLE_MODE } from "./paths";

export type Hex40 = string;
export type Hex64 = string;
export type ISO8601 = string;

export const SCHEMA_VERSION = 1;
export const OFFICIAL_UPSTREAM_URL = "https://github.com/Yeachan-Heo/gajae-code.git" as const;
export const PUBLIC_FORK_URL = "git@github.com:raphaelnz/gajae-code.git" as const;
export const UPSTREAM_TAG_POLICY = "official-stable-reachable-v1" as const;
export const SIGNER_POLICY = "origin-history-and-pins-v1" as const;
export const RUNTIME_POLICY_ID = "runtime-autoload-v1" as const;
export const UPDATER_POLICY_ID = "gjc-mcp-controller-v1" as const;
export const RUNTIME_PATCH_BRANCH = "standalone-mcp-autoload" as const;
export const UPDATER_SOURCE_BRANCH = "gjc-mcp-controller-v1" as const;
export const BUILD_COMMAND_ID = "coding-agent-build-v1" as const;
export const V1_NON_GOALS = [
	"project-mcp",
	"cache-guarantees",
	"subsession-mcp",
	"live-catalog-mutation",
	"updater-self-update",
	"profile-edits",
	"uninstall",
	"automatic-retirement",
	"npm-publication",
] as const;

export const RUNTIME_PATCH_PATHS = [
	"docs/aside-integration.md",
	"docs/standalone-mcp.md",
	"packages/coding-agent/src/capability/index.ts",
	"packages/coding-agent/src/capability/types.ts",
	"packages/coding-agent/src/config/mcp-schema.json",
	"packages/coding-agent/src/internal-urls/docs-index.generated.ts",
	"packages/coding-agent/src/cli/mcp-cli.ts",
	"packages/coding-agent/src/commands/mcp.ts",
	"packages/coding-agent/src/discovery/builtin.ts",
	"packages/coding-agent/src/main.ts",
	"packages/coding-agent/src/runtime-mcp/config.ts",
	"packages/coding-agent/src/runtime-mcp/loader.ts",
	"packages/coding-agent/src/runtime-mcp/manager.ts",
	"packages/coding-agent/src/runtime-mcp/types.ts",
	"packages/coding-agent/src/runtime-mcp/client.ts",
	"packages/coding-agent/src/runtime-mcp/transports/http.ts",
	"packages/coding-agent/src/sdk.ts",
	"packages/coding-agent/src/task/executor.ts",
	"packages/coding-agent/src/task/index.ts",
	"packages/coding-agent/src/tools/index.ts",
	"packages/coding-agent/test/acp-mcp-isolation.test.ts",
	"packages/coding-agent/test/gjc-plugin-mcp-session.test.ts",
	"packages/coding-agent/test/gjc-runtime/launch-tmux.test.ts",
	"packages/coding-agent/test/mcp-lifecycle-cleanup.test.ts",
	"packages/coding-agent/test/mcp-manager-subscription-action.test.ts",
	"packages/coding-agent/test/mcp-cli.test.ts",
	"packages/coding-agent/test/mcp-test-utils.ts",
	"packages/coding-agent/test/sdk-mcp-discovery.test.ts",
	"packages/coding-agent/test/sdk-mcp-session-isolation.test.ts",
	"packages/coding-agent/test/sdk-session-isolation.test.ts",
	"packages/coding-agent/test/standalone-mcp-auth-e2e.test.ts",
	"packages/coding-agent/test/standalone-mcp-mode-isolation.test.ts",
	"packages/coding-agent/test/runtime-mcp/transport-lifecycle.test.ts",
] as const;

export const UPDATER_SOURCE_PATHS = [
	"bun.lock",
	"packages/gjc-mcp/package.json",
	"packages/gjc-mcp/tsconfig.json",
	"packages/gjc-mcp/scripts/build-binary.ts",
	"packages/gjc-mcp/scripts/install.ts",
	"packages/gjc-mcp/src/diagnostics.ts",
	"packages/gjc-mcp/src/git.ts",
	"packages/gjc-mcp/src/lock.ts",
	"packages/gjc-mcp/src/main.ts",
	"packages/gjc-mcp/src/paths.ts",
	"packages/gjc-mcp/src/probe.ts",
	"packages/gjc-mcp/src/release.ts",
	"packages/gjc-mcp/src/schema.ts",
	"packages/gjc-mcp/src/transaction.ts",
	"packages/gjc-mcp/test/bootstrap-e2e.test.ts",
	"packages/gjc-mcp/test/cli.test.ts",
	"packages/gjc-mcp/test/git-trust.test.ts",
	"packages/gjc-mcp/test/paths.test.ts",
	"packages/gjc-mcp/test/redaction.redteam.test.ts",
	"packages/gjc-mcp/test/schema.test.ts",
	"packages/gjc-mcp/test/transaction.test.ts",
	"packages/gjc-mcp/test/update-e2e.test.ts",
] as const;

export interface RuntimePatchPolicyV1 {
	schema: 1;
	id: typeof RUNTIME_POLICY_ID;
	paths: string[];
	sha256: Hex64;
}

export interface UpdaterSourcePolicyV1 {
	schema: 1;
	id: typeof UPDATER_POLICY_ID;
	paths: string[];
	sha256: Hex64;
}

export interface UpdaterInstallV1 {
	schema: 1;
	installedPath: string;
	artifactSha256: Hex64;
	sourceCommit: Hex40;
	updaterPathPolicySha256: Hex64;
	ownerUid: number;
	mode: 493;
	installedAt: ISO8601;
}

export interface TagIdentityV1 {
	tagObject: Hex40 | null;
	commit: Hex40;
}

export interface RuntimePatchApprovalV1 {
	mergeBase: Hex40;
	branch: typeof RUNTIME_PATCH_BRANCH;
	runtimePolicySha256: Hex64;
	approvedAt: ISO8601;
}

export interface UpdaterSourceApprovalV1 {
	mergeBase: Hex40;
	branch: typeof UPDATER_SOURCE_BRANCH;
	updaterPolicySha256: Hex64;
	artifactSha256: Hex64;
	approvedAt: ISO8601;
}

export interface BootstrapArtifactsV1 {
	bunSha256: Hex64;
	fallbackSha256: Hex64;
	baselineNativeAddonSha256: Hex64;
}

export interface ConfigV1 {
	schema: 1;
	upstreamUrl: typeof OFFICIAL_UPSTREAM_URL;
	forkUrl: typeof PUBLIC_FORK_URL;
	upstreamTagPolicy: typeof UPSTREAM_TAG_POLICY;
	signerPolicy: typeof SIGNER_POLICY;
	bootstrapArtifacts: BootstrapArtifactsV1;
	runtimePatchPolicies: { "runtime-autoload-v1": RuntimePatchPolicyV1 };
	updaterSourcePolicies: { "gjc-mcp-controller-v1": UpdaterSourcePolicyV1 };
	approvedRuntimePatchTips: Record<Hex40, RuntimePatchApprovalV1>;
	approvedUpdaterSources: Record<Hex40, UpdaterSourceApprovalV1>;
}

export interface ManifestV1 {
	schema: 1;
	releaseId: Hex64;
	kind: "patched" | "official" | "bun-fallback";
	version: string;
	upstreamTag: string;
	tagObject: Hex40 | null;
	upstreamCommit: Hex40;
	patchBase: Hex40 | null;
	patchTip: Hex40 | null;
	runtimePolicySha256: Hex64 | null;
	tree: Hex40;
	artifact: { path: "bin/gjc"; sha256: Hex64; size: number; mode: 493 };
	build: { bunVersion: string; lockSha256: Hex64; commandId: typeof BUILD_COMMAND_ID };
	probeContract: 1;
	createdAt: ISO8601;
}

export interface StateV1 {
	schema: 1;
	state: "installing" | "patched-managed" | "official-managed";
	activeRelease: Hex64 | null;
	previousRelease: Hex64 | null;
	observedUpstreamTags: Record<string, TagIdentityV1>;
	originalBun: { path: string; version: "0.9.6"; sha256: Hex64 };
	launcherSha256: Hex64 | null;
	lastRun: {
		runId: string;
		command: "install" | "update" | "check" | "rollback";
		code: StableCode;
		at: ISO8601;
	} | null;
}

export interface JournalV1 {
	schema: 1;
	runId: string;
	operation: "bootstrap" | "update" | "rollback";
	phase:
		| "prepared"
		| "previous-written"
		| "current-written"
		| "prelaunch-verified"
		| "launcher-written"
		| "post-verified"
		| "state-written";
	oldCurrent: Hex64 | null;
	oldPrevious: Hex64 | null;
	newCurrent: Hex64;
	newPrevious: Hex64;
	selectedTag: { name: string; identity: TagIdentityV1 } | null;
	launcherExpectedSha256: Hex64;
	startedAt: ISO8601;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: "invalid-json" | "invalid-schema" };

type JsonObject = Record<string, unknown>;
type Validator<T> = (value: unknown) => value is T;

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const STABLE_TAG = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

export function isHex40(value: unknown): value is Hex40 {
	return typeof value === "string" && HEX40.test(value);
}

export function isHex64(value: unknown): value is Hex64 {
	return typeof value === "string" && HEX64.test(value);
}

export function isISO8601(value: unknown): value is ISO8601 {
	return typeof value === "string" && ISO_8601.test(value) && !Number.isNaN(Date.parse(value));
}

export function isStableTag(value: unknown): value is string {
	return typeof value === "string" && STABLE_TAG.test(value);
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: JsonObject, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
	return typeof value === "string" && values.includes(value as T);
}

function isNullable<T>(value: unknown, validator: Validator<T>): value is T | null {
	return value === null || validator(value);
}

function isSafeId(value: unknown): value is string {
	return typeof value === "string" && SAFE_ID.test(value);
}

function isPolicyPath(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value !== value.normalize("NFC")) return false;
	if (!/^[\x20-\x7e]+$/.test(value) || value.includes("\\") || path.posix.isAbsolute(value)) return false;
	const segments = value.split("/");
	return segments.every(segment => segment !== "" && segment !== "." && segment !== "..");
}

function areCanonicalPaths(value: unknown, expected: readonly string[]): value is string[] {
	if (!Array.isArray(value) || !value.every(isPolicyPath)) return false;
	const sorted = [...value].sort();
	if (!value.every((entry, index) => entry === sorted[index])) return false;
	if (new Set(value.map(entry => entry.toLowerCase())).size !== value.length) return false;
	return value.length === expected.length && value.every((entry, index) => entry === [...expected].sort()[index]);
}

export function isRuntimePatchPolicyV1(value: unknown): value is RuntimePatchPolicyV1 {
	return (
		isObject(value) &&
		hasExactKeys(value, ["schema", "id", "paths", "sha256"]) &&
		value.schema === 1 &&
		value.id === RUNTIME_POLICY_ID &&
		areCanonicalPaths(value.paths, RUNTIME_PATCH_PATHS) &&
		isHex64(value.sha256)
	);
}

export function isUpdaterSourcePolicyV1(value: unknown): value is UpdaterSourcePolicyV1 {
	return (
		isObject(value) &&
		hasExactKeys(value, ["schema", "id", "paths", "sha256"]) &&
		value.schema === 1 &&
		value.id === UPDATER_POLICY_ID &&
		areCanonicalPaths(value.paths, UPDATER_SOURCE_PATHS) &&
		isHex64(value.sha256)
	);
}

function canonicalPolicyPayload(policy: RuntimePatchPolicyV1 | UpdaterSourcePolicyV1): string {
	return JSON.stringify({ schema: 1, id: policy.id, paths: [...policy.paths].sort() }).normalize("NFC");
}

export function canonicalPolicyJson(policy: RuntimePatchPolicyV1 | UpdaterSourcePolicyV1): string {
	return canonicalPolicyPayload(policy);
}

export function canonicalPolicyBytes(policy: RuntimePatchPolicyV1 | UpdaterSourcePolicyV1): Uint8Array {
	return new TextEncoder().encode(canonicalPolicyPayload(policy));
}

export function policySha256(policy: RuntimePatchPolicyV1 | UpdaterSourcePolicyV1): Hex64 {
	return crypto.createHash("sha256").update(canonicalPolicyBytes(policy)).digest("hex");
}

export function hasValidPolicyHash(policy: RuntimePatchPolicyV1 | UpdaterSourcePolicyV1): boolean {
	return policy.sha256 === policySha256(policy);
}

export function isUpdaterInstallV1(value: unknown): value is UpdaterInstallV1 {
	return (
		isObject(value) &&
		hasExactKeys(value, [
			"schema",
			"installedPath",
			"artifactSha256",
			"sourceCommit",
			"updaterPathPolicySha256",
			"ownerUid",
			"mode",
			"installedAt",
		]) &&
		value.schema === 1 &&
		typeof value.installedPath === "string" &&
		path.isAbsolute(value.installedPath) &&
		value.installedPath.endsWith("/.local/bin/gjc-mcp") &&
		isHex64(value.artifactSha256) &&
		isHex40(value.sourceCommit) &&
		isHex64(value.updaterPathPolicySha256) &&
		Number.isSafeInteger(value.ownerUid) &&
		(value.ownerUid as number) >= 0 &&
		value.mode === EXECUTABLE_MODE &&
		isISO8601(value.installedAt)
	);
}

export function isTagIdentityV1(value: unknown): value is TagIdentityV1 {
	return (
		isObject(value) &&
		hasExactKeys(value, ["tagObject", "commit"]) &&
		isNullable(value.tagObject, isHex40) &&
		isHex40(value.commit)
	);
}

function isRuntimeApproval(value: unknown): value is RuntimePatchApprovalV1 {
	return (
		isObject(value) &&
		hasExactKeys(value, ["mergeBase", "branch", "runtimePolicySha256", "approvedAt"]) &&
		isHex40(value.mergeBase) &&
		value.branch === RUNTIME_PATCH_BRANCH &&
		isHex64(value.runtimePolicySha256) &&
		isISO8601(value.approvedAt)
	);
}

function isUpdaterApproval(value: unknown): value is UpdaterSourceApprovalV1 {
	return (
		isObject(value) &&
		hasExactKeys(value, ["mergeBase", "branch", "updaterPolicySha256", "artifactSha256", "approvedAt"]) &&
		isHex40(value.mergeBase) &&
		value.branch === UPDATER_SOURCE_BRANCH &&
		isHex64(value.updaterPolicySha256) &&
		isHex64(value.artifactSha256) &&
		isISO8601(value.approvedAt)
	);
}

function isRecordOf<T>(
	value: unknown,
	keyValidator: (key: string) => boolean,
	validator: Validator<T>,
): value is Record<string, T> {
	return isObject(value) && Object.entries(value).every(([key, entry]) => keyValidator(key) && validator(entry));
}

function isBootstrapArtifactsV1(value: unknown): value is BootstrapArtifactsV1 {
	return (
		isObject(value) &&
		hasExactKeys(value, ["bunSha256", "fallbackSha256", "baselineNativeAddonSha256"]) &&
		isHex64(value.bunSha256) &&
		isHex64(value.fallbackSha256) &&
		isHex64(value.baselineNativeAddonSha256)
	);
}

export function isConfigV1(value: unknown): value is ConfigV1 {
	if (
		!isObject(value) ||
		!hasExactKeys(value, [
			"schema",
			"upstreamUrl",
			"forkUrl",
			"upstreamTagPolicy",
			"signerPolicy",
			"bootstrapArtifacts",
			"runtimePatchPolicies",
			"updaterSourcePolicies",
			"approvedRuntimePatchTips",
			"approvedUpdaterSources",
		])
	)
		return false;
	if (
		value.schema !== 1 ||
		value.upstreamUrl !== OFFICIAL_UPSTREAM_URL ||
		value.forkUrl !== PUBLIC_FORK_URL ||
		value.upstreamTagPolicy !== UPSTREAM_TAG_POLICY ||
		value.signerPolicy !== SIGNER_POLICY
	)
		return false;
	if (!isBootstrapArtifactsV1(value.bootstrapArtifacts)) return false;
	if (
		!isObject(value.runtimePatchPolicies) ||
		!hasExactKeys(value.runtimePatchPolicies, [RUNTIME_POLICY_ID]) ||
		!isRuntimePatchPolicyV1(value.runtimePatchPolicies[RUNTIME_POLICY_ID])
	)
		return false;
	if (
		!isObject(value.updaterSourcePolicies) ||
		!hasExactKeys(value.updaterSourcePolicies, [UPDATER_POLICY_ID]) ||
		!isUpdaterSourcePolicyV1(value.updaterSourcePolicies[UPDATER_POLICY_ID])
	)
		return false;
	return (
		hasValidPolicyHash(value.runtimePatchPolicies[RUNTIME_POLICY_ID]) &&
		hasValidPolicyHash(value.updaterSourcePolicies[UPDATER_POLICY_ID]) &&
		isRecordOf(value.approvedRuntimePatchTips, key => HEX40.test(key), isRuntimeApproval) &&
		isRecordOf(value.approvedUpdaterSources, key => HEX40.test(key), isUpdaterApproval)
	);
}

function isArtifact(value: unknown): value is ManifestV1["artifact"] {
	return (
		isObject(value) &&
		hasExactKeys(value, ["path", "sha256", "size", "mode"]) &&
		value.path === "bin/gjc" &&
		isHex64(value.sha256) &&
		Number.isSafeInteger(value.size) &&
		(value.size as number) > 0 &&
		value.mode === EXECUTABLE_MODE
	);
}

function isBuild(value: unknown): value is ManifestV1["build"] {
	return (
		isObject(value) &&
		hasExactKeys(value, ["bunVersion", "lockSha256", "commandId"]) &&
		typeof value.bunVersion === "string" &&
		value.bunVersion.length > 0 &&
		value.bunVersion.length <= 64 &&
		isHex64(value.lockSha256) &&
		value.commandId === BUILD_COMMAND_ID
	);
}

export function isManifestV1(value: unknown): value is ManifestV1 {
	if (
		!isObject(value) ||
		!hasExactKeys(value, [
			"schema",
			"releaseId",
			"kind",
			"version",
			"upstreamTag",
			"tagObject",
			"upstreamCommit",
			"patchBase",
			"patchTip",
			"runtimePolicySha256",
			"tree",
			"artifact",
			"build",
			"probeContract",
			"createdAt",
		])
	)
		return false;
	if (
		value.schema !== 1 ||
		!isHex64(value.releaseId) ||
		!isOneOf(value.kind, ["patched", "official", "bun-fallback"]) ||
		typeof value.version !== "string" ||
		!SEMVER.test(value.version) ||
		value.upstreamTag !== `v${value.version}` ||
		!isNullable(value.tagObject, isHex40) ||
		!isHex40(value.upstreamCommit) ||
		!isHex40(value.tree) ||
		!isArtifact(value.artifact) ||
		!isBuild(value.build) ||
		value.probeContract !== 1 ||
		!isISO8601(value.createdAt)
	)
		return false;
	const patched = value.kind === "patched";
	return patched
		? isHex40(value.patchBase) && isHex40(value.patchTip) && isHex64(value.runtimePolicySha256)
		: value.patchBase === null && value.patchTip === null && value.runtimePolicySha256 === null;
}

function isOriginalBun(value: unknown): value is StateV1["originalBun"] {
	return (
		isObject(value) &&
		hasExactKeys(value, ["path", "version", "sha256"]) &&
		typeof value.path === "string" &&
		path.isAbsolute(value.path) &&
		value.path.endsWith("/.bun/bin/gjc") &&
		value.version === "0.9.6" &&
		isHex64(value.sha256)
	);
}

function isLastRun(value: unknown): value is NonNullable<StateV1["lastRun"]> {
	return (
		isObject(value) &&
		hasExactKeys(value, ["runId", "command", "code", "at"]) &&
		isSafeId(value.runId) &&
		isOneOf(value.command, ["install", "update", "check", "rollback"]) &&
		isStableCode(value.code) &&
		isISO8601(value.at)
	);
}

export function isStateV1(value: unknown): value is StateV1 {
	if (
		!isObject(value) ||
		!hasExactKeys(value, [
			"schema",
			"state",
			"activeRelease",
			"previousRelease",
			"observedUpstreamTags",
			"originalBun",
			"launcherSha256",
			"lastRun",
		])
	)
		return false;
	if (
		value.schema !== 1 ||
		!isOneOf(value.state, ["installing", "patched-managed", "official-managed"]) ||
		!isNullable(value.activeRelease, isHex64) ||
		!isNullable(value.previousRelease, isHex64) ||
		!isRecordOf(value.observedUpstreamTags, key => STABLE_TAG.test(key), isTagIdentityV1) ||
		!isOriginalBun(value.originalBun) ||
		!isNullable(value.launcherSha256, isHex64) ||
		!isNullable(value.lastRun, isLastRun)
	)
		return false;
	return value.state === "installing" || (value.activeRelease !== null && value.launcherSha256 !== null);
}

function isSelectedTag(value: unknown): value is NonNullable<JournalV1["selectedTag"]> {
	return (
		isObject(value) &&
		hasExactKeys(value, ["name", "identity"]) &&
		isStableTag(value.name) &&
		isTagIdentityV1(value.identity)
	);
}

export function isJournalV1(value: unknown): value is JournalV1 {
	return (
		isObject(value) &&
		hasExactKeys(value, [
			"schema",
			"runId",
			"operation",
			"phase",
			"oldCurrent",
			"oldPrevious",
			"newCurrent",
			"newPrevious",
			"selectedTag",
			"launcherExpectedSha256",
			"startedAt",
		]) &&
		value.schema === 1 &&
		isSafeId(value.runId) &&
		isOneOf(value.operation, ["bootstrap", "update", "rollback"]) &&
		isOneOf(value.phase, [
			"prepared",
			"previous-written",
			"current-written",
			"prelaunch-verified",
			"launcher-written",
			"post-verified",
			"state-written",
		]) &&
		isNullable(value.oldCurrent, isHex64) &&
		isNullable(value.oldPrevious, isHex64) &&
		isHex64(value.newCurrent) &&
		isHex64(value.newPrevious) &&
		isNullable(value.selectedTag, isSelectedTag) &&
		isHex64(value.launcherExpectedSha256) &&
		isISO8601(value.startedAt)
	);
}

function safeParse<T>(text: string, validator: Validator<T>): ParseResult<T> {
	let value: unknown;
	try {
		value = JSON.parse(text) as unknown;
	} catch {
		return { ok: false, error: "invalid-json" };
	}
	return validator(value) ? { ok: true, value } : { ok: false, error: "invalid-schema" };
}

function safeSerialize<T>(value: T, validator: Validator<T>): string {
	if (!validator(value)) throw new TypeError("invalid schema value");
	return `${JSON.stringify(value)}\n`;
}

export const parseRuntimePatchPolicyV1 = (text: string): ParseResult<RuntimePatchPolicyV1> =>
	safeParse(text, isRuntimePatchPolicyV1);
export const parseUpdaterSourcePolicyV1 = (text: string): ParseResult<UpdaterSourcePolicyV1> =>
	safeParse(text, isUpdaterSourcePolicyV1);
export const parseUpdaterInstallV1 = (text: string): ParseResult<UpdaterInstallV1> =>
	safeParse(text, isUpdaterInstallV1);
export const parseTagIdentityV1 = (text: string): ParseResult<TagIdentityV1> => safeParse(text, isTagIdentityV1);
export const parseConfigV1 = (text: string): ParseResult<ConfigV1> => safeParse(text, isConfigV1);
export const parseManifestV1 = (text: string): ParseResult<ManifestV1> => safeParse(text, isManifestV1);
export const parseStateV1 = (text: string): ParseResult<StateV1> => safeParse(text, isStateV1);
export const parseJournalV1 = (text: string): ParseResult<JournalV1> => safeParse(text, isJournalV1);
export const serializeRuntimePatchPolicyV1 = (value: RuntimePatchPolicyV1): string =>
	safeSerialize(value, isRuntimePatchPolicyV1);
export const serializeUpdaterSourcePolicyV1 = (value: UpdaterSourcePolicyV1): string =>
	safeSerialize(value, isUpdaterSourcePolicyV1);
export const serializeUpdaterInstallV1 = (value: UpdaterInstallV1): string => safeSerialize(value, isUpdaterInstallV1);
export const serializeTagIdentityV1 = (value: TagIdentityV1): string => safeSerialize(value, isTagIdentityV1);
export const serializeConfigV1 = (value: ConfigV1): string => safeSerialize(value, isConfigV1);
export const serializeManifestV1 = (value: ManifestV1): string => safeSerialize(value, isManifestV1);
export const serializeStateV1 = (value: StateV1): string => safeSerialize(value, isStateV1);
export const serializeJournalV1 = (value: JournalV1): string => safeSerialize(value, isJournalV1);

/** Enforce append-only observed tag identity across a completed state transition. */
export function preservesObservedTagHistory(previous: StateV1, next: StateV1): boolean {
	return Object.entries(previous.observedUpstreamTags).every(([name, identity]) => {
		const candidate = next.observedUpstreamTags[name];
		return (
			candidate !== undefined && candidate.tagObject === identity.tagObject && candidate.commit === identity.commit
		);
	});
}
