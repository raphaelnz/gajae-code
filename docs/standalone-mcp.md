# Standalone GJC MCP support

GJC 0.9.6 can load user-global MCP servers directly in normal standalone text sessions.

## Runtime behavior

The following top-level CLI sessions load `~/.gjc/agent/mcp.json`:

- the normal interactive TUI (`gjc`);
- the TUI's tmux presentation child;
- explicit print/text mode;
- stdin-triggered automatic print mode.

Only entries whose `autoload` value is not literal `false` are attempted. Every tool from every successfully connected entry is exposed through the existing MCP tool bridge. GJC does not filter Exa, browser, or other tool names, and it does not load project MCP configuration for this feature.

The initial accepted catalog is fixed for the lifetime of the session. Tool-list additions, removals, schema changes, and configuration edits are picked up by the next session, not injected live. The interactive TUI does not expose its mutable MCP reload controller for this user-global manager. A server that disappears during a session returns its normal MCP call error.

## Isolation and ownership

User-global autoload is disabled for ACP, RPC, RPC-UI, bridge, embedded/default SDK use, and all subsessions and delegated agents. ACP clients and RPC hosts continue to own the tools they explicitly provide. Project configuration cannot enable user-global autoload.

Each eligible top-level session owns one MCP manager. Validated plugin MCP servers use that same manager when their server and tool names do not collide. The manager is disconnected once when startup is empty, incomplete, invalid, or fails, and once when a successful session is disposed. A manager explicitly supplied by a top-level SDK caller remains caller-owned. The user-global manager and user tools are not inherited by subsessions; the frozen plugin-only tool partition remains inherited for compatibility with the existing plugin-bundle contract.

Startup is complete-or-fail. Connection failures, duplicate server identities, duplicate tool names, collisions with built-in/custom/plugin tools, and malformed catalogs abort startup rather than silently dropping a server. Zero-tool connected servers participate in server-name collision checks.

## Configuration and security scope

Manage standalone registrations with GJC's own commands:

```bash
gjc mcp add context7 npx -y @upstash/context7-mcp
gjc mcp add docs --type http --url https://example.test/mcp --header Authorization="Bearer $TOKEN"
gjc mcp list
gjc mcp remove context7
```

These commands use GJC's user-global MCP configuration by default; `--project` remains storage and management functionality and is not part of standalone autoload. Explicit `autoload:false` is the supported per-server opt-out. Configuration changes affect the next standalone session and never mutate the accepted catalog of a running session.

GJC does not inherit Claude Code, Codex, Cursor, Gemini, Windsurf, or other products' MCP files. Existing env, header, OAuth, and bare-executable resolution is handled by the canonical MCP loader and `AuthStorage`. Startup diagnostics do not print resolved configuration, environment values, headers, URLs, arguments, OAuth material, tool schemas, or raw connection errors.

MCP servers can execute local programs, reach networks and files, and use stored credentials. Only register servers you trust, restrict their credentials and filesystem access, and use `autoload:false` when a server should require deliberate activation in another host.

## Related docs

- [Coordinator MCP bridge](./hermes-mcp-bridge.md)
- [External control surface readiness](./external-control-readiness.md)
- [RPC Protocol Reference](./rpc.md)
- [OpenClaw / Hermes RPC integration notes](./openclaw-hermes-rpc-integration.md)