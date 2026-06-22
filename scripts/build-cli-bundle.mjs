import { mkdir } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("dist", { recursive: true });

await build({
  entryPoints: ["packages/cli/src/index.ts"],
  outfile: "dist/legion-cli.mjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: true,
  external: [
    "node:*",
    "yaml"
  ]
});
