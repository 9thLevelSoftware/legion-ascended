# Installer Integrity and Provenance

Legion is distributed through npm and can also be installed from a local source tree.

## Threat Model

The installer copies command, skill, adapter, and agent markdown files into user home directories.
The primary risk is installing modified/untrusted content from an unverified local source.

## Security Layers

1. **npm transport integrity**
   npm verifies package tarball integrity when fetching from the registry.

2. **Local source warning**
   If install source appears to be a local git checkout, the installer warns that provenance is not npm-verified.

3. **Optional content verification (`--verify`)**
   The installer can verify local file hashes against `checksums.sha256` before copying any files.

## Recommended Usage

- Registry install (default):
  `npx @9thlevelsoftware/legion --claude`

- Local install with verification:
  `node bin/install.js --claude --verify`

## Limits

- `--verify` validates file integrity against the shipped checksum manifest.
- It does not provide cryptographic publisher identity by itself.
- For stronger guarantees, use npm provenance/signing in release workflow.
