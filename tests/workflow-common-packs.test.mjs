import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKS = [
  {
    path: "skills/workflow-common-core/SKILL.md",
    id: "workflow-common-core"
  },
  {
    path: "skills/workflow-common-github/SKILL.md",
    id: "workflow-common-github"
  },
  {
    path: "skills/workflow-common-memory/SKILL.md",
    id: "workflow-common-memory"
  },
  {
    path: "skills/workflow-common-domains/SKILL.md",
    id: "workflow-common-domains"
  }
];

function readFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, "expected YAML frontmatter");

  const frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!keyMatch) continue;
    frontmatter[keyMatch[1]] = keyMatch[2];
  }

  return frontmatter;
}

test("workflow-common packs are versioned extracted content", async () => {
  for (const pack of PACKS) {
    const contents = await readFile(path.join(ROOT, pack.path), "utf8");
    const frontmatter = readFrontmatter(contents);

    assert.equal(frontmatter.pack_id, pack.id);
    assert.equal(frontmatter.pack_version, "1.0.0");
    assert.equal(frontmatter.pack_status, "extracted");
    assert.match(contents, /## Versioned Domain Pack v1\.0\.0/);
    assert.match(contents, new RegExp(`extracted from the v8 ${pack.id.replace(/-/g, "-")}`));
  }
});
