import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_REQUIRE = createRequire(new URL("../packages/cli/package.json", import.meta.url));
const OUTPUT_FILES = [
  resolve(ROOT, "dist/legion-cli.mjs"),
  resolve(ROOT, "dist/legion-cli.mjs.map")
];
const RUNTIME_ASSETS = Object.freeze([
  ["web-tree-sitter/web-tree-sitter.wasm", "dist/web-tree-sitter.wasm"],
  ["tree-sitter-wasms/out/tree-sitter-javascript.wasm", "dist/tree-sitter-javascript.wasm"],
  ["tree-sitter-wasms/out/tree-sitter-typescript.wasm", "dist/tree-sitter-typescript.wasm"],
  ["tree-sitter-wasms/out/tree-sitter-tsx.wasm", "dist/tree-sitter-tsx.wasm"],
  ["tree-sitter-wasms/out/tree-sitter-python.wasm", "dist/tree-sitter-python.wasm"],
  ["tree-sitter-wasms/out/tree-sitter-json.wasm", "dist/tree-sitter-json.wasm"],
  ["tree-sitter-wasms/out/tree-sitter-yaml.wasm", "dist/tree-sitter-yaml.wasm"]
]);

await mkdir(resolve(ROOT, "dist"), { recursive: true });

await build({
  entryPoints: [resolve(ROOT, "packages/cli/src/index.ts")],
  outfile: resolve(ROOT, "dist/legion-cli.mjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: true,
  sourcesContent: false,
  external: [
    "node:*",
    "yaml"
  ]
});

await Promise.all(OUTPUT_FILES.map(stripTrailingWhitespace));
await Promise.all(RUNTIME_ASSETS.map(copyRuntimeAsset));

function resolveRequiredAsset(specifier) {
  try {
    return CLI_REQUIRE.resolve(specifier);
  } catch (error) {
    throw new Error(
      `Unable to package required runtime asset ${specifier}. Resolve it from the @legion/cli dependency installation.`,
      { cause: error }
    );
  }
}

async function copyRuntimeAsset([specifier, destination]) {
  const source = resolveRequiredAsset(specifier);
  const output = resolve(ROOT, destination);
  try {
    await copyFile(source, output);
  } catch (error) {
    throw new Error(`Unable to copy required runtime asset ${specifier} to ${destination}.`, { cause: error });
  }
}

async function stripTrailingWhitespace(filePath) {
  const text = await readFile(filePath, "utf8");
  const normalized = text.replace(/[ \t]+$/gm, "");
  if (normalized !== text) {
    await writeFile(filePath, normalized, "utf8");
  }
}
