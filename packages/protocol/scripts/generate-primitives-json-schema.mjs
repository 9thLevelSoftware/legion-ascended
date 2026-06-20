import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { entityJsonSchemas, primitiveJsonSchemas } from "../dist/index.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

async function writeSchemaGroup(schemaDirectory, schemas) {
  await mkdir(schemaDirectory, { recursive: true });

  for (const [name, schema] of Object.entries(schemas)) {
    await writeFile(join(schemaDirectory, `${name}.schema.json`), `${JSON.stringify(schema, null, 2)}\n`, "utf8");
  }
}

await writeSchemaGroup(join(scriptDirectory, "..", "..", "..", "schemas", "primitives"), primitiveJsonSchemas);
await writeSchemaGroup(join(scriptDirectory, "..", "..", "..", "schemas", "entities"), entityJsonSchemas);
