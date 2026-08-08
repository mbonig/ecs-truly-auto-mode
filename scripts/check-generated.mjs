#!/usr/bin/env node
/**
 * Overwrite protection for generated files.
 *
 * The manifest records a SHA-256 for every file the skill wrote. Before regenerating,
 * this compares what is on disk against what was last written, so a file the user has
 * since edited is never silently clobbered.
 *
 * Modes:
 *   check  <manifest> [--root <dir>]   report each file as unchanged / edited / missing
 *   record <manifest> [--root <dir>]   rewrite the manifest's `generated` hashes
 *
 * `check` exits 0 when everything is safe to overwrite, 1 when any file was edited.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parse as parseYaml, parseDocument } from 'yaml';

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function classify(manifest, root) {
  return (manifest.generated ?? []).map((entry) => {
    const path = join(root, entry.path);
    if (!existsSync(path)) return { ...entry, state: 'missing' };
    const actual = sha256(path);
    return { ...entry, actual, state: actual === entry.sha256 ? 'unchanged' : 'edited' };
  });
}

function check(manifest, root) {
  const results = classify(manifest, root);
  if (results.length === 0) {
    console.log('No generated files recorded — nothing to protect.');
    return 0;
  }

  const edited = results.filter((r) => r.state === 'edited');
  const missing = results.filter((r) => r.state === 'missing');

  for (const r of results) {
    const label = { unchanged: 'unchanged', edited: 'EDITED   ', missing: 'missing  ' }[r.state];
    console.log(`  ${label}  ${r.path}`);
  }

  if (missing.length > 0) {
    console.log(`\n${missing.length} recorded file(s) no longer exist. Regenerating will recreate them.`);
  }

  if (edited.length > 0) {
    console.log(`\n${edited.length} file(s) changed since generation:\n`);
    for (const r of edited) {
      console.log(`  ${r.path}`);
      console.log(`    controlled by: ${r.section ?? '(unrecorded)'}`);
    }
    console.log('\nRegenerating would discard those edits. Show the user the diff and ask');
    console.log('before overwriting — or move the change into the manifest so it survives.');
    return 1;
  }

  console.log('\nAll generated files match what was last written. Safe to regenerate.');
  return 0;
}

/**
 * Rewrite hashes in place. parseDocument preserves comments and key order, which
 * matters because the manifest is meant to be read and reviewed by a human.
 */
function record(manifestPath, manifest, root) {
  const doc = parseDocument(readFileSync(manifestPath, 'utf8'));
  const updated = [];

  for (const entry of manifest.generated ?? []) {
    const path = join(root, entry.path);
    if (!existsSync(path)) {
      console.log(`  skipped  ${entry.path} (does not exist)`);
      continue;
    }
    updated.push({ path: entry.path, sha256: sha256(path), ...(entry.section ? { section: entry.section } : {}) });
    console.log(`  recorded ${entry.path}`);
  }

  doc.setIn(['generated'], updated);
  writeFileSync(manifestPath, doc.toString());
  console.log(`\nUpdated ${updated.length} hash(es) in ${manifestPath}`);
  return 0;
}

function main() {
  const [mode, manifestPath, ...rest] = process.argv.slice(2);
  if (!mode || !manifestPath || !['check', 'record'].includes(mode)) {
    console.error('usage: check-generated.mjs <check|record> <manifest.yaml> [--root <dir>]');
    process.exit(2);
  }

  const rootFlag = rest.indexOf('--root');
  const root = rootFlag >= 0 ? rest[rootFlag + 1] : '.';

  const manifest = parseYaml(readFileSync(manifestPath, 'utf8'));

  process.exit(mode === 'check' ? check(manifest, root) : record(manifestPath, manifest, root));
}

main();
