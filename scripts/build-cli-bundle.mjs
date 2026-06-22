import { mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const OUTPUT_FILES = [
  "dist/legion-cli.mjs",
  "dist/legion-cli.mjs.map"
];

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

await Promise.all(OUTPUT_FILES.map(stripTrailingWhitespace));

async function stripTrailingWhitespace(filePath) {
  const text = await readFile(filePath, "utf8");
  const normalized = text.replace(/[ \t]+$/gm, "");
  if (normalized !== text) {
    await writeFile(filePath, normalized, "utf8");
  }
}
