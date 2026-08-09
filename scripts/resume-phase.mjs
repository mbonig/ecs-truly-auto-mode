#!/usr/bin/env node
/**
 * Determine which phase a run resumes at, from manifest state alone.
 *
 * The skill must not restart from scratch on a repository it has already processed —
 * re-asking settled questions is the fastest way to make someone stop reading the
 * answers. This encodes the state machine so the decision is mechanical rather than
 * a judgement call made differently each run.
 *
 * Usage: node scripts/resume-phase.mjs <manifest.yaml> [--root <dir>] [--json]
 */

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export const SUPPORTED_SCHEMA_VERSIONS = [1];

/**
 * The generated project's shape, read from the manifest and never re-asked.
 *
 * An absent `infra` section means `plain`: every manifest written before the field
 * existed describes a plain app, and a resume must not convert a repository to
 * projen on the strength of a missing field.
 */
export function infraStyle(manifest) {
  return manifest?.infra?.style ?? 'plain';
}

/**
 * @returns {{phase: string, reason: string, style: string, blocked?: boolean}}
 */
export function resumePhase(manifest, options = {}) {
  // The style rides along with every answer: whichever phase the run resumes at
  // works in the layout the manifest already committed to.
  return { ...decidePhase(manifest, options), style: infraStyle(manifest) };
}

function decidePhase(manifest, { root = '.', filesExist = defaultFilesExist } = {}) {
  // Never reinterpret a manifest whose meaning may have changed. Stopping is the
  // only safe response to a version this build does not know.
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(manifest?.schemaVersion)) {
    return {
      phase: 'stop',
      blocked: true,
      reason: `manifest schemaVersion ${manifest?.schemaVersion} is not one of ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}`,
    };
  }

  if (manifest.analysis?.buildValidated !== true) {
    return { phase: 'analyze', reason: 'the image build has not been validated' };
  }

  // Anything below high confidence and unconfirmed is an unanswered question.
  const unresolved = [...walkFindings(manifest.analysis)].filter(
    ({ finding }) => finding.confidence !== 'high' && !finding.confirmedByUser,
  );
  if (unresolved.length > 0) {
    return {
      phase: 'plan',
      reason: `${unresolved.length} finding(s) still need an answer: ${unresolved.map((u) => u.path).join(', ')}`,
    };
  }

  const incompleteAdoptions = (manifest.plan?.resources ?? []).filter(
    (r) => r.action === 'adopt' && !hasIdentifiers(r),
  );
  if (incompleteAdoptions.length > 0) {
    return {
      phase: 'plan',
      reason: `${incompleteAdoptions.length} adopted resource(s) still need identifiers: ${incompleteAdoptions.map((r) => r.id).join(', ')}`,
    };
  }

  if (manifest.plan?.approved !== true) {
    return { phase: 'plan', reason: 'the plan has not been approved' };
  }

  const generated = manifest.generated ?? [];
  if (generated.length === 0) {
    return { phase: 'generate', reason: 'the plan is approved but nothing has been generated' };
  }

  const { missing, edited } = filesExist(generated, root);
  if (missing.length > 0) {
    return {
      phase: 'generate',
      reason: `${missing.length} generated file(s) are missing: ${missing.join(', ')}`,
    };
  }
  if (edited.length > 0) {
    return {
      phase: 'generate',
      blocked: true,
      reason: `${edited.length} generated file(s) were edited since generation: ${edited.join(', ')} — ask before overwriting`,
    };
  }

  return { phase: 'reanalyze', reason: 'everything is current; re-analyze and report the diff' };
}

function hasIdentifiers(resource) {
  const ids = resource.identifiers;
  if (!ids || Object.keys(ids).length === 0) return false;
  return Object.values(ids).every((v) => {
    if (Array.isArray(v)) return v.length > 0 && v.every(Boolean);
    return v !== '' && v !== null && v !== undefined;
  });
}

function defaultFilesExist(generated, root) {
  const missing = [];
  const edited = [];
  for (const entry of generated) {
    const path = join(root, entry.path);
    if (!existsSync(path)) {
      missing.push(entry.path);
      continue;
    }
    const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (actual !== entry.sha256) edited.push(entry.path);
  }
  return { missing, edited };
}

function* walkFindings(node, path = 'analysis') {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* walkFindings(item, `${path}[${i}]`);
    return;
  }
  if ('confidence' in node && 'evidence' in node) {
    yield { path, finding: node };
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    yield* walkFindings(value, `${path}.${key}`);
  }
}

function main() {
  const [manifestPath, ...rest] = process.argv.slice(2);
  if (!manifestPath) {
    console.error('usage: resume-phase.mjs <manifest.yaml> [--root <dir>] [--json]');
    process.exit(2);
  }
  const rootFlag = rest.indexOf('--root');
  const root = rootFlag >= 0 ? rest[rootFlag + 1] : '.';

  const manifest = parseYaml(readFileSync(manifestPath, 'utf8'));
  const result = resumePhase(manifest, { root });

  if (rest.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`phase:  ${result.phase}${result.blocked ? '  (blocked — ask the user)' : ''}`);
    console.log(`style:  ${result.style}`);
    console.log(`reason: ${result.reason}`);
  }
  process.exit(result.blocked ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
