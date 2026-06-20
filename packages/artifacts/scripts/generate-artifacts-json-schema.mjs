import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  changeBundleJsonSchema,
  currentSpecDocumentJsonSchema,
  projectManifestJsonSchema
} from "../dist/index.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = join(scriptDirectory, "..", "..", "..", "schemas", "artifacts");
const outputSchemas = {
  "change-bundle.schema.json": changeBundleJsonSchema,
  "project-manifest.schema.json": projectManifestJsonSchema,
  "spec-document.schema.json": currentSpecDocumentJsonSchema
};

async function readExistingLineEnding(filePath) {
  try {
    const existing = await readFile(filePath, "utf8");
    return existing.includes("\r\n") ? "\r\n" : "\n";
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return "\n";
    throw error;
  }
}

await mkdir(outputDirectory, { recursive: true });
for (const [fileName, schema] of Object.entries(outputSchemas)) {
  const outputPath = join(outputDirectory, fileName);
  const lineEnding = await readExistingLineEnding(outputPath);
  const document = JSON.stringify(schema, null, 2).replace(/\n/g, lineEnding);
  await writeFile(outputPath, `${document}${lineEnding}`, "utf8");
}
