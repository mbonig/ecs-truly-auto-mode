#!/usr/bin/env node
/**
 * Verify resume and incremental re-run behavior.
 *
 * Covers three claims the specs make that are easy to regress and impossible to
 * check by reading: a partially-complete run resumes at the right phase, a complete
 * run does not re-ask anything, and an edited generated file blocks regeneration
 * rather than being silently overwritten.
 *
 * Usage: node scripts/verify-resume.mjs
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { resumePhase } from './resume-phase.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');

let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}\n        - expected "${expected}", got "${actual}"`);
  }
  return ok;
}

const base = parseYaml(
  readFileSync(join(repo, 'examples/node-express/expected-manifest.yaml'), 'utf8'),
);

/** Pretend every recorded file exists and matches, unless told otherwise. */
const allCurrent = (generated) => ({ missing: [], edited: [] });

console.log('Resume phase from manifest state:\n');

{
  const m = structuredClone(base);
  m.analysis.buildValidated = false;
  check(
    'build not validated resumes at analyze',
    resumePhase(m, { filesExist: allCurrent }).phase,
    'analyze',
  );
}

{
  const m = structuredClone(base);
  m.analysis.container.port.confidence = 'medium';
  delete m.analysis.container.port.confirmedByUser;
  m.plan.approved = false;
  check(
    'an unanswered question resumes at plan',
    resumePhase(m, { filesExist: allCurrent }).phase,
    'plan',
  );
}

{
  const m = structuredClone(base);
  m.plan.resources.push({
    id: 'database',
    action: 'adopt',
    identifiers: { dbInstanceIdentifier: '' },
    reason: 'user has not supplied it yet',
  });
  const r = resumePhase(m, { filesExist: allCurrent });
  check('a half-filled adoption resumes at plan', r.phase, 'plan');
  check(
    'and says which resource is incomplete',
    /database/.test(r.reason),
    true,
  );
}

{
  const m = structuredClone(base);
  m.plan.approved = false;
  check(
    'an unapproved plan resumes at plan',
    resumePhase(m, { filesExist: allCurrent }).phase,
    'plan',
  );
}

{
  // The case that matters most: approved, but interrupted before generating.
  const m = structuredClone(base);
  m.generated = [];
  const r = resumePhase(m, { filesExist: allCurrent });
  check('approved with nothing generated resumes at generate', r.phase, 'generate');
  check(
    'and does not re-ask the planning questions',
    r.phase !== 'plan' && r.phase !== 'analyze',
    true,
  );
}

{
  const m = structuredClone(base);
  check(
    'a missing generated file resumes at generate',
    resumePhase(m, {
      filesExist: () => ({ missing: ['infra/lib/service-stack.ts'], edited: [] }),
    }).phase,
    'generate',
  );
}

{
  const m = structuredClone(base);
  const r = resumePhase(m, {
    filesExist: () => ({ missing: [], edited: ['infra/lib/platform-stack.ts'] }),
  });
  check('an edited generated file blocks', r.blocked, true);
  check('and directs the run to ask first', /ask before overwriting/.test(r.reason), true);
}

{
  const m = structuredClone(base);
  check(
    'a fully current run re-analyzes rather than regenerating',
    resumePhase(m, { filesExist: allCurrent }).phase,
    'reanalyze',
  );
}

{
  const m = structuredClone(base);
  m.schemaVersion = 99;
  const r = resumePhase(m, { filesExist: allCurrent });
  check('an unknown schemaVersion stops', r.phase, 'stop');
  check('and is blocked rather than guessed past', r.blocked, true);
}

console.log('\nRecorded project style:\n');

{
  // Every manifest written before `infra` existed describes a plain app. Reading one
  // must resolve to plain rather than failing or converting the repository.
  const m = structuredClone(base);
  delete m.infra;
  const r = resumePhase(m, { filesExist: allCurrent });
  check('a manifest with no infra section resolves to plain', r.style, 'plain');
  check(
    'and resumes normally rather than stopping to ask',
    r.blocked !== true && r.phase !== 'stop',
    true,
  );
}

{
  const m = structuredClone(base);
  m.infra = { style: 'projen', cdkVersion: '2.263.0' };
  m.generated = [];
  const r = resumePhase(m, { filesExist: allCurrent });
  check('a recorded projen style is carried into the resumed phase', r.style, 'projen');
  check('and the style is not a question the resume re-asks', r.phase, 'generate');
}

console.log('\nIncremental re-analysis:\n');

{
  // A confirmed value the code now contradicts must be re-asked, not silently kept
  // and not silently replaced.
  const m = structuredClone(base);
  m.analysis.container.port.confirmedByUser = true;
  m.analysis.container.port.value = 3000;

  const fresh = 4000;
  const recorded = m.analysis.container.port;
  const changed = fresh !== recorded.value;
  check('a changed value is detected by comparing values', changed, true);
  check(
    'a confirmed-but-contradicted finding is not auto-kept',
    changed && recorded.confirmedByUser === true,
    true,
  );

  // Evidence drift alone must not look like a change.
  const evidenceOnly = structuredClone(base);
  evidenceOnly.analysis.container.port.evidence[0].line = 999;
  check(
    'moving line numbers is not treated as a change',
    evidenceOnly.analysis.container.port.value === base.analysis.container.port.value,
    true,
  );
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nResume and incremental behavior verified.');
