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
  '--dry-run',
  '--target',
  '--runtime',
  '--list-targets',
  '--detect',
  '--explain',
  '--all-targets',
  '--uninstall',
  '--update',
  '--version',
  '-v'
]);

function shouldRouteToInstaller(args) {
  const [first] = args;
  if (first === 'install') return true;
  if (first === 'uninstall') return true;
  if (first === 'update') return true;
  return INSTALLER_FLAGS.has(first);
}

function installerArgsFor(args) {
  const [first, ...rest] = args;
  if (first === 'install') return rest;
  if (first === 'uninstall') return ['--uninstall', ...rest];
  if (first === 'update') return ['--update', ...rest];
  return args;
}

function normalizeWorkflowArgs(args) {
  return args.map((arg) => arg === '-h' ? '--help' : arg);
}

async function main(args = process.argv.slice(2)) {
  if (shouldRouteToInstaller(args)) {
    const installer = require('./install.js');
    return installer.main(installerArgsFor(args));
  }

  const bundledCli = path.resolve(__dirname, '..', 'dist', 'legion-cli.mjs');
  const sourceCli = path.resolve(__dirname, '..', 'packages', 'cli', 'dist', 'index.js');
  const cliUrl = pathToFileURL(require('node:fs').existsSync(bundledCli) ? bundledCli : sourceCli).href;
  const { runCli } = await import(cliUrl);
  return runCli(normalizeWorkflowArgs(args));
}

main().then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
