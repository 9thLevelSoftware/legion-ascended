#!/usr/bin/env node

const { appendFileSync, readFileSync } = require("node:fs");

const args = process.argv.slice(2);
const recordPath = process.env.FAKE_GROK_RECORD_FILE;
const mode = process.env.FAKE_GROK_MODE || "success";
const responseFile = process.env.FAKE_GROK_RESPONSE_FILE;
const sleepMs = Number.parseInt(process.env.FAKE_GROK_SLEEP_MS || "0", 10);

if (recordPath) {
  appendFileSync(recordPath, `${JSON.stringify({
    args,
    cwd: process.cwd(),
    stdinLength: process.stdin.readableLength,
    xaiApiKeyPresent: Object.hasOwn(process.env, "XAI_API_KEY")
  })}\n`);
}

if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("grok 1.0.10\n");
  process.exit(0);
}

(async () => {
  if (Number.isFinite(sleepMs) && sleepMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }
  if (mode === "timeout") return;
  if (mode === "nonzero") {
    process.stderr.write("fake Grok failure\n");
    process.exitCode = 7;
    return;
  }
  if (mode === "malformed") {
    process.stdout.write("{\\\"text\\\":\\\"unterminated");
    return;
  }
  if (mode === "empty") return;
  if (!responseFile) {
    process.stderr.write("FAKE_GROK_RESPONSE_FILE is required\n");
    process.exitCode = 2;
    return;
  }
  process.stdout.write(readFileSync(responseFile, "utf8"));
})().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
