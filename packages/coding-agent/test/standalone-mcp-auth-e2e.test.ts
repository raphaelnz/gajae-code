import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { discoverAndLoadMCPTools } from "../src/runtime-mcp/loader";
import type { JsonRpcMessage } from "../src/runtime-mcp/types";
import { createSyntheticAuthStorage, syntheticZeroToolServerScript } from "./mcp-test-utils";

function rpcResult(body: JsonRpcMessage): Record<string, unknown> {
	const id = "id" in body ? body.id : 0;
	if ("method" in body && body.method === "initialize") {
		return {
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: { name: "synthetic-http", version: "1" },
			},
		};
	}
	if ("method" in body && body.method === "tools/list") {
		return { jsonrpc: "2.0", id, result: { tools: [] } };
	}
	return { jsonrpc: "2.0", id, result: {} };
}

describe("standalone user-global MCP synthetic auth and transport coverage", () => {
	const originalAgentDir = getAgentDir();
	const originalAgentDirEnv = process.env.GJC_CODING_AGENT_DIR;
	const originalHome = process.env.HOME;
	const originalConfigDir = process.env.PI_CONFIG_DIR;
	const originalPath = process.env.PATH;
	const originalSecret = process.env.GJC_PLUGIN_TEST_SECRET;
	const originalHeaderCanary = process.env.GJC_MCP_HEADER_CANARY;
	let root = "";

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-standalone-mcp-auth-"));
		process.env.HOME = root;
		process.env.PI_CONFIG_DIR = ".gjc";
		setAgentDir(path.join(root, "custom-agent-dir"));
		await fs.mkdir(getAgentDir(), { recursive: true });
	});

	afterEach(async () => {
		setAgentDir(originalAgentDir);
		if (originalAgentDirEnv === undefined) delete process.env.GJC_CODING_AGENT_DIR;
		else process.env.GJC_CODING_AGENT_DIR = originalAgentDirEnv;
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
		else process.env.PI_CONFIG_DIR = originalConfigDir;
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		if (originalSecret === undefined) delete process.env.GJC_PLUGIN_TEST_SECRET;
		else process.env.GJC_PLUGIN_TEST_SECRET = originalSecret;
		if (originalHeaderCanary === undefined) delete process.env.GJC_MCP_HEADER_CANARY;
		else process.env.GJC_MCP_HEADER_CANARY = originalHeaderCanary;
		await fs.rm(root, { recursive: true, force: true });
	});

	it("loads only autoloadable user servers and resolves synthetic stdio, HTTP, and OAuth canaries", async () => {
		const cwd = path.join(root, "project");
		await fs.mkdir(cwd, { recursive: true });
		const fixture = path.join(import.meta.dir, "fixtures/gjc-plugins/valid-mcp-bundle/mcp/server.ts");
		const executableDir = path.dirname(process.execPath);
		process.env.PATH = `${executableDir}${path.delimiter}${originalPath ?? ""}`;
		process.env.GJC_PLUGIN_TEST_SECRET = "user-inherited-canary";
		process.env.GJC_MCP_HEADER_CANARY = "resolved-header-canary";

		const observedHeaders: Array<{ authorization: string | null; canary: string | null }> = [];
		const httpServer = Bun.serve({
			port: 0,
			async fetch(request) {
				if (request.method === "GET") return new Response(null, { status: 405 });
				observedHeaders.push({
					authorization: request.headers.get("authorization"),
					canary: request.headers.get("x-synthetic-canary"),
				});
				const body = (await request.json()) as JsonRpcMessage;
				return Response.json(rpcResult(body));
			},
		});
		const authStorage = await createSyntheticAuthStorage(root);
		await authStorage.set("synthetic-mcp-oauth", [
			{
				type: "oauth",
				access: "synthetic-access-token",
				refresh: "synthetic-refresh-token",
				expires: Date.now() + 60_000,
			},
		]);

		await fs.writeFile(
			path.join(cwd, ".mcp.json"),
			JSON.stringify({ mcpServers: { projectMustStayOff: { command: "definitely-not-a-real-command" } } }),
		);
		await fs.writeFile(path.join(getAgentDir(), ".mcp.json"), "{");
		const userConfigPath = path.join(getAgentDir(), "mcp.json");
		await fs.writeFile(
			userConfigPath,
			JSON.stringify({
				disabledServers: ["disabledByName"],
				mcpServers: {
					absolute: { type: "stdio", command: process.execPath, args: [fixture] },
					pathCommand: { type: "stdio", command: path.basename(process.execPath), args: [fixture] },
					zeroTools: {
						type: "stdio",
						command: process.execPath,
						args: ["-e", syntheticZeroToolServerScript()],
					},
					httpAuth: {
						type: "http",
						url: httpServer.url.href,
						headers: { "X-Synthetic-Canary": "GJC_MCP_HEADER_CANARY" },
						auth: { type: "oauth", credentialId: "synthetic-mcp-oauth" },
					},
					doNotAutoload: {
						type: "stdio",
						command: "definitely-not-a-real-command",
						autoload: false,
					},
					disabledByEnabled: {
						type: "stdio",
						command: "definitely-not-a-real-command",
						enabled: false,
					},
					disabledByName: {
						type: "stdio",
						command: "definitely-not-a-real-command",
					},
				},
			}),
		);

		let manager: Awaited<ReturnType<typeof discoverAndLoadMCPTools>>["manager"] | undefined;
		const loadOptions = {
			enableProjectConfig: false,
			autoloadOnly: true,
			providers: ["native"],
			home: root,
			sourcePaths: [userConfigPath],
			filterExa: false,
			filterBrowser: false,
			cacheStorage: null,
			authStorage,
			onConnecting: undefined,
		};
		try {
			const loaded = await discoverAndLoadMCPTools(cwd, loadOptions);
			manager = loaded.manager;

			expect(loaded.errors).toEqual([]);
			expect(loaded.connectedServers.sort()).toEqual(["absolute", "httpAuth", "pathCommand", "zeroTools"]);
			expect(loaded.tools.map(entry => entry.tool.name).sort()).toEqual([
				"mcp__absolute_lookup",
				"mcp__pathcommand_lookup",
			]);
			expect(observedHeaders.length).toBeGreaterThanOrEqual(2);
			for (const headers of observedHeaders) {
				expect(headers).toEqual({
					authorization: "Bearer synthetic-access-token",
					canary: "resolved-header-canary",
				});
			}

			const acceptedTool = loaded.tools.find(entry => entry.tool.name === "mcp__absolute_lookup")?.tool;
			expect(acceptedTool).toBeDefined();
			await fs.writeFile(
				userConfigPath,
				JSON.stringify({
					mcpServers: {
						nextSession: { type: "stdio", command: process.execPath, args: [fixture] },
					},
				}),
			);
			const result = await acceptedTool?.execute("synthetic-call", {}, undefined, {} as never);
			expect(result?.content).toEqual([{ type: "text", text: "secret=user-inherited-canary" }]);
			expect(acceptedTool?.name).toBe("mcp__absolute_lookup");
			expect(acceptedTool?.mcpToolName).toBe("lookup");
			await manager.disconnectAll();
			manager = undefined;
			const reloaded = await discoverAndLoadMCPTools(cwd, loadOptions);
			manager = reloaded.manager;
			expect(reloaded.errors).toEqual([]);
			expect(reloaded.connectedServers).toEqual(["nextSession"]);
			expect(reloaded.tools.map(entry => entry.tool.name)).toEqual(["mcp__nextsession_lookup"]);
		} finally {
			await manager?.disconnectAll();
			authStorage.close();
			await httpServer.stop(true);
		}
	});
	it("fails closed on malformed exact-source JSON without surfacing its contents", async () => {
		const cwd = path.join(root, "project");
		const userConfigPath = path.join(getAgentDir(), "mcp.json");
		await fs.mkdir(cwd, { recursive: true });
		await fs.writeFile(userConfigPath, '{"Authorization":"malformed-secret-canary"');

		const loaded = await discoverAndLoadMCPTools(cwd, {
			enableProjectConfig: false,
			autoloadOnly: true,
			providers: ["native"],
			home: root,
			sourcePaths: [userConfigPath],
			filterExa: false,
			cacheStorage: null,
		});
		try {
			expect(loaded.tools).toEqual([]);
			expect(loaded.connectedServers).toEqual([]);
			expect(loaded.errors).toEqual([{ path: ".mcp.json", error: "MCP configuration is invalid" }]);
			expect(JSON.stringify(loaded.errors)).not.toContain("malformed-secret-canary");
		} finally {
			await loaded.manager.disconnectAll();
		}
	});

	it("fails closed when the exact source cannot be read", async () => {
		const cwd = path.join(root, "project");
		const userConfigPath = path.join(getAgentDir(), "mcp.json");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(userConfigPath);

		const loaded = await discoverAndLoadMCPTools(cwd, {
			enableProjectConfig: false,
			autoloadOnly: true,
			providers: ["native"],
			home: root,
			sourcePaths: [userConfigPath],
			filterExa: false,
			cacheStorage: null,
		});
		try {
			expect(loaded.tools).toEqual([]);
			expect(loaded.connectedServers).toEqual([]);
			expect(loaded.errors).toEqual([{ path: ".mcp.json", error: "MCP configuration is invalid" }]);
		} finally {
			await loaded.manager.disconnectAll();
		}
	});

	const invalidCatalogCases: Array<[string, Record<string, unknown>]> = [
		["missing endpoint", { type: "stdio" }],
		["unknown transport", { type: "bogus", command: process.execPath }],
		["conflicting endpoints", { type: "stdio", command: process.execPath, url: "http://127.0.0.1" }],
		["string enabled coercion", { type: "stdio", command: process.execPath, enabled: "malformed-secret-canary" }],
		["string timeout coercion", { type: "stdio", command: process.execPath, timeout: "1000" }],
		["string autoload coercion", { type: "stdio", command: process.execPath, autoload: "true" }],
		["string environment inheritance coercion", { type: "stdio", command: process.execPath, noInheritEnv: "true" }],
		["malformed arguments", { type: "stdio", command: process.execPath, args: [1] }],
		["malformed environment", { type: "stdio", command: process.execPath, env: { TOKEN: 1 } }],
		["malformed headers", { type: "http", url: "http://127.0.0.1", headers: { Authorization: 1 } }],
		["malformed auth", { type: "http", url: "http://127.0.0.1", auth: { type: "unknown" } }],
		["malformed oauth callback", { type: "http", url: "http://127.0.0.1", oauth: { callbackPort: -1 } }],
	];

	for (const [caseName, invalidConfig] of invalidCatalogCases) {
		it(`rejects ${caseName} before connecting a healthy catalog peer`, async () => {
			const cwd = path.join(root, "project");
			const userConfigPath = path.join(getAgentDir(), "mcp.json");
			let requestCount = 0;
			const httpServer = Bun.serve({
				port: 0,
				async fetch(request) {
					requestCount += 1;
					return Response.json(rpcResult((await request.json()) as JsonRpcMessage));
				},
			});
			await fs.mkdir(cwd, { recursive: true });
			await fs.writeFile(
				userConfigPath,
				JSON.stringify({
					mcpServers: {
						healthy: { type: "http", url: httpServer.url.href },
						invalid: invalidConfig,
					},
				}),
			);

			const loaded = await discoverAndLoadMCPTools(cwd, {
				enableProjectConfig: false,
				autoloadOnly: true,
				providers: ["native"],
				home: root,
				sourcePaths: [userConfigPath],
				filterExa: false,
				cacheStorage: null,
			});
			try {
				expect(loaded.tools).toEqual([]);
				expect(loaded.connectedServers).toEqual([]);
				expect(loaded.errors).toEqual([{ path: ".mcp.json", error: "MCP configuration is invalid" }]);
				expect(JSON.stringify(loaded.errors)).not.toContain("malformed-secret-canary");
				expect(requestCount).toBe(0);
			} finally {
				await loaded.manager.disconnectAll();
				await httpServer.stop(true);
			}
		});
	}
});
