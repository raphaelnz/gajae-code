import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { getAgentDir, setAgentDir, VERSION } from "@gajae-code/utils";
import * as z from "zod/v4";
import type { Args, Mode } from "../src/cli/args";
import { ModelRegistry } from "../src/config/model-registry";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import type { CustomTool } from "../src/extensibility/custom-tools/types";
import { runRootCommand } from "../src/main";
import * as realInteractiveMode from "../src/modes/interactive-mode";
import * as runtimeMcp from "../src/runtime-mcp";
import { MCPManager } from "../src/runtime-mcp/manager";
import { type CreateAgentSessionOptions, createAgentSession } from "../src/sdk";
import { SessionManager } from "../src/session/session-manager";
import { writeCredentialImportMarker } from "../src/setup/credential-auto-import";
import { createSyntheticAuthStorage } from "./mcp-test-utils";

const STOP = new Error("captured standalone MCP routing");

function argsFor(mode: Mode | undefined, print = false): Args {
	return {
		mode,
		print,
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		noSkills: true,
		noRules: true,
		noTools: true,
		noLsp: true,
	};
}

function syntheticSessionResult(
	manager: MCPManager,
	standaloneMcpFrozen: boolean,
	model = getBundledModel("openai", "gpt-4o-mini"),
) {
	return {
		session: {
			model,
			extensionRunner: undefined,
			prompt: async () => {},
			dispose: async () => {},
		},
		setToolUIContext: () => {},
		lspServers: [],
		mcpManager: manager,
		standaloneMcpFrozen,
	};
}

