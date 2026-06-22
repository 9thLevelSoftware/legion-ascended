#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const INSTALLER_FLAGS = new Set([
  '--claude',
  '--codex',
  '--cursor',
  '--copilot',
  '--gemini',
  '--antigravity',
  '--agy',
  '--kiro',
  '--amazon-q',
  '--windsurf',
  '--opencode',
  '--kilo',
  '--kilo-code',
  '--kilocode',
  '--aider',
  '--global',
  '--local',
  '--verify',
  '--uninstall',
  '--update'
]);

function shouldRouteToInstaller(args) {
  const [first] = args;
  if (first === 'install') return true;
  if (first === 'uninstall') return true;
  if (first === 'update' && args.some((arg) => INSTALLER_FLAGS.has(arg))) return true;
  return args.some((arg) => INSTALLER_FLAGS.has(arg));
}

async function main(args = process.argv.slice(2)) {
  if (shouldRouteToInstaller(args)) {
    const installerArgs = args[0] === 'install' ? args.slice(1) : args;
    const installer = require('./install.js');
    return installer.main(installerArgs);
  }

  const bundledCli = path.resolve(__dirname, '..', 'dist', 'legion-cli.mjs');
  const sourceCli = path.resolve(__dirname, '..', 'packages', 'cli', 'dist', 'index.js');
  const cliUrl = pathToFileURL(require('node:fs').existsSync(bundledCli) ? bundledCli : sourceCli).href;
  const { runCli } = await import(cliUrl);
  return runCli(args);
}

main().then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
