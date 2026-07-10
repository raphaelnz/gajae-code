export const STABLE_CODES = [
	"GJC_MCP_OK",
	"GJC_MCP_E_USAGE",
	"GJC_MCP_E_PATH_PRECONDITION",
	"GJC_MCP_E_PATH_OWNERSHIP",
	"GJC_MCP_E_INSTALL_INCOMPLETE",
	"GJC_MCP_E_BUSY",
	"GJC_MCP_E_LOCK_MALFORMED",
	"GJC_MCP_E_LOCK_OWNER",
	"GJC_MCP_E_LOCK_STALE",
	"GJC_MCP_E_RECOVERY_REQUIRED",
	"GJC_MCP_E_INTERRUPTED_RECOVERED",
	"GJC_MCP_E_RESTORE_FAILED",
	"GJC_MCP_E_UPDATER_SIDECAR_MISSING",
	"GJC_MCP_E_UPDATER_SIDECAR_TYPE",
	"GJC_MCP_E_UPDATER_SIDECAR_OWNER",
	"GJC_MCP_E_UPDATER_SIDECAR_MODE",
	"GJC_MCP_E_UPDATER_SIDECAR_IO",
	"GJC_MCP_E_UPDATER_SIDECAR_SCHEMA",
	"GJC_MCP_E_UPDATER_PATH",
	"GJC_MCP_E_UPDATER_MISSING",
	"GJC_MCP_E_UPDATER_TYPE",
	"GJC_MCP_E_UPDATER_OWNER",
	"GJC_MCP_E_UPDATER_MODE",
	"GJC_MCP_E_UPDATER_IO",
	"GJC_MCP_E_UPDATER_HASH",
	"GJC_MCP_E_UPDATER_EXEC",
	"GJC_MCP_E_CURRENT_MISSING",
	"GJC_MCP_E_CURRENT_NOT_SYMLINK",
	"GJC_MCP_E_CURRENT_ESCAPE",
	"GJC_MCP_E_CURRENT_RELEASE_ID",
	"GJC_MCP_E_MANIFEST_MISSING",
	"GJC_MCP_E_MANIFEST_IO",
	"GJC_MCP_E_MANIFEST_SCHEMA",
	"GJC_MCP_E_MANIFEST_RELEASE_MISMATCH",
	"GJC_MCP_E_ARTIFACT_MISSING",
	"GJC_MCP_E_ARTIFACT_TYPE",
	"GJC_MCP_E_ARTIFACT_MODE",
	"GJC_MCP_E_ARTIFACT_OWNER",
	"GJC_MCP_E_ARTIFACT_SIZE",
	"GJC_MCP_E_ARTIFACT_IO",
	"GJC_MCP_E_ARTIFACT_HASH",
	"GJC_MCP_E_RUNTIME_EXEC",
	"GJC_MCP_E_STATE_MISSING",
	"GJC_MCP_E_STATE_IO",
	"GJC_MCP_E_STATE_SCHEMA",
	"GJC_MCP_E_STATE_MISMATCH",
	"GJC_MCP_E_CONFIG_MISSING",
	"GJC_MCP_E_CONFIG_IO",
	"GJC_MCP_E_CONFIG_SCHEMA",
	"GJC_MCP_E_PREVIOUS_MISSING",
	"GJC_MCP_E_PREVIOUS_EQUAL",
	"GJC_MCP_E_PREVIOUS_CORRUPT",
	"GJC_MCP_E_UPDATER_REINSTALL_REQUIRED",
	"GJC_MCP_E_MANAGED_UPDATE_ARGS",
	"GJC_MCP_E_TAG_FORMAT",
	"GJC_MCP_E_TAG_RESOLUTION",
	"GJC_MCP_E_TAG_UNREACHABLE",
	"GJC_MCP_E_TAG_DOWNGRADE",
	"GJC_MCP_E_TAG_RETARGET",
	"GJC_MCP_E_TAG_MISMATCH",
	"GJC_MCP_E_PATCH_UNAPPROVED",
	"GJC_MCP_E_UPDATER_SOURCE_UNAPPROVED",
	"GJC_MCP_E_PATH_POLICY",
	"GJC_MCP_E_APPROVAL_REQUIRED",
	"GJC_MCP_E_OFFICIAL_PARTIAL",
	"GJC_MCP_E_PROBE_INFRA",
	"GJC_MCP_E_BUILD",
	"GJC_MCP_E_VERIFY",
	"GJC_MCP_E_NETWORK",
] as const;

export type StableCode = (typeof STABLE_CODES)[number];
export type DiagnosticIdentifierKind = "run" | "release" | "tag" | "phase" | "operation" | "sha256";

export interface DiagnosticIdentifier {
	kind: DiagnosticIdentifierKind;
	value: string;
}

export interface StableDiagnostic {
	code: StableCode;
	identifiers?: readonly DiagnosticIdentifier[];
}

const CODE_SET: ReadonlySet<string> = new Set(STABLE_CODES);
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FULL_SHA256 = /^[0-9a-f]{64}$/;
const STABLE_TAG = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const PHASES = new Set([
	"prepared",
	"previous-written",
	"current-written",
	"prelaunch-verified",
	"launcher-written",
	"post-verified",
	"state-written",
]);
const OPERATIONS = new Set(["install", "bootstrap", "update", "check", "rollback"]);
const MAX_IDENTIFIERS = 8;
const MAX_RENDERED_BYTES = 1024;

export function isStableCode(value: unknown): value is StableCode {
	return typeof value === "string" && CODE_SET.has(value);
}

function safeIdentifier(identifier: DiagnosticIdentifier): string | undefined {
	const valid =
		identifier.kind === "run"
			? SAFE_IDENTIFIER.test(identifier.value)
			: identifier.kind === "release" || identifier.kind === "sha256"
				? FULL_SHA256.test(identifier.value)
				: identifier.kind === "tag"
					? STABLE_TAG.test(identifier.value)
					: identifier.kind === "phase"
						? PHASES.has(identifier.value)
						: OPERATIONS.has(identifier.value);
	return valid ? `${identifier.kind}=${identifier.value}` : undefined;
}

/** Render only the closed code and validated, flat, nonsecret identifiers. */
export function renderDiagnostic(diagnostic: StableDiagnostic): string {
	const fields: string[] = [diagnostic.code];
	for (const identifier of diagnostic.identifiers?.slice(0, MAX_IDENTIFIERS) ?? []) {
		const rendered = safeIdentifier(identifier);
		if (rendered !== undefined) fields.push(rendered);
	}
	const result = fields.join(" ");
	return new TextEncoder().encode(result).byteLength <= MAX_RENDERED_BYTES ? result : diagnostic.code;
}

export type DiagnosticExitCode = 0 | 1 | 2;

export function exitCodeFor(code: StableCode): DiagnosticExitCode {
	if (code === "GJC_MCP_OK") return 0;
	if (code === "GJC_MCP_E_USAGE" || code === "GJC_MCP_E_MANAGED_UPDATE_ARGS") return 2;
	return 1;
}

/** Collapse arbitrary thrown values without retaining child errors or their potentially secret text. */
export function diagnosticFromUnknown(code: StableCode, _error: unknown): StableDiagnostic {
	return { code };
}