describe("standalone MCP mode isolation", () => {
	const originalAgentDir = getAgentDir();
	const originalAgentDirEnv = process.env.GJC_CODING_AGENT_DIR;
	const originalNoPty = process.env.PI_NO_PTY;
	const originalNoTitle = process.env.PI_NO_TITLE;
	let root = "";

	beforeEach(async () => {
		resetSettingsForTest();
		root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-standalone-mcp-mode-"));
		setAgentDir(path.join(root, "agent"));
		await writeCredentialImportMarker(VERSION, getAgentDir());
		await Settings.init({
			agentDir: getAgentDir(),
			cwd: root,
			inMemory: true,
			overrides: {
				"marketplace.autoUpdate": "off",
				"startup.checkUpdate": false,
			},
		});
	});

	afterEach(async () => {
		resetSettingsForTest();
		setAgentDir(originalAgentDir);
		if (originalAgentDirEnv === undefined) delete process.env.GJC_CODING_AGENT_DIR;
		else process.env.GJC_CODING_AGENT_DIR = originalAgentDirEnv;
		if (originalNoPty === undefined) delete process.env.PI_NO_PTY;
		else process.env.PI_NO_PTY = originalNoPty;
		if (originalNoTitle === undefined) delete process.env.PI_NO_TITLE;
		else process.env.PI_NO_TITLE = originalNoTitle;
		MCPManager.resetForTests();
		mock.module("../src/modes/interactive-mode", () => realInteractiveMode);
		mock.restore();
		await fs.rm(root, { recursive: true, force: true });
	});

	for (const route of [
		{ label: "explicit text", mode: "text" as const, print: false },
		{ label: "default TUI", mode: undefined, print: false },
		{ label: "print", mode: undefined, print: true },
	]) {
		it(`${route.label} opts into standalone user-global MCP`, async () => {
			const authStorage = await createSyntheticAuthStorage(root);
			let captured: CreateAgentSessionOptions | undefined;
			try {
				await expect(
					runRootCommand(argsFor(route.mode, route.print), [], {
						discoverAuthStorage: async () => authStorage,
						settings: Settings.isolated({ "marketplace.autoUpdate": "off" }),
						createAgentSession: async options => {
							captured = options;
							throw STOP;
						},
					}),
				).rejects.toBe(STOP);
				expect(captured?.enableMCP).toBe(true);
			} finally {
				authStorage.close();
			}
		});
	}

	for (const mode of ["rpc", "rpc-ui", "bridge"] as const) {
		it(`${mode} does not opt into standalone MCP`, async () => {
			const authStorage = await createSyntheticAuthStorage(root);
			let captured: CreateAgentSessionOptions | undefined;
			try {
				await expect(
					runRootCommand(argsFor(mode), [], {
						discoverAuthStorage: async () => authStorage,
						settings: Settings.isolated({ "marketplace.autoUpdate": "off" }),
						createAgentSession: async options => {
							captured = options;
							throw STOP;
						},
					}),
				).rejects.toBe(STOP);
				expect(captured?.enableMCP).toBe(false);
			} finally {
				authStorage.close();
			}
		});
	}

	it("keeps frozen standalone managers out of mutable TUI control without changing plugin-only routing", async () => {
		const authStorage = await createSyntheticAuthStorage(root);
		const frozenManager = { kind: "frozen-user-global" } as unknown as MCPManager;
		const pluginManager = { kind: "plugin-only" } as unknown as MCPManager;
		const capturedManagers: Array<MCPManager | undefined> = [];

		class StubInteractiveMode {
			constructor(
				_session: unknown,
				_version: string,
				_changelog: unknown,
				_setToolUIContext: unknown,
				_lspServers: unknown,
				manager: MCPManager | undefined,
			) {
				capturedManagers.push(manager);
			}

			async init() {}
			renderInitialMessages() {}
			showNewVersionNotification() {}
			async getUserInput(): Promise<never> {
				throw STOP;
			}
		}

		mock.module("../src/modes/interactive-mode", () => ({
			...realInteractiveMode,
			InteractiveMode: StubInteractiveMode,
		}));

		try {
			for (const [manager, standaloneMcpFrozen] of [
				[frozenManager, true],
				[pluginManager, false],
			] as const) {
				await expect(
					runRootCommand(argsFor(undefined), [], {
						discoverAuthStorage: async () => authStorage,
						settings: Settings.isolated({
							"marketplace.autoUpdate": "off",
							"startup.checkUpdate": false,
						}),
						createAgentSession: async () => syntheticSessionResult(manager, standaloneMcpFrozen) as never,
					}),
				).rejects.toBe(STOP);
			}

			expect(capturedManagers).toEqual([undefined, pluginManager]);
		} finally {
			mock.module("../src/modes/interactive-mode", () => realInteractiveMode);
			authStorage.close();
		}
	});

	it("awaits one session disposal before exiting a non-interactive no-model failure", async () => {
		const authStorage = await createSyntheticAuthStorage(root);
		const events: string[] = [];
		let disposeCalls = 0;
		const session = {
			model: undefined,
			extensionRunner: undefined,
			async dispose() {
				disposeCalls++;
				await Promise.resolve();
				events.push("disposed");
			},
		};
		const exit = spyOn(process, "exit").mockImplementation((code?: string | number | null): never => {
			events.push(`exit:${code}`);
			throw STOP;
		});
		const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);

		try {
			await expect(
				runRootCommand(argsFor("text"), [], {
					discoverAuthStorage: async () => authStorage,
					settings: Settings.isolated({
						"marketplace.autoUpdate": "off",
						"startup.checkUpdate": false,
					}),
					createAgentSession: async () =>
						({
							session,
							setToolUIContext: () => {},
							lspServers: [],
						}) as never,
				}),
			).rejects.toBe(STOP);

			expect(disposeCalls).toBe(1);
			expect(events).toEqual(["disposed", "exit:1"]);
		} finally {
			exit.mockRestore();
			stderr.mockRestore();
			authStorage.close();
		}
	});

	it("ACP-created sessions remain isolated even when their base options are mutated", async () => {
		const authStorage = await createSyntheticAuthStorage(root);
		let captured: CreateAgentSessionOptions | undefined;
		try {
			await expect(
				runRootCommand(argsFor("acp"), [], {
					discoverAuthStorage: async () => authStorage,
					settings: Settings.isolated({ "marketplace.autoUpdate": "off" }),
					createAgentSession: async options => {
						captured = options;
						throw STOP;
					},
					runAcpMode: async createSession => {
						await createSession(root);
					},
				}),
			).rejects.toBe(STOP);
			expect(captured?.enableMCP).toBe(false);
		} finally {
			authStorage.close();
		}
	});

	it("does not discover or inherit user-global MCP in a subsession", async () => {
		const authStorage = await createSyntheticAuthStorage(root);
		const supplied = new MCPManager(root);
		const disconnect = spyOn(supplied, "disconnectAll");
		const discovery = spyOn(runtimeMcp, "discoverAndLoadMCPTools");
		try {
			const { session, mcpManager } = await createAgentSession({
				cwd: root,
				agentDir: getAgentDir(),
				authStorage,
				modelRegistry: new ModelRegistry(authStorage),
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({}),
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: true,
				mcpManager: supplied,
				parentTaskPrefix: "1-synthetic-child",
				enableLsp: false,
				toolNames: ["read"],
			});

			expect(discovery).not.toHaveBeenCalled();
			expect(mcpManager).toBeUndefined();
			expect(session.getAllToolNames().filter(name => name.startsWith("mcp__"))).toEqual([]);
			await session.dispose();
			expect(disconnect).not.toHaveBeenCalled();
		} finally {
			discovery.mockRestore();
			authStorage.close();
		}
	});

	it("keeps a connected zero-tool user server alive through startup and disposes it exactly once", async () => {
		const authStorage = await createSyntheticAuthStorage(root);
		const manager = new MCPManager(root);
		const disconnect = spyOn(manager, "disconnectAll");
		const discovery = spyOn(runtimeMcp, "discoverAndLoadMCPTools").mockResolvedValue({
			manager,
			tools: [],
			errors: [],
			connectedServers: ["zeroTools"],
			exaApiKeys: [],
		});
		try {
			const { session, mcpManager } = await createAgentSession({
				cwd: root,
				agentDir: getAgentDir(),
				authStorage,
				modelRegistry: new ModelRegistry(authStorage),
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({}),
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: true,
				enableLsp: false,
				toolNames: ["read"],
			});

			expect(mcpManager).toBe(manager);
			expect(discovery).toHaveBeenCalledWith(root, {
				enableProjectConfig: false,
				autoloadOnly: true,
				providers: ["native"],
				sourcePaths: [path.join(getAgentDir(), "mcp.json")],
				filterExa: false,
				filterBrowser: false,
				cacheStorage: null,
				authStorage,
				onConnecting: undefined,
			});
			expect(session.getAllToolNames().filter(name => name.startsWith("mcp__"))).toEqual([]);
			await session.dispose();
			await session.dispose();
			expect(disconnect).toHaveBeenCalledTimes(1);
		} finally {
			discovery.mockRestore();
			authStorage.close();
		}
	});

	it("freezes the accepted registry definition while keeping invocation bound to the reconnectable MCP tool", async () => {
		const authStorage = await createSyntheticAuthStorage(root);
		const manager = new MCPManager(root);
		const disconnect = spyOn(manager, "disconnectAll");
		let executeCalls = 0;
		const sourceTool: CustomTool = {
			name: "mcp__synthetic_lookup",
			label: "synthetic/lookup",
			description: "original definition",
			mcpServerName: "synthetic",
			mcpToolName: "lookup",
			parameters: z.object({}),
			async execute() {
				executeCalls++;
				return { content: [{ type: "text", text: "original MCP result" }] };
			},
		};
		const discovery = spyOn(runtimeMcp, "discoverAndLoadMCPTools").mockResolvedValue({
			manager,
			tools: [{ path: "mcp:synthetic", resolvedPath: "mcp:mcp__synthetic_lookup", tool: sourceTool }],
			errors: [],
			connectedServers: ["synthetic"],
			exaApiKeys: [],
		});
		try {
			const { session } = await createAgentSession({
				cwd: root,
				agentDir: getAgentDir(),
				authStorage,
				modelRegistry: new ModelRegistry(authStorage),
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({}),
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: true,
				enableLsp: false,
				toolNames: ["read"],
			});

			Object.defineProperty(sourceTool, "name", { value: "mcp__mutated" });
			Object.defineProperty(sourceTool, "description", { value: "mutated source definition" });
			expect(session.agent.state.tools.some(tool => tool.name === "mcp__mutated")).toBe(false);
			const bridgedTool = session.agent.state.tools.find(tool => tool.name === "mcp__synthetic_lookup");
			expect(bridgedTool?.description).toBe("original definition");
			const result = await bridgedTool?.execute("synthetic-call", {});
			expect(result?.content).toEqual([{ type: "text", text: "original MCP result" }]);
			expect(executeCalls).toBe(1);
			await session.dispose();
			expect(disconnect).toHaveBeenCalledTimes(1);
		} finally {
			discovery.mockRestore();
			authStorage.close();
		}
	});

	it("rejects an extension collision with an accepted standalone MCP tool", async () => {
		const authStorage = await createSyntheticAuthStorage(root);
		const manager = new MCPManager(root);
		const disconnect = spyOn(manager, "disconnectAll");
		const sourceTool: CustomTool = {
			name: "mcp__synthetic_lookup",
			label: "synthetic/lookup",
			description: "standalone MCP tool",
			mcpServerName: "synthetic",
			mcpToolName: "lookup",
			parameters: z.object({}),
			async execute() {
				return { content: [{ type: "text", text: "standalone" }] };
			},
		};
		const discovery = spyOn(runtimeMcp, "discoverAndLoadMCPTools").mockResolvedValue({
			manager,
			tools: [{ path: "mcp:synthetic", resolvedPath: "mcp:mcp__synthetic_lookup", tool: sourceTool }],
			errors: [],
			connectedServers: ["synthetic"],
			exaApiKeys: [],
		});
		try {
			await expect(
				createAgentSession({
					cwd: root,
					agentDir: getAgentDir(),
					authStorage,
					modelRegistry: new ModelRegistry(authStorage),
					sessionManager: SessionManager.inMemory(),
					settings: Settings.isolated({}),
					model: getBundledModel("openai", "gpt-4o-mini"),
					disableExtensionDiscovery: true,
					extensions: [
						api => {
							api.registerTool({
								name: "mcp__synthetic_lookup",
								label: "colliding extension",
								description: "must not replace MCP",
								parameters: z.object({}),
								async execute() {
									return { content: [{ type: "text", text: "extension" }] };
								},
							});
						},
					],
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: true,
					enableLsp: false,
					toolNames: ["read"],
				}),
			).rejects.toThrow("MCP_CATALOG_COLLISION");
			expect(disconnect).toHaveBeenCalledTimes(1);
		} finally {
			discovery.mockRestore();
			authStorage.close();
		}
	});

	it("disconnects an owned manager exactly once when standalone startup fails", async () => {
		const authStorage = await createSyntheticAuthStorage(root);
		const manager = new MCPManager(root);
		const disconnect = spyOn(manager, "disconnectAll");
		const discovery = spyOn(runtimeMcp, "discoverAndLoadMCPTools").mockResolvedValue({
			manager,
			tools: [],
			errors: [{ path: "mcp:synthetic", error: "synthetic startup failure" }],
			connectedServers: [],
			exaApiKeys: [],
		});
		try {
			await expect(
				createAgentSession({
					cwd: root,
					agentDir: getAgentDir(),
					authStorage,
					modelRegistry: new ModelRegistry(authStorage),
					sessionManager: SessionManager.inMemory(),
					settings: Settings.isolated({}),
					model: getBundledModel("openai", "gpt-4o-mini"),
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: true,
					enableLsp: false,
					toolNames: ["read"],
				}),
			).rejects.toThrow("MCP_CONNECTION_FAILED");
			expect(disconnect).toHaveBeenCalledTimes(1);
		} finally {
			discovery.mockRestore();
			authStorage.close();
		}
	});
});
