import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { primitiveJsonSchemas } from "../dist/index.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const schemaDirectory = join(scriptDirectory, "..", "..", "..", "schemas", "primitives");

await mkdir(schemaDirectory, { recursive: true });

for (const [name, schema] of Object.entries(primitiveJsonSchemas)) {
  await writeFile(join(schemaDirectory, `${name}.schema.json`), `${JSON.stringify(schema, null, 2)}\n`, "utf8");
}
