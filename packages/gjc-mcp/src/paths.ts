import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
export const EXECUTABLE_MODE = 0o755;

export interface PathEnvironment {
	readonly [name: string]: string | undefined;
	HOME?: string;
	XDG_DATA_HOME?: string;
	XDG_CONFIG_HOME?: string;
	XDG_STATE_HOME?: string;
	XDG_CACHE_HOME?: string;
}

export interface UpdaterPaths {
	home: string;
	dataRoot: string;
	configRoot: string;
	stateRoot: string;
	cacheRoot: string;
	binRoot: string;
	data: string;
	config: string;
	state: string;
	cache: string;
	bin: string;
	sidecar: string;
	current: string;
	previous: string;
	journal: string;
	lock: string;
	releasesRoot: string;
	sourceRoot: string;
	worktreesRoot: string;
	configPath: string;
	statePath: string;
	sidecarPath: string;
	currentPath: string;
	previousPath: string;
	journalPath: string;
	lockPath: string;
	updaterPath: string;
	launcherPath: string;
	bunFallbackPath: string;
	bunRuntimePath: string;
}

function requireAbsoluteRoot(value: string, name: string): string {
	if (!path.isAbsolute(value) || value.includes("\0")) {
		throw new Error(`${name} must be an absolute path`);
	}
	return path.resolve(value);
}

function xdgRoot(value: string | undefined, fallback: string, name: string): string {
	return requireAbsoluteRoot(value ?? fallback, name);
}

/** Resolve the managed layout without consulting or depending on the invocation cwd. */
export function resolveUpdaterPaths(environment: PathEnvironment = process.env): UpdaterPaths {
	const home = requireAbsoluteRoot(environment.HOME ?? os.homedir(), "HOME");
	const dataHome = xdgRoot(environment.XDG_DATA_HOME, path.join(home, ".local", "share"), "XDG_DATA_HOME");
	const configHome = xdgRoot(environment.XDG_CONFIG_HOME, path.join(home, ".config"), "XDG_CONFIG_HOME");
	const stateHome = xdgRoot(environment.XDG_STATE_HOME, path.join(home, ".local", "state"), "XDG_STATE_HOME");
	const cacheHome = xdgRoot(environment.XDG_CACHE_HOME, path.join(home, ".cache"), "XDG_CACHE_HOME");
	const dataRoot = path.join(dataHome, "gjc-mcp");
	const configRoot = path.join(configHome, "gjc-mcp");
	const stateRoot = path.join(stateHome, "gjc-mcp");
	const cacheRoot = path.join(cacheHome, "gjc-mcp");
	const binRoot = path.join(home, ".local", "bin");

	return {
		home,
		dataRoot,
		configRoot,
		stateRoot,
		cacheRoot,
		binRoot,
		data: dataRoot,
		config: configRoot,
		state: stateRoot,
		cache: cacheRoot,
		bin: binRoot,
		sidecar: path.join(stateRoot, "updater-install.json"),
		current: path.join(dataRoot, "current"),
		previous: path.join(dataRoot, "previous"),
		journal: path.join(stateRoot, "journal.json"),
		lock: path.join(stateRoot, "lock"),
		releasesRoot: path.join(dataRoot, "releases"),
		sourceRoot: path.join(dataRoot, "source.git"),
		worktreesRoot: path.join(cacheRoot, "worktrees"),
		configPath: path.join(configRoot, "config.json"),
		statePath: path.join(stateRoot, "state.json"),
		sidecarPath: path.join(stateRoot, "updater-install.json"),
		currentPath: path.join(dataRoot, "current"),
		previousPath: path.join(dataRoot, "previous"),
		journalPath: path.join(stateRoot, "journal.json"),
		lockPath: path.join(stateRoot, "lock"),
		updaterPath: path.join(binRoot, "gjc-mcp"),
		launcherPath: path.join(binRoot, "gjc"),
		bunFallbackPath: path.join(home, ".bun", "bin", "gjc"),
		bunRuntimePath: path.join(home, ".bun", "bin", "bun"),
	};
}

export interface OwnedPathOptions {
	kind: "directory" | "file" | "executable" | "symbolic-link";
	mode?: number;
}

/** Fail closed unless a path is owned by the effective user and has the exact required mode/type. */
export async function requireCurrentUserOwnership(target: string, options: OwnedPathOptions): Promise<void> {
	const uid = process.getuid?.();
	if (uid === undefined) throw new Error("current user ownership is unavailable");
	const stat = await fs.lstat(target);
	if (stat.uid !== uid) throw new Error("path is not owned by the current user");
	if (options.kind === "symbolic-link") {
		if (!stat.isSymbolicLink()) throw new Error("path is not a symbolic link");
		if (options.mode !== undefined && (stat.mode & 0o777) !== options.mode)
			throw new Error("path has an invalid mode");
		return;
	}
	if (stat.isSymbolicLink()) throw new Error("symbolic links are not allowed");
	if (options.kind === "directory" && !stat.isDirectory()) throw new Error("path is not a directory");
	if (options.kind !== "directory" && !stat.isFile()) throw new Error("path is not a regular file");
	const expectedMode =
		options.mode ??
		(options.kind === "directory"
			? DIRECTORY_MODE
			: options.kind === "executable"
				? EXECUTABLE_MODE
				: PRIVATE_FILE_MODE);
	if ((stat.mode & 0o777) !== expectedMode) throw new Error("path has an invalid mode");
}

/** Create or validate every updater-owned root before any managed write or child process. */
export async function ensureManagedRoots(paths: UpdaterPaths, create = false): Promise<void> {
	const uid = process.getuid?.();
	if (uid === undefined) throw new Error("current user ownership is unavailable");
	const roots: Array<{ target: string; mode: number }> = [
		{ target: paths.binRoot, mode: EXECUTABLE_MODE },
		{ target: paths.dataRoot, mode: DIRECTORY_MODE },
		{ target: paths.configRoot, mode: DIRECTORY_MODE },
		{ target: paths.stateRoot, mode: DIRECTORY_MODE },
		{ target: paths.cacheRoot, mode: DIRECTORY_MODE },
		{ target: paths.releasesRoot, mode: DIRECTORY_MODE },
		{ target: paths.sourceRoot, mode: DIRECTORY_MODE },
		{ target: paths.worktreesRoot, mode: DIRECTORY_MODE },
	];
	for (const { target, mode } of roots) {
		if (create) await fs.mkdir(target, { recursive: true, mode });
		const resolved = await fs.realpath(target);
		const stat = await fs.lstat(target);
		if (
			resolved !== path.resolve(target) ||
			!stat.isDirectory() ||
			stat.isSymbolicLink() ||
			stat.uid !== uid ||
			(stat.mode & 0o777) !== mode
		) {
			throw new Error("managed root failed canonical ownership validation");
		}
	}
}
