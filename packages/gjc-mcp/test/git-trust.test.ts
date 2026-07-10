import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type GitEnvironment, GitTrustError, resolveOfficialRelease, runGit, validatePathPolicy } from "../src/git";
import { OFFICIAL_UPSTREAM_URL, type TagIdentityV1 } from "../src/schema";

const H40_A = "a".repeat(40);
const H40_B = "b".repeat(40);
const H40_C = "c".repeat(40);
const H40_D = "d".repeat(40);
const environment: GitEnvironment = { home: "/synthetic/home", xdgConfigHome: "/synthetic/config" };
const roots: string[] = [];
const originalSpawn = Bun.spawn;

afterEach(async () => {
	(Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

interface SpawnResult {
	stdout?: string;
	stderr?: string;
	exit?: number;
}
type SpawnHandler = (command: readonly string[], options: Record<string, unknown>) => SpawnResult;

function installSpawn(handler: SpawnHandler): string[][] {
	const commands: string[][] = [];
	(Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((command: string[], options: Record<string, unknown>) => {
		commands.push([...command]);
		const result = handler(command, options);
		return {
			stdout: new Response(result.stdout ?? "").body,
			stderr: new Response(result.stderr ?? "").body,
			exited: Promise.resolve(result.exit ?? 0),
			kill() {},
		};
	}) as unknown as typeof Bun.spawn;
	return commands;
}

async function repository(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-git-trust-"));
	roots.push(root);
	return path.join(root, "source.git");
}

interface MockTag {
	name: string;
	commit: string;
	tagObject?: string;
	reachable?: boolean;
}

function officialRemote(tags: readonly MockTag[]): { commands: string[][]; identities: Record<string, TagIdentityV1> } {
	let namespace = "";
	const identities = Object.fromEntries(
		tags.map(tag => [tag.name, { tagObject: tag.tagObject ?? null, commit: tag.commit }]),
	);
	const commands = installSpawn(command => {
		if (command.includes("init")) return {};
		if (command.includes("ls-remote")) return { stdout: `ref: refs/heads/main\tHEAD\n${H40_C}\tHEAD\n` };
		if (command.includes("fetch")) {
			const destination = command.find(value => value.includes(":refs/gjc-mcp/") && value.endsWith("/head"));
			namespace = destination!.slice(destination!.indexOf(":") + 1, -"/head".length);
			return {};
		}
		if (command.includes("for-each-ref"))
			return { stdout: `${tags.map(tag => `${namespace}/tags/${tag.name}`).join("\n")}\n` };
		if (command.includes("rev-parse")) {
			const argument = command.at(-1)!;
			if (argument === `${namespace}/head^{commit}`) return { stdout: `${H40_C}\n` };
			const name = tags.find(tag => argument.includes(`/tags/${tag.name}`));
			if (!name) return { exit: 1 };
			return { stdout: `${argument.endsWith("^{commit}") ? name.commit : (name.tagObject ?? name.commit)}\n` };
		}
		if (command.includes("cat-file")) {
			const object = command.at(-1)!;
			return { stdout: `${tags.some(tag => tag.tagObject === object) ? "tag" : "commit"}\n` };
		}
		if (command.includes("merge-base") && command.includes("--is-ancestor")) {
			const commit = command.at(-2)!;
			return { exit: tags.find(tag => tag.commit === commit)?.reachable === false ? 1 : 0 };
		}
		throw new Error(`unexpected synthetic git command: ${command.join(" ")}`);
	});
	return { commands, identities };
}

async function expectTrustCode(action: () => Promise<unknown>, code: GitTrustError["code"]): Promise<void> {
	try {
		await action();
		throw new Error("expected trust failure");
	} catch (error) {
		expect(error).toBeInstanceOf(GitTrustError);
		expect((error as GitTrustError).code).toBe(code);
	}
}

describe("official stable-tag selection", () => {
	test("selects the greatest stable SemVer above the current fixed v0.9.6 identity", async () => {
		const mock = officialRemote([
			{ name: "v0.9.10", commit: H40_B },
			{ name: "v1.0.0-rc.1", commit: H40_A },
			{ name: "v0.10.0", commit: H40_C, tagObject: H40_D },
			{ name: "v0.9.7", commit: H40_A },
		]);
		const result = await resolveOfficialRelease(await repository(), "0.9.6", {}, environment);
		expect(result.defaultBranch).toBe("refs/heads/main");
		expect(result.candidates.map(candidate => candidate.name)).toEqual(["v0.9.7", "v0.9.10", "v0.10.0"]);
		expect(result.selected).toEqual({ name: "v0.10.0", version: "0.10.0", identity: mock.identities["v0.10.0"] });
		expect(mock.commands.some(command => command.includes(OFFICIAL_UPSTREAM_URL))).toBeTrue();
		expect(mock.commands.every(command => command[0] === "/usr/bin/git")).toBeTrue();
	});

	test("orders components that Number rounds to the same value exactly", async () => {
		const lower = "9007199254740992";
		const higher = "9007199254740993";
		officialRemote([
			{ name: `v${higher}.0.0`, commit: H40_A },
			{ name: `v${lower}.0.0`, commit: H40_B },
		]);
		const result = await resolveOfficialRelease(await repository(), "9007199254740991.0.0", {}, environment);
		expect(result.candidates.map(candidate => candidate.name)).toEqual([`v${lower}.0.0`, `v${higher}.0.0`]);
		expect(result.selected?.name).toBe(`v${higher}.0.0`);
	});

	test("orders arbitrarily long components that Number converts to Infinity", async () => {
		const lower = `1${"0".repeat(309)}`;
		const higher = `2${"0".repeat(309)}`;
		officialRemote([
			{ name: `v${higher}.0.0`, commit: H40_A },
			{ name: `v${lower}.0.0`, commit: H40_B },
		]);
		const result = await resolveOfficialRelease(await repository(), `${"9".repeat(309)}.0.0`, {}, environment);
		expect(result.candidates.map(candidate => candidate.name)).toEqual([`v${lower}.0.0`, `v${higher}.0.0`]);
		expect(result.selected?.name).toBe(`v${higher}.0.0`);
	});

	test("detects a downgrade across arbitrarily long components", async () => {
		const lower = `1${"0".repeat(309)}`;
		const current = `2${"0".repeat(309)}`;
		officialRemote([{ name: `v${lower}.0.0`, commit: H40_A }]);
		await expectTrustCode(
			async () => resolveOfficialRelease(await repository(), `${current}.0.0`, {}, environment),
			"GJC_MCP_E_TAG_DOWNGRADE",
		);
	});

	test("returns no candidate when no stable tag is newer", async () => {
		officialRemote([
			{ name: "v0.9.5", commit: H40_A },
			{ name: "v0.9.6", commit: H40_B },
		]);
		const result = await resolveOfficialRelease(await repository(), "0.9.6", {}, environment);
		expect(result.selected).toBeNull();
	});

	test("rejects deletion, commit retarget, and annotated-tag-object retarget of observed history", async () => {
		for (const scenario of [
			{ tags: [{ name: "v0.9.7", commit: H40_A }], observed: { "v0.9.6": { tagObject: null, commit: H40_A } } },
			{ tags: [{ name: "v0.9.6", commit: H40_B }], observed: { "v0.9.6": { tagObject: null, commit: H40_A } } },
			{
				tags: [{ name: "v0.9.6", commit: H40_A, tagObject: H40_C }],
				observed: { "v0.9.6": { tagObject: H40_B, commit: H40_A } },
			},
		] as const) {
			officialRemote(scenario.tags);
			await expectTrustCode(
				async () => resolveOfficialRelease(await repository(), "0.9.6", scenario.observed, environment),
				"GJC_MCP_E_TAG_RETARGET",
			);
		}
	});

	test("ignores unreachable historical tags below the managed version floor", async () => {
		officialRemote([
			{ name: "v0.1.0", commit: H40_A, reachable: false },
			{ name: "v0.9.6", commit: H40_B },
		]);
		const result = await resolveOfficialRelease(await repository(), "0.9.6", {}, environment);
		expect(result.candidates.map(candidate => candidate.name)).toEqual(["v0.1.0", "v0.9.6"]);
		expect(result.selected).toBeNull();
	});
	test("rejects downgrade-only advertisements and tags unreachable from the advertised default branch", async () => {
		officialRemote([{ name: "v0.9.5", commit: H40_A }]);
		await expectTrustCode(
			async () => resolveOfficialRelease(await repository(), "0.9.6", {}, environment),
			"GJC_MCP_E_TAG_DOWNGRADE",
		);
		officialRemote([{ name: "v0.9.7", commit: H40_B, reachable: false }]);
		await expectTrustCode(
			async () => resolveOfficialRelease(await repository(), "0.9.6", {}, environment),
			"GJC_MCP_E_TAG_UNREACHABLE",
		);
	});
});

describe("bounded and isolated Git invocation", () => {
	test("uses a closed environment and rejects relative known-hosts paths before spawn", async () => {
		let options: Record<string, any> | undefined;
		const commands = installSpawn((_command, candidate) => {
			options = candidate;
			return { stdout: "ok\n" };
		});
		await runGit(null, ["--version"], {
			...environment,
			sshAuthSock: "/synthetic/agent.sock",
			sshKnownHosts: "/synthetic/known_hosts",
		});
		expect(commands[0]!.slice(0, 7)).toEqual([
			"/usr/bin/git",
			"-c",
			"credential.helper=",
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"protocol.file.allow=never",
		]);
		expect(options!.env).toEqual(
			expect.objectContaining({
				HOME: environment.home,
				XDG_CONFIG_HOME: environment.xdgConfigHome,
				PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_TERMINAL_PROMPT: "0",
				GIT_ASKPASS: "/usr/bin/false",
			}),
		);
		expect(options!.env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
		await expectTrustCode(
			() => runGit(null, ["--version"], { ...environment, sshKnownHosts: "relative" }),
			"GJC_MCP_E_PATH_POLICY",
		);
		expect(commands).toHaveLength(1);
	});

	test("kills and maps output beyond the fixed 64 KiB cap to the stable network code", async () => {
		let killed = false;
		(Bun as unknown as { spawn: typeof Bun.spawn }).spawn = (() => ({
			stdout: new Response("x".repeat(64 * 1024 + 1)).body,
			stderr: new Response("").body,
			exited: Promise.resolve(0),
			kill() {
				killed = true;
			},
		})) as unknown as typeof Bun.spawn;
		await expectTrustCode(() => runGit(null, ["--version"], environment), "GJC_MCP_E_NETWORK");
		expect(killed).toBeTrue();
	});
});

describe("path-policy validation", () => {
	const cases = [
		{
			name: "allowed regular file",
			fields: `:100644 100644 ${H40_A} ${H40_B} M\0allowed.ts\0`,
			commits: `${H40_B} ${H40_A}\n`,
			ok: true,
		},
		{
			name: "unapproved path",
			fields: `:100644 100644 ${H40_A} ${H40_B} M\0secret.ts\0`,
			commits: `${H40_B} ${H40_A}\n`,
		},
		{
			name: "executable mode",
			fields: `:100644 100755 ${H40_A} ${H40_B} M\0allowed.ts\0`,
			commits: `${H40_B} ${H40_A}\n`,
		},
		{
			name: "rename status",
			fields: `:100644 100644 ${H40_A} ${H40_B} R\0allowed.ts\0`,
			commits: `${H40_B} ${H40_A}\n`,
		},
		{
			name: "merge commit",
			fields: `:100644 100644 ${H40_A} ${H40_B} M\0allowed.ts\0`,
			commits: `${H40_B} ${H40_A} ${H40_C}\n`,
		},
	] as const;
	for (const scenario of cases) {
		test(scenario.name, async () => {
			installSpawn(command => {
				if (command.includes("merge-base")) return { stdout: `${H40_A}\n` };
				if (command.includes("rev-list")) return { stdout: scenario.commits };
				if (command.includes("diff-tree")) return { stdout: scenario.fields };
				throw new Error("unexpected command");
			});
			const action = () => validatePathPolicy("/synthetic/repository", H40_A, H40_B, ["allowed.ts"], environment);
			if ("ok" in scenario && scenario.ok) await expect(action()).resolves.toBeUndefined();
			else await expectTrustCode(action, "GJC_MCP_E_PATH_POLICY");
		});
	}

	test("rejects a tip whose merge-base is not the approved base", async () => {
		installSpawn(command => (command.includes("merge-base") ? { stdout: `${H40_C}\n` } : {}));
		await expectTrustCode(
			() => validatePathPolicy("/synthetic/repository", H40_A, H40_B, ["allowed.ts"], environment),
			"GJC_MCP_E_PATH_POLICY",
		);
	});
});
