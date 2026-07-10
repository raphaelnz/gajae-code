import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import type { StableCode } from "./diagnostics";
import { PRIVATE_FILE_MODE } from "./paths";

interface LockRecordV1 {
	schema: 1;
	pid: number;
	uid: number;
	token: string;
	createdAt: string;
}

export type LockInspection =
	| { state: "absent" }
	| { state: "live"; code: "GJC_MCP_E_BUSY" }
	| { state: "stale"; code: "GJC_MCP_E_LOCK_STALE" }
	| { state: "malformed"; code: "GJC_MCP_E_LOCK_MALFORMED" }
	| { state: "wrong-owner"; code: "GJC_MCP_E_LOCK_OWNER" };

export interface HeldLock {
	path: string;
	token: string;
	release(): Promise<void>;
}

export type AcquireLockResult = { ok: true; lock: HeldLock; replacedStale: boolean } | { ok: false; code: StableCode };

const TOKEN = /^[0-9a-f]{32}$/;

function parseLock(text: string): LockRecordV1 | undefined {
	try {
		const value = JSON.parse(text) as Record<string, unknown>;
		if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
		if (Object.keys(value).sort().join(",") !== "createdAt,pid,schema,token,uid") return undefined;
		if (value.schema !== 1 || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) return undefined;
		if (
			!Number.isSafeInteger(value.uid) ||
			(value.uid as number) < 0 ||
			typeof value.token !== "string" ||
			!TOKEN.test(value.token)
		)
			return undefined;
		if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) return undefined;
		return value as unknown as LockRecordV1;
	} catch {
		return undefined;
	}
}

function processIsLive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export async function inspectLock(lockPath: string): Promise<LockInspection> {
	let stat: Awaited<ReturnType<typeof fs.lstat>>;
	try {
		stat = await fs.lstat(lockPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
		return { state: "malformed", code: "GJC_MCP_E_LOCK_MALFORMED" };
	}
	const uid = process.getuid?.();
	if (uid === undefined || stat.uid !== uid) return { state: "wrong-owner", code: "GJC_MCP_E_LOCK_OWNER" };
	if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== PRIVATE_FILE_MODE)
		return { state: "malformed", code: "GJC_MCP_E_LOCK_MALFORMED" };
	let record: LockRecordV1 | undefined;
	try {
		record = parseLock(await fs.readFile(lockPath, "utf8"));
	} catch {
		return { state: "malformed", code: "GJC_MCP_E_LOCK_MALFORMED" };
	}
	if (!record) return { state: "malformed", code: "GJC_MCP_E_LOCK_MALFORMED" };
	if (record.uid !== uid) return { state: "wrong-owner", code: "GJC_MCP_E_LOCK_OWNER" };
	return processIsLive(record.pid)
		? { state: "live", code: "GJC_MCP_E_BUSY" }
		: { state: "stale", code: "GJC_MCP_E_LOCK_STALE" };
}

async function safeRelease(lockPath: string, token: string): Promise<void> {
	try {
		const stat = await fs.lstat(lockPath);
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			stat.uid !== process.getuid?.() ||
			(stat.mode & 0o777) !== PRIVATE_FILE_MODE
		)
			return;
		const record = parseLock(await fs.readFile(lockPath, "utf8"));
		if (record?.token !== token || record.pid !== process.pid) return;
		await fs.unlink(lockPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
	}
}

type FileIdentity = Pick<Awaited<ReturnType<typeof fs.lstat>>, "dev" | "ino">;

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

async function unlinkIfIdentity(file: string, expected: FileIdentity): Promise<boolean> {
	try {
		const current = await fs.lstat(file);
		if (!sameIdentity(current, expected)) return false;
		await fs.unlink(file);
		return true;
	} catch {
		return false;
	}
}

async function claimStaleGuard(
	guardPath: string,
): Promise<{ identity: FileIdentity; release: () => Promise<void> } | null> {
	const claimPath = `${guardPath}.claim`;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await fs.link(guardPath, claimPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
			if ((await inspectLock(claimPath)).state !== "stale") return null;
			const abandoned = await fs.lstat(claimPath).catch(() => null);
			if (!abandoned || !(await unlinkIfIdentity(claimPath, abandoned))) return null;
			continue;
		}
		const [guard, claim] = await Promise.all([
			fs.lstat(guardPath).catch(() => null),
			fs.lstat(claimPath).catch(() => null),
		]);
		if (!guard || !claim || !sameIdentity(guard, claim) || (await inspectLock(claimPath)).state !== "stale") {
			if (claim) await unlinkIfIdentity(claimPath, claim);
			return null;
		}
		return {
			identity: claim,
			release: async () => {
				await unlinkIfIdentity(claimPath, claim);
			},
		};
	}
	return null;
}

async function acquireTakeoverGuard(lockPath: string): Promise<(() => Promise<void>) | null> {
	const uid = process.getuid?.();
	if (uid === undefined) return null;
	const guardPath = `${lockPath}.takeover`;
	let releaseClaim: (() => Promise<void>) | null = null;
	for (let attempt = 0; attempt < 3; attempt++) {
		const token = crypto.randomBytes(16).toString("hex");
		const record: LockRecordV1 = {
			schema: 1,
			pid: process.pid,
			uid,
			token,
			createdAt: new Date().toISOString(),
		};
		try {
			const handle = await fs.open(guardPath, "wx", PRIVATE_FILE_MODE);
			try {
				await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await releaseClaim?.();
			return () => safeRelease(guardPath, token);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") break;
			const inspection = await inspectLock(guardPath);
			if (inspection.state !== "stale" || releaseClaim) break;
			const claim = await claimStaleGuard(guardPath);
			if (!claim) break;
			if (!(await unlinkIfIdentity(guardPath, claim.identity))) {
				await claim.release();
				break;
			}
			releaseClaim = claim.release;
		}
	}
	await releaseClaim?.();
	return null;
}

export async function acquireLock(lockPath: string): Promise<AcquireLockResult> {
	const uid = process.getuid?.();
	if (uid === undefined) return { ok: false, code: "GJC_MCP_E_LOCK_OWNER" };
	const releaseGuard = await acquireTakeoverGuard(lockPath);
	if (!releaseGuard) return { ok: false, code: "GJC_MCP_E_BUSY" };
	let replacedStale = false;
	try {
		for (let attempt = 0; attempt < 2; attempt++) {
			const token = crypto.randomBytes(16).toString("hex");
			const record: LockRecordV1 = {
				schema: 1,
				pid: process.pid,
				uid,
				token,
				createdAt: new Date().toISOString(),
			};
			try {
				const handle = await fs.open(lockPath, "wx", PRIVATE_FILE_MODE);
				try {
					await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
					await handle.sync();
				} finally {
					await handle.close();
				}
				return {
					ok: true,
					replacedStale,
					lock: { path: lockPath, token, release: () => safeRelease(lockPath, token) },
				};
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST")
					return { ok: false, code: "GJC_MCP_E_LOCK_MALFORMED" };
				const inspection = await inspectLock(lockPath);
				if (inspection.state !== "stale")
					return { ok: false, code: inspection.state === "absent" ? "GJC_MCP_E_LOCK_MALFORMED" : inspection.code };
				try {
					await fs.unlink(lockPath);
					replacedStale = true;
				} catch (unlinkError) {
					if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT")
						return { ok: false, code: "GJC_MCP_E_LOCK_MALFORMED" };
				}
			}
		}
		return { ok: false, code: "GJC_MCP_E_BUSY" };
	} finally {
		await releaseGuard();
	}
}
