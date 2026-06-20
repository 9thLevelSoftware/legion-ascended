import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { entityJsonSchemas, primitiveJsonSchemas } from "../dist/index.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

const schemaFileNames = {
  taskContract: "task-contract",
  taskRun: "task-run",
  evidenceBundle: "evidence",
  reviewDecision: "review"
};

async function readExistingLineEnding(filePath) {
  try {
    const existing = await readFile(filePath, "utf8");
    return existing.includes("\r\n") ? "\r\n" : "\n";
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return "\n";
    }

    throw error;
  }
}

async function writeSchemaGroup(schemaDirectory, schemas) {
  await mkdir(schemaDirectory, { recursive: true });

  for (const [name, schema] of Object.entries(schemas)) {
    const outputPath = join(schemaDirectory, `${schemaFileNames[name] ?? name}.schema.json`);
    const lineEnding = await readExistingLineEnding(outputPath);
    const document = JSON.stringify(schema, null, 2).replace(/\n/g, lineEnding);

    await writeFile(outputPath, `${document}${lineEnding}`, "utf8");
  }
}

await writeSchemaGroup(join(scriptDirectory, "..", "..", "..", "schemas", "primitives"), primitiveJsonSchemas);
await writeSchemaGroup(join(scriptDirectory, "..", "..", "..", "schemas", "entities"), entityJsonSchemas);
