#!/usr/bin/env node
/**
 * Bundles src/server.ts and every runtime dependency into a single
 * self-contained server/bundle.mjs.
 *
 * The point of bundling is that `npx -y github:MCP-Hive/apollo-io-mcp` then has
 * nothing to install and nothing to compile: npm clones the repo, finds no
 * runtime `dependencies` and no `prepare` script, and runs the bundle directly.
 * Upstream's `prepare` runs `tsc`, which for a git install means npm first
 * installs every devDependency (vitest, the MCP inspector, ...) — far too slow
 * for a Lambda cold start.
 *
 * Output is ESM because src/server.ts uses top-level await.
 */
import { build } from "esbuild";
import { fileURLToPath } from "url";
import { chmodSync } from "fs";
import path from "path";

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(root, "server/bundle.mjs");

await build({
  entryPoints: [path.join(root, "src/server.ts")],
  outfile: out,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  legalComments: "none",
  // A node builtin this esbuild version does not recognise as one.
  external: ["readline/promises"],
  // Some transitive dependencies are CommonJS and call require() for node
  // builtins, which does not exist in an ES module. esbuild's __require helper
  // forwards to a real `require` when one is in scope, so define one. The
  // module-level `require` that src/install.ts and src/skills.ts declare is
  // renamed by esbuild (to `require2`), so it does not collide with this one.
  banner: {
    js:
      "#!/usr/bin/env node\n" +
      'import { createRequire as __bundleCreateRequire } from "module";\n' +
      "var require = globalThis.require ?? __bundleCreateRequire(import.meta.url);\n",
  },
});

chmodSync(out, 0o755);
console.log("built server/bundle.mjs");
