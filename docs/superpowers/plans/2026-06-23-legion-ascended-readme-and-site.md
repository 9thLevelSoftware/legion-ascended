# Legion Ascended README And Static Website Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the README and add a self-contained Legion Ascended static marketing site that reflects the current guided workflow CLI.

**Architecture:** Use static HTML, CSS, JS, and local SVG assets under `docs/site/`. Avoid adding a framework or runtime dependency.

**Tech Stack:** HTML, CSS, vanilla JavaScript, Node test runner, existing pnpm validation.

---

## Tasks

- [ ] Preserve the original tithe URL by searching current and historical source. Use `https://ko-fi.com/vitruvianredux`, discovered from `9thLevelSoftware/legion` `docs/index.html`.
- [ ] Create `docs/site/index.html`, `docs/site/styles.css`, `docs/site/main.js`, and local SVG assets for the Ascended mark, console, and tithe sigil.
- [ ] Rewrite `README.md` as the current Legion Ascended product front door.
- [ ] Add `docs/site/` to packaged docs and package-content approval.
- [ ] Add `tests/readme-site-content.test.mjs` covering README/site copy, local assets, canonical workflow commands, first-class target wording, and the preserved donation URL.
- [ ] Run focused docs/package tests, full build, `validate:next`, and package dry-runs.
