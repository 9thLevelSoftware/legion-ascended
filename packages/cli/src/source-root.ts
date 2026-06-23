import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function resolveCliSourceRoot(importMetaUrl: string, requiredRelativePath: string): string {
  const moduleDirectory = path.dirname(fileURLToPath(importMetaUrl));
  const candidates = [
    // Bundled root CLI: dist/legion-cli.mjs -> package root.
    path.resolve(moduleDirectory, ".."),
    // Package CLI build: packages/cli/dist/commands/<group>/index.js -> repo root.
    path.resolve(moduleDirectory, "..", "..", "..", "..", "..")
  ];

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, requiredRelativePath))) return candidate;
  }

  return candidates[0] ?? process.cwd();
}
