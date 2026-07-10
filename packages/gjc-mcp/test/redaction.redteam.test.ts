import { describe, expect, test } from "bun:test";
import {
	diagnosticFromUnknown,
	exitCodeFor,
	isStableCode,
	renderDiagnostic,
	STABLE_CODES,
	type StableCode,
} from "../src/diagnostics";

const canaries = [
	"synthetic-password=correct-horse-battery-staple",
	"https://user:synthetic-pass@example.invalid/private?token=synthetic-query",
	"Authorization: Bearer synthetic-bearer-token",
	"Cookie: session=synthetic-cookie",
	"client_secret=synthetic-oauth-secret",
	"refresh_token=synthetic-refresh-token",
	"-----BEGIN SYNTHETIC PRIVATE KEY-----",
	"child stderr: synthetic-child-output",
] as const;

function expectNoCanaries(output: string): void {
	for (const canary of canaries) expect(output).not.toContain(canary);
	expect(output).not.toContain("synthetic-");
}

describe("closed diagnostic rendering", () => {
	test("the stable-code vocabulary is unique, closed, and maps to stable process classes", () => {
		expect(new Set(STABLE_CODES).size).toBe(STABLE_CODES.length);
		for (const code of STABLE_CODES) {
			expect(isStableCode(code)).toBeTrue();
			expect(renderDiagnostic({ code })).toBe(code);
			expect(exitCodeFor(code)).toBe(
				code === "GJC_MCP_OK" ? 0 : code === "GJC_MCP_E_USAGE" || code === "GJC_MCP_E_MANAGED_UPDATE_ARGS" ? 2 : 1,
			);
		}
		for (const candidate of ["", "GJC_MCP_E_UNKNOWN", "GJC_MCP_OK\nsynthetic-child-output", 1, null]) {
			expect(isStableCode(candidate)).toBeFalse();
		}
	});

	test("renders only validated flat identifiers and drops secret-shaped or malformed values", () => {
		const output = renderDiagnostic({
			code: "GJC_MCP_E_VERIFY",
			identifiers: [
				{ kind: "run", value: "run-17" },
				{ kind: "tag", value: "v0.9.6" },
				{ kind: "phase", value: "post-verified" },
				{ kind: "operation", value: "update" },
				{ kind: "release", value: "a".repeat(64) },
				...canaries.map(value => ({ kind: "run" as const, value })),
			],
		});
		expect(output).toBe(
			`GJC_MCP_E_VERIFY run=run-17 tag=v0.9.6 phase=post-verified operation=update release=${"a".repeat(64)}`,
		);
		expectNoCanaries(output);
	});

	test("rejects partial hashes, nonstable tags, control characters, and identifier overflow", () => {
		const output = renderDiagnostic({
			code: "GJC_MCP_E_TAG_RESOLUTION",
			identifiers: [
				{ kind: "sha256", value: "a".repeat(63) },
				{ kind: "sha256", value: "a".repeat(65) },
				{ kind: "tag", value: "v0.9.6-rc.1" },
				{ kind: "run", value: "safe\nAuthorization: Bearer synthetic-bearer-token" },
				{ kind: "phase", value: "unknown" },
				{ kind: "operation", value: "install;synthetic-child-output" },
				{ kind: "run", value: "x".repeat(129) },
				{ kind: "run", value: "also-safe" },
				{ kind: "run", value: "ignored-after-eight" },
			],
		});
		expect(output).toBe("GJC_MCP_E_TAG_RESOLUTION run=also-safe");
		expectNoCanaries(output);
	});
});

describe("unknown error collapse", () => {
	test("does not inspect or retain nested synthetic secrets, URLs, headers, OAuth data, or child output", () => {
		const nested = {
			message: canaries[0],
			request: { url: canaries[1], headers: { authorization: canaries[2], cookie: canaries[3] } },
			oauth: { client_secret: canaries[4], refresh_token: canaries[5] },
			cause: new Error(canaries[6]),
			child: { stdout: canaries[7], stderr: canaries.join("\n") },
		};
		const diagnostic = diagnosticFromUnknown("GJC_MCP_E_NETWORK", nested);
		expect(diagnostic).toEqual({ code: "GJC_MCP_E_NETWORK" });
		expectNoCanaries(renderDiagnostic(diagnostic));
	});

	test("does not invoke hostile getters, coercion, custom inspection, or proxy traps", () => {
		let touched = false;
		const hostile = new Proxy(Object.create(null), {
			get() {
				touched = true;
				throw new Error(canaries[0]);
			},
			ownKeys() {
				touched = true;
				throw new Error(canaries[1]);
			},
			getOwnPropertyDescriptor() {
				touched = true;
				throw new Error(canaries[2]);
			},
		});
		const diagnostic = diagnosticFromUnknown("GJC_MCP_E_BUILD", hostile);
		expect(touched).toBeFalse();
		expect(renderDiagnostic(diagnostic)).toBe("GJC_MCP_E_BUILD");
	});

	test("collapses every JavaScript thrown-value category to the caller-selected code", () => {
		const values: unknown[] = [
			undefined,
			null,
			canaries[0],
			42,
			Symbol("synthetic-secret"),
			new Error(canaries[7]),
			{ nested: canaries },
		];
		for (const value of values) {
			const diagnostic = diagnosticFromUnknown("GJC_MCP_E_VERIFY" as StableCode, value);
			expect(diagnostic).toEqual({ code: "GJC_MCP_E_VERIFY" });
			expectNoCanaries(renderDiagnostic(diagnostic));
		}
	});
});
