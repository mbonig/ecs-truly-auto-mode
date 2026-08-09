#!/usr/bin/env node
/**
 * Verify the two infrastructure project styles stay equivalent.
 *
 * `plain` and `projen` are supposed to differ only in scaffolding: same stacks, same
 * CDK version, same synthesized template. The one source that is duplicated is the
 * entry point — templates/cdk/bin/app.ts and templates/cdk-projen/src/main.ts —
 * because projen keeps its sources under a single directory, so the imports differ.
 *
 * Duplicated files drift. This checks the two properties that would make the styles
 * stop being equivalent without anyone noticing:
 *
 *   1. the entry points are identical once import paths and headers are normalized
 *   2. both styles pin the same aws-cdk-lib floor
 *
 * Usage: node scripts/verify-styles.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');

const PLAIN_ENTRY = 'templates/cdk/bin/app.ts';
const PROJEN_ENTRY = 'templates/cdk-projen/src/main.ts';
const PLAIN_PACKAGE = 'templates/cdk/package.json';
const PROJEN_PROJECT = 'templates/cdk-projen/.projenrc.ts';

const read = (rel) => readFileSync(join(repo, rel), 'utf8');

/**
 * Strip what the two files are *allowed* to differ in: the leading comment block,
 * which explains each file's place in its own layout, and the import paths, which are
 * `../lib/x` under plain and `./x` under projen. What survives is the code that
 * actually instantiates the stacks, and that must match exactly.
 */
function normalizeEntry(source) {
  return source
    .split('\n')
    .map((line) => line.trimEnd())
    // Blank lines and comments carry no behavior, and each file's header describes
    // its own layout. Dropping them keeps the reported difference on real code.
    .filter((line) => line !== '' && !line.trimStart().startsWith('//'))
    .join('\n')
    .replace(/from '(?:\.\.\/lib|\.)\/([a-z-]+)'/g, "from './$1'")
    .trim();
}

/** First diverging line of two normalized sources, for a message worth reading. */
function firstDifference(a, b) {
  const left = a.split('\n');
  const right = b.split('\n');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] !== right[i]) {
      return `line ${i + 1}: ${JSON.stringify(left[i] ?? '(end of file)')} vs ${JSON.stringify(right[i] ?? '(end of file)')}`;
    }
  }
  return null;
}

const checks = [
  {
    name: 'the two entry points differ only in import paths',
    run() {
      const difference = firstDifference(
        normalizeEntry(read(PLAIN_ENTRY)),
        normalizeEntry(read(PROJEN_ENTRY)),
      );
      if (!difference) return null;
      return `${PLAIN_ENTRY} and ${PROJEN_ENTRY} have diverged — ${difference}`;
    },
  },
  {
    name: 'both entry points instantiate both stacks',
    run() {
      const problems = [];
      for (const rel of [PLAIN_ENTRY, PROJEN_ENTRY]) {
        const source = read(rel);
        for (const stack of ['PlatformStack', 'ServiceStack']) {
          if (!source.includes(`new ${stack}(`)) {
            problems.push(`${rel} does not instantiate ${stack}`);
          }
        }
      }
      return problems.length ? problems.join('; ') : null;
    },
  },
  {
    name: 'both styles pin the same aws-cdk-lib floor',
    run() {
      const pkg = JSON.parse(read(PLAIN_PACKAGE));
      const range = pkg.dependencies?.['aws-cdk-lib'];
      if (!range) return `${PLAIN_PACKAGE} does not depend on aws-cdk-lib`;

      // AwsCdkTypeScriptApp takes a version, not a range, so the projen style pins
      // the floor of the plain style's range: ^2.263.0 -> 2.263.0.
      const floor = range.replace(/^[\^~>=\s]*/, '');
      if (!/^\d+\.\d+\.\d+$/.test(floor)) {
        return `could not read a version floor out of "${range}" in ${PLAIN_PACKAGE}`;
      }

      const projenrc = read(PROJEN_PROJECT);
      // The template carries a CDK_VERSION placeholder; the documented substitution
      // is the floor above, so the floor has to appear in the file's own comments.
      if (!projenrc.includes("cdkVersion: 'CDK_VERSION'")) {
        return `${PROJEN_PROJECT} no longer takes cdkVersion from the CDK_VERSION placeholder`;
      }

      const styleDoc = read('skills/ecs-truly-auto-mode/references/generation/iac-style.md');
      if (!styleDoc.includes(floor)) {
        return `iac-style.md documents a CDK_VERSION substitution that no longer matches the ${floor} floor in ${PLAIN_PACKAGE}`;
      }
      return null;
    },
  },
  {
    name: 'the projen template keeps projen out of the deploy path',
    run() {
      const projenrc = read(PROJEN_PROJECT);
      const problems = [];
      // The pipeline runs `npm ci` against a committed lockfile; projen's yarn
      // default would leave nothing for that step to install from.
      if (!/NodePackageManager\.NPM/.test(projenrc)) {
        problems.push(`${PROJEN_PROJECT} does not select npm, so no package-lock.json is committed`);
      }
      // A deploy:platform task, because projen's own `deploy` would also deploy the
      // service stack the pipeline owns.
      if (!/deploy:platform/.test(projenrc)) {
        problems.push(`${PROJEN_PROJECT} defines no deploy:platform task`);
      }
      // Projen would write workflows under infra/.github, which GitHub never reads.
      if (!/github:\s*false/.test(projenrc)) {
        problems.push(`${PROJEN_PROJECT} lets projen write workflows under infra/.github, where they never run`);
      }
      return problems.length ? problems.join('; ') : null;
    },
  },
  {
    name: 'both styles set the same CDK context flags',
    run() {
      const cdkJson = JSON.parse(read('templates/cdk/cdk.json'));
      const projenrc = read(PROJEN_PROJECT);
      const missing = Object.keys(cdkJson.context ?? {})
        .filter((flag) => !projenrc.includes(flag));
      if (missing.length) {
        return `${PROJEN_PROJECT} omits context flags set by templates/cdk/cdk.json: ${missing.join(', ')}`;
      }
      return null;
    },
  },
];

function main() {
  let failures = 0;

  console.log('Infrastructure style equivalence:\n');
  for (const check of checks) {
    const problem = check.run();
    if (problem === null) {
      console.log(`  ok    ${check.name}`);
    } else {
      failures++;
      console.log(`  FAIL  ${check.name}`);
      console.log(`        - ${problem}`);
    }
  }

  if (failures > 0) {
    console.log(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nBoth styles stay equivalent (${checks.length} properties).`);
}

main();
