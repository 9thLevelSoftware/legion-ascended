import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  apiContractDocumentation,
  apiJsonSchemas,
  entityJsonSchemas,
  eventContractDocumentation,
  eventJsonSchemas,
  primitiveJsonSchemas
} from "../dist/index.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

const schemaFileNames = {
  taskContract: "task-contract",
  taskRun: "task-run",
  evidenceBundle: "evidence",
  reviewDecision: "review",
  fixtureCorpus: "fixture-corpus",
  compatibilityFixture: "compatibility-fixture",
  commandEnvelope: "command-envelope",
  commandResult: "command-result",
  queryRequest: "query-request",
  queryResponse: "query-response"
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

async function writeTextFile(outputPath, contents) {
  await mkdir(dirname(outputPath), { recursive: true });

  const lineEnding = await readExistingLineEnding(outputPath);
  const document = contents.replace(/\n/g, lineEnding);

  await writeFile(outputPath, `${document}${lineEnding}`, "utf8");
}

await writeSchemaGroup(join(scriptDirectory, "..", "..", "..", "schemas", "primitives"), primitiveJsonSchemas);
await writeSchemaGroup(join(scriptDirectory, "..", "..", "..", "schemas", "entities"), entityJsonSchemas);
await writeSchemaGroup(join(scriptDirectory, "..", "..", "..", "schemas", "events"), eventJsonSchemas);
await writeSchemaGroup(join(scriptDirectory, "..", "..", "..", "schemas", "api"), apiJsonSchemas);
await writeTextFile(join(scriptDirectory, "..", "..", "..", "schemas", "events", "README.md"), eventContractDocumentation);
await writeTextFile(join(scriptDirectory, "..", "..", "..", "schemas", "api", "README.md"), apiContractDocumentation);
