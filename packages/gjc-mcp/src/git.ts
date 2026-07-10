import * as fs from "node:fs/promises";
import * as path from "node:path";
import { OFFICIAL_UPSTREAM_URL, PUBLIC_FORK_URL, type TagIdentityV1 } from "./schema";

const MAX_OUTPUT = 64 * 1024;
const STABLE_TAG = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const HEX40 = /^[0-9a-f]{40}$/;

export class GitTrustError extends Error {
	constructor(
		readonly code:
			| "GJC_MCP_E_NETWORK"
			| "GJC_MCP_E_TAG_RESOLUTION"
			| "GJC_MCP_E_TAG_UNREACHABLE"
			| "GJC_MCP_E_TAG_DOWNGRADE"
			| "GJC_MCP_E_TAG_RETARGET"
			| "GJC_MCP_E_PATH_POLICY"
			| "GJC_MCP_E_PATCH_UNAPPROVED"
			| "GJC_MCP_E_UPDATER_SOURCE_UNAPPROVED",
	) {
		super(code);
		this.name = "GitTrustError";
	}
}

export interface GitEnvironment {
	home: string;
	xdgConfigHome: string;
	sshAuthSock?: string;
	sshKnownHosts?: string;
}
export interface OfficialCandidate {
	name: string;
	version: string;
	identity: TagIdentityV1;
}
export interface OfficialResolution {
	defaultBranch: string;
	defaultCommit: string;
	candidates: OfficialCandidate[];
	selected: OfficialCandidate | null;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function safeEnv(environment: GitEnvironment): Record<string, string> {
	const result: Record<string, string> = {
		HOME: environment.home,
		XDG_CONFIG_HOME: environment.xdgConfigHome,
		PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
		LANG: "C",
		LC_ALL: "C",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		GIT_ASKPASS: "/usr/bin/false",
		SSH_ASKPASS: "/usr/bin/false",
	};
	if (environment.sshAuthSock) result.SSH_AUTH_SOCK = environment.sshAuthSock;
	if (environment.sshKnownHosts) {
		if (!path.isAbsolute(environment.sshKnownHosts) || environment.sshKnownHosts.includes("\0")) {
			throw new GitTrustError("GJC_MCP_E_PATH_POLICY");
		}
		result.GIT_SSH_COMMAND =
			`/usr/bin/ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=no -o StrictHostKeyChecking=yes ` +
			`-o UserKnownHostsFile=${shellQuote(environment.sshKnownHosts)}`;
	}
	return result;
}

async function bounded(stream: ReadableStream<Uint8Array> | null, process: Bun.Subprocess): Promise<string> {
	if (!stream) return "";
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const next = await reader.read();
		if (next.done) break;
		size += next.value.byteLength;
		if (size > MAX_OUTPUT) {
			process.kill();
			throw new GitTrustError("GJC_MCP_E_NETWORK");
		}
		chunks.push(next.value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function runGit(
	repository: string | null,
	args: readonly string[],
	environment: GitEnvironment,
): Promise<string> {
	const command = [
		"/usr/bin/git",
		"-c",
		"credential.helper=",
		"-c",
		"core.hooksPath=/dev/null",
		"-c",
		"protocol.file.allow=never",
	];
	if (repository) command.push("-C", repository);
	command.push(...args);
	const child = Bun.spawn(command, { env: safeEnv(environment), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	try {
		const [stdout] = await Promise.all([bounded(child.stdout, child), bounded(child.stderr, child)]);
		if ((await child.exited) !== 0) throw new GitTrustError("GJC_MCP_E_NETWORK");
		return stdout;
	} catch (error) {
		child.kill();
		await child.exited;
		if (error instanceof GitTrustError) throw error;
		throw new GitTrustError("GJC_MCP_E_NETWORK");
	}
}

function compareVersions(left: string, right: string): number {
	const a = left.split(".").map(BigInt);
	const b = right.split(".").map(BigInt);
	for (let index = 0; index < 3; index++) {
		if (a[index]! < b[index]!) return -1;
		if (a[index]! > b[index]!) return 1;
	}
	return 0;
}

async function objectType(repository: string, object: string, environment: GitEnvironment): Promise<string> {
	return (await runGit(repository, ["cat-file", "-t", object], environment)).trim();
}

async function resolveTag(repository: string, ref: string, environment: GitEnvironment): Promise<TagIdentityV1> {
	const direct = (await runGit(repository, ["rev-parse", "--verify", ref], environment)).trim();
	if (!HEX40.test(direct)) throw new GitTrustError("GJC_MCP_E_TAG_RESOLUTION");
	const type = await objectType(repository, direct, environment);
	if (type === "commit") return { tagObject: null, commit: direct };
	if (type !== "tag") throw new GitTrustError("GJC_MCP_E_TAG_RESOLUTION");
	const peeled = (await runGit(repository, ["rev-parse", "--verify", `${ref}^{commit}`], environment)).trim();
	if (!HEX40.test(peeled) || (await objectType(repository, peeled, environment)) !== "commit")
		throw new GitTrustError("GJC_MCP_E_TAG_RESOLUTION");
	return { tagObject: direct, commit: peeled };
}

export async function resolveOfficialRelease(
	repository: string,
	currentVersion: string,
	observed: Readonly<Record<string, TagIdentityV1>>,
	environment: GitEnvironment,
): Promise<OfficialResolution> {
	await fs.mkdir(repository, { recursive: true, mode: 0o700 });
	if (!(await Bun.file(path.join(repository, "HEAD")).exists()))
		await runGit(null, ["init", "--bare", repository], environment);
	const advertised = await runGit(null, ["ls-remote", "--symref", OFFICIAL_UPSTREAM_URL, "HEAD"], environment);
	const match = /^ref: (refs\/heads\/[A-Za-z0-9._/-]+)\tHEAD$/m.exec(advertised);
	if (!match || match[1]!.includes("..") || match[1]!.includes("//"))
		throw new GitTrustError("GJC_MCP_E_TAG_RESOLUTION");
	const branch = match[1]!;
	const namespace = `refs/gjc-mcp/${crypto.randomUUID()}`;
	await runGit(
		repository,
		["fetch", "--no-tags", OFFICIAL_UPSTREAM_URL, `+${branch}:${namespace}/head`, `+refs/tags/*:${namespace}/tags/*`],
		environment,
	);
	const defaultCommit = (await runGit(repository, ["rev-parse", `${namespace}/head^{commit}`], environment)).trim();
	const refs = (await runGit(repository, ["for-each-ref", "--format=%(refname)", `${namespace}/tags/`], environment))
		.trim()
		.split("\n")
		.filter(Boolean);
	const candidates: OfficialCandidate[] = [];
	for (const ref of refs) {
		const name = ref.slice(`${namespace}/tags/`.length);
		if (!STABLE_TAG.test(name)) continue;
		const identity = await resolveTag(repository, ref, environment);
		const version = name.slice(1);
		if (compareVersions(version, currentVersion) >= 0 || observed[name] !== undefined) {
			try {
				await runGit(repository, ["merge-base", "--is-ancestor", identity.commit, defaultCommit], environment);
			} catch {
				throw new GitTrustError("GJC_MCP_E_TAG_UNREACHABLE");
			}
		}
		candidates.push({ name, version: name.slice(1), identity });
	}
	for (const [name, oldIdentity] of Object.entries(observed)) {
		const candidate = candidates.find(entry => entry.name === name);
		if (
			!candidate ||
			candidate.identity.commit !== oldIdentity.commit ||
			candidate.identity.tagObject !== oldIdentity.tagObject
		)
			throw new GitTrustError("GJC_MCP_E_TAG_RETARGET");
	}
	candidates.sort((a, b) => compareVersions(a.version, b.version));
	if (
		candidates.length > 0 &&
		!candidates.some(entry => entry.version === currentVersion) &&
		compareVersions(candidates[candidates.length - 1]!.version, currentVersion) < 0
	)
		throw new GitTrustError("GJC_MCP_E_TAG_DOWNGRADE");
	const selected = [...candidates].reverse().find(entry => compareVersions(entry.version, currentVersion) > 0) ?? null;
	return { defaultBranch: branch, defaultCommit, candidates, selected };
}

export async function resolvePinnedForkCommit(
	repository: string,
	branch: "standalone-mcp-autoload" | "gjc-mcp-controller-v1",
	approvedCommit: string,
	environment: GitEnvironment,
): Promise<string> {
	await fs.mkdir(repository, { recursive: true, mode: 0o700 });
	if (!(await Bun.file(path.join(repository, "HEAD")).exists()))
		await runGit(null, ["init", "--bare", repository], environment);
	if (!HEX40.test(approvedCommit))
		throw new GitTrustError(
			branch === "standalone-mcp-autoload" ? "GJC_MCP_E_PATCH_UNAPPROVED" : "GJC_MCP_E_UPDATER_SOURCE_UNAPPROVED",
		);
	const ref = `refs/gjc-mcp/fork/${crypto.randomUUID()}`;
	await runGit(repository, ["fetch", "--no-tags", PUBLIC_FORK_URL, `+refs/heads/${branch}:${ref}`], environment);
	const tip = (await runGit(repository, ["rev-parse", `${ref}^{commit}`], environment)).trim();
	if (tip !== approvedCommit)
		throw new GitTrustError(
			branch === "standalone-mcp-autoload" ? "GJC_MCP_E_PATCH_UNAPPROVED" : "GJC_MCP_E_UPDATER_SOURCE_UNAPPROVED",
		);
	return tip;
}

export async function validatePathPolicy(
	repository: string,
	base: string,
	tip: string,
	allowedPaths: readonly string[],
	environment: GitEnvironment,
): Promise<void> {
	if (!HEX40.test(base) || !HEX40.test(tip)) throw new GitTrustError("GJC_MCP_E_PATH_POLICY");
	const mergeBase = (await runGit(repository, ["merge-base", base, tip], environment)).trim();
	if (mergeBase !== base) throw new GitTrustError("GJC_MCP_E_PATH_POLICY");
	const commits = (await runGit(repository, ["rev-list", "--parents", `${base}..${tip}`], environment))
		.trim()
		.split("\n")
		.filter(Boolean);
	if (commits.some(line => line.split(" ").length !== 2)) throw new GitTrustError("GJC_MCP_E_PATH_POLICY");
	const output = await runGit(
		repository,
		["diff-tree", "-r", "--no-commit-id", "--no-renames", "--raw", "-z", base, tip],
		environment,
	);
	const fields = output.split("\0").filter(Boolean);
	const allowed = new Set(allowedPaths);
	for (let index = 0; index < fields.length; index += 2) {
		const metadata = fields[index]!;
		const file = fields[index + 1];
		const parsed = /^:(\d{6}) (\d{6}) [0-9a-f]{40} [0-9a-f]{40} ([AMD])$/.exec(metadata);
		if (
			!parsed ||
			!file ||
			!allowed.has(file) ||
			file !== file.normalize("NFC") ||
			!/^[\x20-\x7e]+$/.test(file) ||
			file.includes("\\") ||
			file.startsWith("/") ||
			file.split("/").some(part => part === "." || part === ".." || part === "")
		)
			throw new GitTrustError("GJC_MCP_E_PATH_POLICY");
		if (parsed[2] !== "000000" && parsed[2] !== "100644") throw new GitTrustError("GJC_MCP_E_PATH_POLICY");
		if (parsed[1] !== "000000" && parsed[1] !== "100644") throw new GitTrustError("GJC_MCP_E_PATH_POLICY");
	}
}
function changedPaths(output: string): string[] {
	return output.split("\0").filter(Boolean);
}

async function diffPaths(
	repository: string,
	left: string,
	right: string,
	paths: readonly string[],
	environment: GitEnvironment,
): Promise<string[]> {
	const output = await runGit(repository, ["diff", "--name-only", "-z", left, right, "--", ...paths], environment);
	return changedPaths(output);
}

export async function classifyPinnedPatchSupport(
	repository: string,
	official: string,
	base: string,
	tip: string,
	allowedPaths: readonly string[],
	environment: GitEnvironment,
): Promise<"unsupported" | "full" | "partial"> {
	if (![official, base, tip].every(value => HEX40.test(value))) throw new GitTrustError("GJC_MCP_E_PATH_POLICY");
	const patchPaths = await diffPaths(repository, base, tip, allowedPaths, environment);
	if (patchPaths.length === 0) throw new GitTrustError("GJC_MCP_E_PATH_POLICY");
	const differsFromTip = await diffPaths(repository, official, tip, patchPaths, environment);
	if (differsFromTip.length === 0) return "full";
	const differsFromBase = await diffPaths(repository, official, base, patchPaths, environment);
	return differsFromBase.length === 0 ? "unsupported" : "partial";
}

export async function materializeWorktree(
	repository: string,
	worktree: string,
	commit: string,
	environment: GitEnvironment,
): Promise<void> {
	if (!HEX40.test(commit) || !path.isAbsolute(worktree)) throw new GitTrustError("GJC_MCP_E_PATH_POLICY");
	await fs.mkdir(path.dirname(worktree), { recursive: true, mode: 0o700 });
	await fs.rm(worktree, { recursive: true, force: true });
	await runGit(repository, ["worktree", "add", "--detach", worktree, commit], environment);
	const resolved = (await runGit(worktree, ["rev-parse", "HEAD"], environment)).trim();
	if (resolved !== commit) throw new GitTrustError("GJC_MCP_E_TAG_RESOLUTION");
}

export async function applyPinnedPatch(
	worktree: string,
	base: string,
	tip: string,
	environment: GitEnvironment,
): Promise<string> {
	if (![base, tip].every(value => HEX40.test(value)) || !path.isAbsolute(worktree))
		throw new GitTrustError("GJC_MCP_E_PATH_POLICY");
	const commits = (await runGit(worktree, ["rev-list", "--reverse", `${base}..${tip}`], environment))
		.trim()
		.split("\n")
		.filter(Boolean);
	if (commits.length === 0 || commits.some(commit => !HEX40.test(commit)))
		throw new GitTrustError("GJC_MCP_E_PATH_POLICY");
	await runGit(worktree, ["cherry-pick", "--no-commit", ...commits], environment);
	const tree = (await runGit(worktree, ["write-tree"], environment)).trim();
	if (!HEX40.test(tree)) throw new GitTrustError("GJC_MCP_E_PATH_POLICY");
	return tree;
}

export async function resolveCommitTree(
	repository: string,
	commit: string,
	environment: GitEnvironment,
): Promise<string> {
	if (!HEX40.test(commit)) throw new GitTrustError("GJC_MCP_E_TAG_RESOLUTION");
	const tree = (await runGit(repository, ["rev-parse", `${commit}^{tree}`], environment)).trim();
	if (!HEX40.test(tree)) throw new GitTrustError("GJC_MCP_E_TAG_RESOLUTION");
	return tree;
}

export async function removeWorktree(repository: string, worktree: string, environment: GitEnvironment): Promise<void> {
	try {
		await runGit(repository, ["worktree", "remove", "--force", worktree], environment);
	} catch {
		await fs.rm(worktree, { recursive: true, force: true });
		await runGit(repository, ["worktree", "prune"], environment).catch(() => undefined);
	}
}
