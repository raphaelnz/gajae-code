import { afterEach, describe, expect, it, mock } from "bun:test";
import * as mcpClient from "../src/runtime-mcp/client";
import { MCPManager } from "../src/runtime-mcp/manager";
import { HttpTransport } from "../src/runtime-mcp/transports/http";
import type { MCPServerConfig, MCPServerConnection, MCPTransport } from "../src/runtime-mcp/types";

// `mock.module` is process-global in Bun and is NOT reverted by `mock.restore()`.
// Capture the real client exports now — before any test mocks them — so afterEach
// can restore them. Without this, the stubbed connectToServer/listTools below leak
// into later test files (e.g. runtime-mcp/*), where real connections then hang until
// the startup race trips, surfacing as "MCP server connection timed out during startup".
const realClientModule = { ...mcpClient };

function makeConnection(name: string, close: () => Promise<void> = async () => {}): MCPServerConnection {
	return {
		name,
		config: { type: "stdio", command: "test" },
		transport: {
			connected: true,
			async request() {
				throw new Error("unused");
			},
			async notify() {},
			close,
		} satisfies MCPTransport,
		serverInfo: { name: "test", version: "1.0" },
		capabilities: { tools: {} },
	};
}

describe("MCP lifecycle cleanup", () => {
	afterEach(() => {
		mock.module("../src/runtime-mcp/client", () => realClientModule);
		mock.restore();
		MCPManager.resetForTests();
	});

	it("disconnectServer aborts pending initial connection work", async () => {
		let capturedSignal: AbortSignal | undefined;
		let lateConnectionCloseCount = 0;
		const release = Promise.withResolvers<MCPServerConnection>();
		mock.module("../src/runtime-mcp/client", () => ({
			...mcpClient,
			connectToServer: (_name: string, _config: MCPServerConfig, options?: { signal?: AbortSignal }) => {
				capturedSignal = options?.signal;
				return release.promise;
			},
			listTools: async () => [],
		}));
		const { MCPManager: MockedManager } = await import("../src/runtime-mcp/manager");
		const manager = new MockedManager(process.cwd());

		const load = manager.connectServers(
			{ slow: { type: "stdio", command: "slow", timeout: 10_000 } },
			{ slow: { provider: "test", providerName: "Test", path: "test", level: "project" } },
		);
		await Bun.sleep(0);

		await manager.disconnectServer("slow");
		expect(capturedSignal?.aborted).toBe(true);

		release.resolve(
			makeConnection("slow", async () => {
				lateConnectionCloseCount++;
			}),
		);
		await load;
		await Bun.sleep(0);

		expect(manager.getConnection("slow")).toBeUndefined();
		expect(lateConnectionCloseCount).toBe(1);
	});

	it("disconnectAll aborts pending initial connection work", async () => {
		let capturedSignal: AbortSignal | undefined;
		const release = Promise.withResolvers<MCPServerConnection>();
		mock.module("../src/runtime-mcp/client", () => ({
			...mcpClient,
			connectToServer: (_name: string, _config: MCPServerConfig, options?: { signal?: AbortSignal }) => {
				capturedSignal = options?.signal;
				return release.promise;
			},
			listTools: async () => [],
		}));
		const { MCPManager: MockedManager } = await import("../src/runtime-mcp/manager");
		const manager = new MockedManager(process.cwd());

		const load = manager.connectServers(
			{ slow: { type: "stdio", command: "slow", timeout: 10_000 } },
			{ slow: { provider: "test", providerName: "Test", path: "test", level: "project" } },
		);
		await Bun.sleep(0);

		await manager.disconnectAll();
		expect(capturedSignal?.aborted).toBe(true);

		release.resolve(makeConnection("slow"));
		await load;
		expect(manager.getConnection("slow")).toBeUndefined();
	});

	it("disconnectAll closes each successfully owned connection exactly once", async () => {
		const close = mock(async () => {});
		mock.module("../src/runtime-mcp/client", () => ({
			...mcpClient,
			connectToServer: async (name: string) => makeConnection(name, close),
			listTools: async () => [],
		}));
		const { MCPManager: MockedManager } = await import("../src/runtime-mcp/manager");
		const manager = new MockedManager(process.cwd());

		const result = await manager.connectServers(
			{ owned: { type: "stdio", command: "synthetic" } },
			{ owned: { provider: "test", providerName: "Test", path: "test", level: "user" } },
		);
		expect(result.connectedServers).toEqual(["owned"]);

		await manager.disconnectAll();
		await manager.disconnectAll();

		expect(close).toHaveBeenCalledTimes(1);
	});

	it("closes a connection exactly once when initial tool enumeration fails", async () => {
		const close = mock(async () => {});
		mock.module("../src/runtime-mcp/client", () => ({
			...mcpClient,
			connectToServer: async (name: string) => makeConnection(name, close),
			listTools: async () => {
				throw new Error("synthetic tools/list failure");
			},
		}));
		const { MCPManager: MockedManager } = await import("../src/runtime-mcp/manager");
		const manager = new MockedManager(process.cwd());

		const result = await manager.connectServers(
			{ failing: { type: "stdio", command: "synthetic" } },
			{ failing: { provider: "test", providerName: "Test", path: "test", level: "user" } },
		);
		await manager.disconnectAll();

		expect(result.connectedServers).toEqual([]);
		expect(result.errors.get("failing")).toContain("synthetic tools/list failure");
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("waits for an uncached MCP within the default connection timeout", async () => {
		mock.module("../src/runtime-mcp/client", () => ({
			...mcpClient,
			connectToServer: async (name: string) => {
				await Bun.sleep(350);
				return makeConnection(name);
			},
			listTools: async () => [],
		}));
		const { MCPManager: MockedManager } = await import("../src/runtime-mcp/manager");
		const manager = new MockedManager(process.cwd());

		const result = await manager.connectServers(
			{ slow: { type: "stdio", command: "slow" } },
			{ slow: { provider: "test", providerName: "Test", path: "test", level: "user" } },
		);

		expect(result.connectedServers).toEqual(["slow"]);
		expect(result.errors.size).toBe(0);
		await manager.disconnectAll();
	});

	it("connectServers fails fast when an uncached MCP startup ignores abort", async () => {
		let capturedSignal: AbortSignal | undefined;
		mock.module("../src/runtime-mcp/client", () => ({
			...mcpClient,
			connectToServer: (_name: string, _config: MCPServerConfig, options?: { signal?: AbortSignal }) => {
				capturedSignal = options?.signal;
				return new Promise<MCPServerConnection>(() => {});
			},
			listTools: async () => [],
		}));
		const { MCPManager: MockedManager } = await import("../src/runtime-mcp/manager");
		const manager = new MockedManager(process.cwd());

		const startedAt = Date.now();
		const result = await manager.connectServers(
			{ stuck: { type: "stdio", command: "stuck", timeout: 100 } },
			{ stuck: { provider: "test", providerName: "Test", path: "test", level: "project" } },
		);

		expect(Date.now() - startedAt).toBeLessThan(2_000);
		expect(capturedSignal?.aborted).toBe(true);
		expect(result.tools).toHaveLength(0);
		expect(result.errors.get("stuck")).toBe("MCP server connection timed out during startup: stuck");
		expect(manager.getConnectionStatus("stuck")).toBe("disconnected");
	});

	it("HttpTransport.close aborts and settles background SSE readers without reconnect", async () => {
		const originalFetch = globalThis.fetch;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('data: {"jsonrpc":"2.0","method":"ping"}\n\n'));
			},
		});
		globalThis.fetch = (async () =>
			new Response(stream, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			})) as unknown as typeof fetch;
		try {
			const transport = new HttpTransport({ type: "http", url: "http://example.test/mcp", timeout: 10_000 });
			let closeEvents = 0;
			transport.onClose = () => {
				closeEvents++;
			};
			await transport.connect();
			await transport.startSSEListener();

			await transport.close();

			expect(transport.connected).toBe(false);
			expect(closeEvents).toBe(1);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
