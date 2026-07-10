import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	DIRECTORY_MODE,
	EXECUTABLE_MODE,
	ensureManagedRoots,
	PRIVATE_FILE_MODE,
	requireCurrentUserOwnership,
	resolveUpdaterPaths,
} from "../src/paths";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
	const value = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mcp-paths-"));
	roots.push(value);
	return value;
}

describe("XDG layout confinement", () => {
	test("uses absolute XDG roots while keeping launchers under HOME", () => {
		const paths = resolveUpdaterPaths({
			HOME: "/synthetic/home",
			XDG_DATA_HOME: "/vol/data",
			XDG_CONFIG_HOME: "/vol/config",
			XDG_STATE_HOME: "/vol/state",
			XDG_CACHE_HOME: "/vol/cache",
		});
		expect(paths.dataRoot).toBe("/vol/data/gjc-mcp");
		expect(paths.configPath).toBe("/vol/config/gjc-mcp/config.json");
		expect(paths.statePath).toBe("/vol/state/gjc-mcp/state.json");
		expect(paths.lockPath).toBe("/vol/state/gjc-mcp/lock");
		expect(paths.worktreesRoot).toBe("/vol/cache/gjc-mcp/worktrees");
		expect(paths.launcherPath).toBe("/synthetic/home/.local/bin/gjc");
		expect(paths.updaterPath).toBe("/synthetic/home/.local/bin/gjc-mcp");
		expect(paths.bunFallbackPath).toBe("/synthetic/home/.bun/bin/gjc");
	});

	for (const [name, environment] of [
		["HOME", { HOME: "relative" }],
		["XDG_DATA_HOME", { HOME: "/home/user", XDG_DATA_HOME: "relative" }],
		["XDG_CONFIG_HOME", { HOME: "/home/user", XDG_CONFIG_HOME: "../config" }],
		["XDG_STATE_HOME", { HOME: "/home/user", XDG_STATE_HOME: "state\0escape" }],
		["XDG_CACHE_HOME", { HOME: "/home/user", XDG_CACHE_HOME: "cache" }],
	] as const) {
		test(`rejects unsafe ${name}`, () => {
			expect(() => resolveUpdaterPaths(environment)).toThrow("must be an absolute path");
		});
	}

	test("normalizes absolute roots before deriving managed children", () => {
		const paths = resolveUpdaterPaths({ HOME: "/home/user/../user", XDG_STATE_HOME: "/state/./private" });
		expect(paths.home).toBe("/home/user");
		expect(paths.stateRoot).toBe("/state/private/gjc-mcp");
	});
});

test("creates canonical managed roots and rejects mode or symlink drift", async () => {
	const temporary = await root();
	const home = await fs.realpath(temporary);
	const paths = resolveUpdaterPaths({
		HOME: home,
		XDG_DATA_HOME: path.join(home, "data"),
		XDG_CONFIG_HOME: path.join(home, "config"),
		XDG_STATE_HOME: path.join(home, "state"),
		XDG_CACHE_HOME: path.join(home, "cache"),
	});
	await ensureManagedRoots(paths, true);
	expect((await fs.lstat(paths.binRoot)).mode & 0o777).toBe(0o755);
	expect((await fs.lstat(paths.dataRoot)).mode & 0o777).toBe(0o700);

	await fs.chmod(paths.cacheRoot, 0o755);
	await expect(ensureManagedRoots(paths, false)).rejects.toThrow("canonical ownership");
	await fs.chmod(paths.cacheRoot, 0o700);
	await fs.rm(paths.sourceRoot, { recursive: true });
	await fs.symlink(paths.cacheRoot, paths.sourceRoot);
	await expect(ensureManagedRoots(paths, false)).rejects.toThrow("canonical ownership");
});

describe("owner, type, and exact-mode guards", () => {
	test("accepts current-user objects only at their exact required modes", async () => {
		const temporary = await root();
		const directory = path.join(temporary, "private");
		const file = path.join(temporary, "state.json");
		const executable = path.join(temporary, "gjc");
		await fs.mkdir(directory, { mode: DIRECTORY_MODE });
		await fs.writeFile(file, "{}", { mode: PRIVATE_FILE_MODE });
		await fs.writeFile(executable, "#!/bin/sh\n", { mode: EXECUTABLE_MODE });
		await fs.chmod(directory, DIRECTORY_MODE);
		await fs.chmod(file, PRIVATE_FILE_MODE);
		await fs.chmod(executable, EXECUTABLE_MODE);

		await expect(requireCurrentUserOwnership(directory, { kind: "directory" })).resolves.toBeUndefined();
		await expect(requireCurrentUserOwnership(file, { kind: "file" })).resolves.toBeUndefined();
		await expect(requireCurrentUserOwnership(executable, { kind: "executable" })).resolves.toBeUndefined();
	});

	test("rejects group/world permission drift for every managed object class", async () => {
		const temporary = await root();
		for (const [name, kind, required, unsafe] of [
			["directory", "directory", DIRECTORY_MODE, 0o750],
			["state", "file", PRIVATE_FILE_MODE, 0o640],
			["binary", "executable", EXECUTABLE_MODE, 0o775],
		] as const) {
			const target = path.join(temporary, name);
			if (kind === "directory") await fs.mkdir(target, { mode: required });
			else await fs.writeFile(target, "x", { mode: required });
			await fs.chmod(target, unsafe);
			await expect(requireCurrentUserOwnership(target, { kind })).rejects.toThrow("invalid mode");
		}
	});

	test("does not follow a symbolic link when a regular file or directory is required", async () => {
		const temporary = await root();
		const target = path.join(temporary, "target");
		const link = path.join(temporary, "link");
		await fs.writeFile(target, "secret", { mode: PRIVATE_FILE_MODE });
		await fs.symlink(target, link);
		await expect(requireCurrentUserOwnership(link, { kind: "file" })).rejects.toThrow(
			"symbolic links are not allowed",
		);
		await expect(requireCurrentUserOwnership(link, { kind: "directory" })).rejects.toThrow(
			"symbolic links are not allowed",
		);
		await expect(requireCurrentUserOwnership(link, { kind: "symbolic-link" })).resolves.toBeUndefined();
	});

	test("rejects type confusion independently of permissions", async () => {
		const temporary = await root();
		const directory = path.join(temporary, "directory");
		const file = path.join(temporary, "file");
		await fs.mkdir(directory, { mode: DIRECTORY_MODE });
		await fs.writeFile(file, "x", { mode: PRIVATE_FILE_MODE });
		await fs.chmod(directory, DIRECTORY_MODE);
		await fs.chmod(file, PRIVATE_FILE_MODE);
		await expect(requireCurrentUserOwnership(directory, { kind: "file", mode: DIRECTORY_MODE })).rejects.toThrow(
			"regular file",
		);
		await expect(requireCurrentUserOwnership(file, { kind: "directory", mode: PRIVATE_FILE_MODE })).rejects.toThrow(
			"directory",
		);
	});
});
