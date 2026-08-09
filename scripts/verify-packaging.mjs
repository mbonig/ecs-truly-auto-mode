#!/usr/bin/env node
/**
 * Verify the published package by installing from it.
 *
 * The property that matters is not "the file list looks right" — an ignore rule
 * and an asset declaration are two separate places to forget something, and a
 * static list only catches what someone thought to enumerate. What matters is
 * that an *installed* skill resolves every path it tells the reader to open.
 *
 * So this packs the real tarball, extracts it, runs the packed CLI out of it,
 * and then walks the installed SKILL.md and references/ resolving every relative
 * path against the installed skill directory. One check catches an ignore-rule
 * omission, a bad skill.json, and a stale path in SKILL.md.
 *
 * Usage: node scripts/verify-packaging.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

const work = mkdtempSync(join(tmpdir(), 'ecs-auto-mode-pack-'));
process.on('exit', () => rmSync(work, { recursive: true, force: true }));

//
// Pack and extract.
//
console.log('Packing:\n');

const packed = JSON.parse(
  execFileSync('npm', ['pack', '--json', '--pack-destination', work], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    // A packaging mistake makes this listing enormous — a nested node_modules is
    // tens of thousands of entries. Fail on the assertion below, not on a buffer.
    maxBuffer: 256 * 1024 * 1024,
  }),
)[0];

const shipped = new Set(packed.files.map((f) => f.path));
const tarball = join(work, packed.filename);

check('tarball produced', existsSync(tarball), tarball);

const included = (prefix) => [...shipped].some((p) => p === prefix || p.startsWith(`${prefix}/`));

for (const dir of ['lib', 'skills', 'templates', 'schemas']) {
  check(`${dir}/ ships`, included(dir));
}
for (const dir of ['src', 'test', 'examples', 'openspec', 'docs', 'scripts', '.claude']) {
  check(`${dir}/ excluded`, !included(dir));
}
check('compiled entry point ships', shipped.has('lib/cli.js'));
check('uncompiled entry point does not', !shipped.has('src/cli.ts'));

// Nested build output is the packaging mistake this repository is actually prone
// to: templates/cdk is its own npm project, and the fixture suite installs into it.
const nested = [...shipped].filter((p) => p.includes('node_modules/') || p.includes('cdk.out/'));
check('no nested node_modules or cdk.out', nested.length === 0, `${nested.length} such files, e.g. ${nested[0]}`);

const extracted = join(work, 'extracted');
execFileSync('mkdir', ['-p', extracted]);
execFileSync('tar', ['-xzf', tarball, '-C', extracted]);
const pkgRoot = join(extracted, 'package');

//
// Install from the extracted package, using the packed CLI.
//
console.log('\nInstalling from the packed artifact:\n');

const destination = join(work, 'skills-target');
const output = execFileSync(process.execPath, [join(pkgRoot, 'lib', 'cli.js'), 'install', '--dir', destination], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});

check('install reported the destination', output.includes(destination));

const installedSkills = existsSync(destination)
  ? readdirSync(destination, { withFileTypes: true }).filter((e) => e.isDirectory())
  : [];

check('at least one skill installed', installedSkills.length > 0);

//
// Resolve every relative path an installed skill points at.
//
console.log('\nResolving referenced paths in each installed skill:\n');

// Inline code spans and markdown links that look like paths. Prose such as
// `package.json` refers to the *target* repository's files, not the skill's, so
// only references that are explicitly skill-relative (./…) are resolved.
const RELATIVE_REF = /\]\((\.\/[^)\s]+)\)|`(\.\/[^`\s]+)`/g;

function markdownFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(full));
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

for (const entry of installedSkills) {
  const skillDir = join(destination, entry.name);
  const docs = [
    join(skillDir, 'SKILL.md'),
    ...(existsSync(join(skillDir, 'references')) ? markdownFiles(join(skillDir, 'references')) : []),
  ].filter(existsSync);

  let refs = 0;
  for (const doc of docs) {
    const lines = readFileSync(doc, 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const match of line.matchAll(RELATIVE_REF)) {
        const ref = (match[1] ?? match[2]).replace(/#.*$/, '');
        const target = resolve(dirname(doc), ref);
        refs++;

        const ok = existsSync(target) && (statSync(target).isFile() || statSync(target).isDirectory());
        check(
          `${entry.name}: ${relative(skillDir, doc)}:${index + 1} -> ${ref}`,
          ok,
          `does not resolve to ${target}`,
        );
      }
    });
  }

  check(`${entry.name}: install record written`, existsSync(join(skillDir, '.installed.json')));
  check(`${entry.name}: at least one path was checked`, refs > 0, `found ${refs}`);
}

console.log('');
if (failures > 0) {
  console.error(`${failures} packaging check${failures === 1 ? '' : 's'} failed.`);
  process.exit(1);
}
console.log('Packaged skills install and resolve everything they reference.');
