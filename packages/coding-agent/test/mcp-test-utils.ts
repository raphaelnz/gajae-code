import * as path from "node:path";
import { AuthStorage } from "@gajae-code/ai";
import type { MCPServerCapabilities, MCPServerConnection, MCPTransport } from "../src/runtime-mcp/types";

export function createMockTransport(
	responses: Map<string, unknown[]>,
	onRequest?: (method: string, params: Record<string, unknown> | undefined) => void,
): MCPTransport {
	const callCounts = new Map<string, number>();
	return {
		connected: true,
		async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
			onRequest?.(method, params);
			const count = callCounts.get(method) ?? 0;
			callCounts.set(method, count + 1);
			const queue = responses.get(method);
			if (!queue || count >= queue.length) {
				throw new Error(`No mock response for ${method} call #${count}`);
			}
			return queue[count] as T;
		},
		async notify() {},
		async close() {},
	};
}

export function createMockConnection(
	capabilities: MCPServerCapabilities,
	transport: MCPTransport,
): MCPServerConnection {
	return {
		name: "test-server",
		config: { type: "stdio" as const, command: "echo" },
		transport,
		serverInfo: { name: "test", version: "1.0" },
		capabilities,
	};
}

export async function createSyntheticAuthStorage(root: string): Promise<AuthStorage> {
	return await AuthStorage.create(path.join(root, "synthetic-auth.db"));
}

export function syntheticZeroToolServerScript(): string {
	return `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = message => process.stdout.write(JSON.stringify(message) + "\\n");
rl.on("line", line => {
	const request = JSON.parse(line);
	if (request.method === "initialize") {
		send({
			jsonrpc: "2.0",
			id: request.id,
			result: {
				protocolVersion: "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: { name: "synthetic-zero-tools", version: "1" },
			},
		});
	} else if (request.method === "tools/list") {
		send({ jsonrpc: "2.0", id: request.id, result: { tools: [] } });
	} else if (request.id !== undefined) {
		send({ jsonrpc: "2.0", id: request.id, result: {} });
	}
});
`;
}
export function syntheticEnvEchoServerScript(variableName: string): string {
	return `
const readline = require("node:readline");
const variableName = ${JSON.stringify(variableName)};
const rl = readline.createInterface({ input: process.stdin });
const send = message => process.stdout.write(JSON.stringify(message) + "\\n");
rl.on("line", line => {
	const request = JSON.parse(line);
	if (request.method === "initialize") {
		send({
			jsonrpc: "2.0",
			id: request.id,
			result: {
				protocolVersion: "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: { name: "synthetic-env-echo", version: "1" },
			},
		});
	} else if (request.method === "tools/list") {
		send({
			jsonrpc: "2.0",
			id: request.id,
			result: {
				tools: [{ name: "lookup", description: "Echo one environment value", inputSchema: { type: "object" } }],
			},
		});
	} else if (request.method === "tools/call") {
		send({
			jsonrpc: "2.0",
			id: request.id,
			result: { content: [{ type: "text", text: "env=" + (process.env[variableName] || "<absent>") }] },
		});
	} else if (request.id !== undefined) {
		send({ jsonrpc: "2.0", id: request.id, result: {} });
	}
});
`;
}
