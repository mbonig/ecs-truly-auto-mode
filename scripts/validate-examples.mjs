#!/usr/bin/env node
/**
 * Test harness for the manifest validator.
 *
 * Two halves. First, every example manifest must validate — they are the worked
 * references the skill and its docs point at, so a stale example is a real defect.
 * Second, a set of deliberate corruptions must each be *caught*. Without that half,
 * a validator whose checks silently stopped firing would still report success.
 *
 * Usage: node scripts/validate-examples.mjs
 */

import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const examplesDir = join(repo, 'examples', 'manifests');
const validator = join(here, 'validate-manifest.mjs');

/** Run the validator; return {ok, output}. */
function runValidator(path) {
  try {
    const output = execFileSync(process.execPath, [validator, path], { encoding: 'utf8' });
    return { ok: true, output };
  } catch (err) {
    return { ok: false, output: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

/**
 * Each corruption takes a valid manifest and breaks one invariant. `expect` is a
 * substring the validator's complaint must contain — matching on the substance of
 * the message, not its exact wording, so rephrasing a message doesn't fail the test.
 */
const corruptions = [
  {
    name: 'approved plan with an unvalidated build',
    base: 'created-vpc',
    break: (m) => { m.analysis.buildValidated = false; },
    expect: 'buildValidated',
  },
  {
    name: 'isolated egress but external hosts recorded',
    base: 'created-vpc',
    break: (m) => {
      m.analysis.egress.externalHosts = [
        { value: 'api.example.com', confidence: 'high', evidence: [{ file: 'src/x.ts' }] },
      ];
    },
    expect: 'forces "public"',
  },
  {
    name: 'public egress with no host naming the cause',
    base: 'adopted-vpc',
    break: (m) => { m.analysis.egress.externalHosts = []; },
    expect: 'must name the call that forced NAT',
  },
  {
    name: 'isolated egress but a NAT gateway in the plan',
    base: 'created-vpc',
    break: (m) => {
      m.plan.resources.find((r) => r.id === 'nat-gateway').action = 'create';
    },
    expect: 'should not pay for a NAT gateway',
  },
  {
    name: 'public egress but NAT skipped',
    base: 'adopted-vpc',
    break: (m) => {
      m.plan.resources.find((r) => r.id === 'nat-gateway').action = 'skip';
      delete m.plan.resources.find((r) => r.id === 'nat-gateway').identifiers;
    },
    expect: 'unable to reach its external dependencies',
  },
  {
    name: 'http health check with no path',
    base: 'created-vpc',
    break: (m) => { delete m.analysis.container.healthCheck.path; },
    expect: 'no path is recorded',
  },
  {
    name: 'tcp health check that still carries a path',
    base: 'created-vpc',
    break: (m) => { m.analysis.container.healthCheck.type.value = 'tcp'; },
    expect: 'path would be ignored',
  },
  {
    name: 'adopted resource with an empty identifier',
    base: 'adopted-vpc',
    break: (m) => {
      m.plan.resources.find((r) => r.id === 'certificate').identifiers.certificateArn = '';
    },
    expect: 'identifier "certificateArn" is empty',
  },
  {
    name: 'approved plan holding an unconfirmed low-confidence finding',
    base: 'created-vpc',
    break: (m) => { m.analysis.container.port.confidence = 'low'; },
    expect: 'must be asked about, not defaulted',
  },
  {
    name: 'conflict finding with no alternatives to choose between',
    base: 'created-vpc',
    break: (m) => {
      m.analysis.container.port.confidence = 'conflict';
      m.analysis.container.port.confirmedByUser = true;
    },
    expect: 'records no alternatives',
  },
  {
    name: 'adopted VPC missing its subnet IDs',
    base: 'adopted-vpc',
    break: (m) => {
      const vpc = m.plan.resources.find((r) => r.id === 'vpc');
      delete vpc.privateSubnetIds;
      delete vpc.identifiers.privateSubnetIds;
      delete vpc.identifiers.publicSubnetIds;
    },
    expect: 'no subnet IDs',
  },
  {
    name: 'path filter that omits a build-context path',
    base: 'created-vpc',
    break: (m) => {
      m.pipeline.pathFilter = m.pipeline.pathFilter.filter((p) => p !== 'src/**');
    },
    expect: 'silently not deploy',
  },
  {
    name: 'a secret value written into the manifest',
    base: 'adopted-vpc',
    break: (m) => { m.analysis.config.secrets[0].value = 'hunter2'; },
    expect: 'must NOT have additional properties',
  },
  {
    name: 'created resource carrying import identifiers',
    base: 'created-vpc',
    break: (m) => {
      m.plan.resources.find((r) => r.id === 'cluster').identifiers = { clusterArn: 'arn:...' };
    },
    expect: 'would be silently ignored',
  },
  {
    name: 'unrecognized schema version',
    base: 'created-vpc',
    break: (m) => { m.schemaVersion = 99; },
    expect: 'schemaVersion',
  },
];

function main() {
  let failures = 0;

  console.log('Example manifests must validate:\n');
  const examples = readdirSync(examplesDir).filter((f) => f.endsWith('.yaml'));
  if (examples.length === 0) {
    console.log('  FAIL  no example manifests found');
    failures++;
  }
  for (const file of examples) {
    const { ok, output } = runValidator(join(examplesDir, file));
    if (ok) {
      console.log(`  ok    ${file}`);
    } else {
      failures++;
      console.log(`  FAIL  ${file}`);
      console.log(output.split('\n').map((l) => `        ${l}`).join('\n'));
    }
  }

  console.log('\nCorruptions must be caught:\n');
  const scratch = mkdtempSync(join(tmpdir(), 'ecs-auto-mode-'));
  try {
    for (const c of corruptions) {
      const manifest = parseYaml(
        readFileSync(join(examplesDir, `${c.base}.manifest.yaml`), 'utf8'),
      );
      c.break(manifest);
      const path = join(scratch, 'corrupt.yaml');
      writeFileSync(path, stringifyYaml(manifest));

      const { ok, output } = runValidator(path);
      if (ok) {
        failures++;
        console.log(`  FAIL  ${c.name}`);
        console.log('        - validator accepted a manifest it should have rejected');
      } else if (!output.includes(c.expect)) {
        failures++;
        console.log(`  FAIL  ${c.name}`);
        console.log(`        - rejected, but not for the expected reason (wanted "${c.expect}")`);
        console.log(output.split('\n').map((l) => `        ${l}`).join('\n'));
      } else {
        console.log(`  ok    ${c.name}`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.log(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nAll checks passed (${examples.length} examples, ${corruptions.length} corruptions).`);
}

main();
