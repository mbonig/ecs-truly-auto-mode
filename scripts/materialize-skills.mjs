#!/usr/bin/env node
/**
 * Copy each skill's declared assets into skills/<name>/assets/ for local use.
 *
 * Installed skills are self-contained: templates/ and schemas/ are copied inside
 * the skill directory at install time. In this repository they are not, because
 * templates/ is live source that the fixture suite synthesizes from — a second
 * committed copy would drift from it.
 *
 * The consequence is that a skill's own `./assets/...` paths do not resolve
 * while you are working on it here. This script fixes that locally. What it
 * writes is gitignored, and it is not what verifies the install: the packaging
 * check installs from a real tarball and resolves the paths there.
 *
 * Usage: node scripts/materialize-skills.mjs
 */

import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const skillsDir = join(root, 'skills');

let materialized = 0;

for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;

  const skillDir = join(skillsDir, entry.name);
  if (!existsSync(join(skillDir, 'SKILL.md'))) continue;

  const declarationPath = join(skillDir, 'skill.json');
  if (!existsSync(declarationPath)) continue;

  const { assets = [] } = JSON.parse(readFileSync(declarationPath, 'utf8'));

  for (const asset of assets) {
    const from = join(root, asset.from);
    const to = join(skillDir, asset.to);

    if (!existsSync(from)) {
      console.error(`${entry.name}: declared asset "${asset.from}" does not exist`);
      process.exit(1);
    }

    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true });
    console.log(`${entry.name}: ${asset.from} -> ${asset.to}`);
    materialized++;
  }
}

console.log(
  materialized === 0
    ? 'No assets declared.'
    : `Materialized ${materialized} asset ${materialized === 1 ? 'directory' : 'directories'}.`,
);
