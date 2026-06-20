import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { projectManifestJsonSchema } from "../dist/index.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const outputPath = join(scriptDirectory, "..", "..", "..", "schemas", "artifacts", "project-manifest.schema.json");

async function readExistingLineEnding(filePath) {
  try {
    const existing = await readFile(filePath, "utf8");
    return existing.includes("\r\n") ? "\r\n" : "\n";
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return "\n";
    throw error;
  }
}

await mkdir(dirname(outputPath), { recursive: true });
const lineEnding = await readExistingLineEnding(outputPath);
const document = JSON.stringify(projectManifestJsonSchema, null, 2).replace(/\n/g, lineEnding);
await writeFile(outputPath, `${document}${lineEnding}`, "utf8");
