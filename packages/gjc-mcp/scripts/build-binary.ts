import * as fs from "node:fs/promises";
import * as path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "..");
const output = path.join(packageRoot, "dist", "gjc-mcp");

await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
const result = await Bun.build({
	entrypoints: [path.join(packageRoot, "src", "main.ts")],
	compile: {
		target: "bun-darwin-arm64",
		outfile: output,
	},
	minify: false,
	sourcemap: "none",
});
if (!result.success) throw new Error("GJC_MCP_E_BUILD");
await fs.chmod(output, 0o755);
