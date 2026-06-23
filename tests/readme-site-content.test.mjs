import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DONATION_URL = "https://ko-fi.com/vitruvianredux";
const REPO_URL = "https://github.com/9thLevelSoftware/legion-ascended";

async function readText(...segments) {
  return await readFile(path.join(ROOT, ...segments), "utf8");
}

function attributes(html, name) {
  const regex = new RegExp(`${name}="([^"]+)"`, "g");
  return [...html.matchAll(regex)].map((match) => match[1]);
}

test("README presents Legion Ascended as the current product front door", async () => {
  const readme = await readText("README.md");

  assert.match(readme, /^# Legion Ascended/m);
  assert.match(readme, /legion start -> legion plan -> legion build -> legion review -> legion ship/);
  assert.match(readme, /Recommended first-class targets/);
  assert.match(readme, /Compatibility, legacy, and manual-only targets/);
  assert.match(readme, /npx @9thlevelsoftware\/legion install --list-targets/);
  assert.match(readme, /npx @9thlevelsoftware\/legion install --target codex --local/);
  assert.match(readme, /docs\/site\/index\.html/);
  assert.match(readme, /Claude Code/);
  assert.match(readme, /OpenAI Codex CLI/);
  assert.match(readme, /GitHub Copilot CLI/);
  assert.match(readme, /Antigravity CLI/);
  assert.match(readme, /OpenCode/);
  assert.match(readme, /Kilo Code Plugin/);
  assert.match(readme, /Google Gemini CLI/);
  assert.match(readme, /Kiro CLI \(formerly Amazon Q Developer CLI\)/);
  assert.match(readme, new RegExp(DONATION_URL.replaceAll("/", "\\/")));
  assert.doesNotMatch(readme, /Legion Next/);
  assert.doesNotMatch(readme, /non-dry-run build\/review are not wired/i);
});

test("static site is self-contained and describes the current workflow", async () => {
  const html = await readText("docs", "site", "index.html");

  assert.match(html, /Legion Ascended/);
  assert.match(html, /A guided execution layer for AI-assisted software work/);
  assert.match(html, /legion start/);
  assert.match(html, /legion plan/);
  assert.match(html, /legion build/);
  assert.match(html, /legion review/);
  assert.match(html, /legion ship/);
  assert.match(html, /legion explore/);
  assert.match(html, /legion map/);
  assert.match(html, /legion quick/);
  assert.match(html, /legion advise/);
  assert.match(html, /legion learn/);
  assert.match(html, /legion retro/);
  assert.match(html, /legion milestone/);
  assert.match(html, /legion council/);
  assert.match(html, /Core Steps/);
  assert.match(html, /Guidance Commands/);
  assert.match(html, /Command Surface/);
  assert.doesNotMatch(html, /49<\/div><div class="label">Agents/);
  assert.doesNotMatch(html, /<div class="label">Divisions<\/div>/);
  assert.match(html, /The Tithe/);
  assert.match(html, /Make an Offering/);
  assert.match(html, new RegExp(DONATION_URL.replaceAll("/", "\\/")));
  assert.match(html, new RegExp(`${REPO_URL.replaceAll("/", "\\/")}\\/blob\\/main\\/README\\.md`));
  assert.match(html, new RegExp(`${REPO_URL.replaceAll("/", "\\/")}\\/blob\\/main\\/docs\\/cli\\/WORKFLOW-QUICKSTART\\.md`));
  assert.match(html, new RegExp(`${REPO_URL.replaceAll("/", "\\/")}\\/blob\\/main\\/docs\\/cli\\/INSTALL-MATRIX\\.md`));
  assert.doesNotMatch(html, /href="\.\.\/.*\.md"/);
  assert.doesNotMatch(html, /href="\/.*\.md"/);

  const localAssetRefs = [
    ...attributes(html, "src").filter((value) => value.endsWith(".js") || value.endsWith(".svg")),
    ...attributes(html, "href").filter((value) => value.endsWith(".css") || value.endsWith(".svg"))
  ];

  assert.ok(localAssetRefs.length >= 5, "site should reference local CSS, JS, and SVG assets");
  for (const ref of localAssetRefs) {
    assert.match(ref, /^\.\/(assets\/)?[A-Za-z0-9._/-]+$/, `asset reference must stay local: ${ref}`);
  }
});

test("Pages workflow deploys docs site and watches its own file", async () => {
  const workflow = await readText(".github", "workflows", "static.yml");

  assert.match(workflow, /path: docs\/site/);
  assert.match(workflow, /\.github\/workflows\/static\.yml/);
  assert.doesNotMatch(workflow, /\.github\/workflows\/pages\.yml/);
});

test("site CSS avoids remote dependencies and supports reduced motion", async () => {
  const css = await readText("docs", "site", "styles.css");

  assert.doesNotMatch(css, /@import/);
  assert.doesNotMatch(css, /https?:\/\//);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /\.reveal-section\s*\{\s*opacity: 0;/);
  assert.match(css, /\.reveal-section\.active\s*\{\s*opacity: 1;/);
});
