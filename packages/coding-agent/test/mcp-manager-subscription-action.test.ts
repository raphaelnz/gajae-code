import { describe, expect, it, spyOn } from "bun:test";
import { logger } from "@gajae-code/utils";
import { subscribeToResources, unsubscribeFromResources } from "../src/runtime-mcp/client";
import { resolveSubscriptionPostAction } from "../src/runtime-mcp/manager";

describe("resolveSubscriptionPostAction", () => {
	it("returns rollback when notifications are disabled", () => {
		expect(resolveSubscriptionPostAction(false, 5, 5)).toBe("rollback");
		expect(resolveSubscriptionPostAction(false, 10, 2)).toBe("rollback");
	});

	it("returns ignore when notifications are enabled but epoch is stale", () => {
		expect(resolveSubscriptionPostAction(true, 8, 7)).toBe("ignore");
	});

	it("returns apply when notifications are enabled and epoch matches", () => {
		expect(resolveSubscriptionPostAction(true, 3, 3)).toBe("apply");
	});
});

describe("MCP resource diagnostic redaction", () => {
	it("logs stable metadata instead of rejected resource payloads", async () => {
		const canary = "authorization=secret-resource-canary";
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		const connection = {
			name: "synthetic",
			capabilities: { resources: { subscribe: true } },
			transport: {
				request: async () => {
					throw new Error(canary);
				},
			},
		} as never;

		await subscribeToResources(connection, ["secret://subscribe"]);
		await unsubscribeFromResources(connection, ["secret://unsubscribe"]);

		expect(warn).toHaveBeenCalledTimes(2);
		const rendered = JSON.stringify(warn.mock.calls);
		expect(rendered).toContain("MCP_RESOURCE_SUBSCRIBE_FAILED");
		expect(rendered).toContain("MCP_RESOURCE_UNSUBSCRIBE_FAILED");
		expect(rendered).not.toContain(canary);
		expect(rendered).not.toContain("secret://");
		warn.mockRestore();
	});
});
