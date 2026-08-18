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
  {
    name: 'projen style hash-tracking a file projen derives',
    base: 'projen-style',
    break: (m) => {
      m.generated.push({
        path: 'infra/package.json',
        sha256: '0'.repeat(64),
        section: 'infra',
      });
    },
    expect: 'look like a user edit',
  },
  {
    name: 'projen style recording sources in the plain layout',
    base: 'projen-style',
    break: (m) => {
      m.generated.find((g) => g.path === 'infra/src/service-stack.ts').path =
        'infra/lib/service-stack.ts';
    },
    expect: 'keeps its sources under src/',
  },
  {
    name: 'projen style whose path filter omits the project definition',
    base: 'projen-style',
    break: (m) => {
      m.pipeline.pathFilter = m.pipeline.pathFilter.filter((p) => p !== 'infra/.projenrc.ts');
    },
    expect: 'pins the CDK version',
  },
  {
    name: 'projen style whose path filter still names the plain service stack',
    base: 'projen-style',
    break: (m) => {
      m.pipeline.pathFilter = m.pipeline.pathFilter
        .filter((p) => p !== 'infra/src/service-stack.ts')
        .concat('infra/lib/service-stack.ts');
    },
    expect: 'omits "infra/src/service-stack.ts"',
  },
  {
    name: 'projen sources recorded against a manifest with no infra section',
    base: 'projen-style',
    break: (m) => { delete m.infra; },
    expect: 'keeps its sources under bin/ and lib/',
  },
  {
    name: 'path filter that would trigger a deploy on the platform stack',
    base: 'created-vpc',
    break: (m) => { m.pipeline.pathFilter.push('infra/lib/platform-stack.ts'); },
    expect: 'does not deploy the platform stack',
  },
  {
    name: 'projen style recorded without a pinned CDK version',
    base: 'projen-style',
    break: (m) => { delete m.infra.cdkVersion; },
    expect: 'cdkVersion',
  },
  {
    name: 'github-actions target with no OIDC provider decision',
    base: 'created-vpc',
    break: (m) => {
      m.plan.resources = m.plan.resources.filter((r) => r.id !== 'github-oidc-provider');
    },
    expect: 'EntityAlreadyExists',
  },
  {
    name: 'adopted OIDC provider with no ARN to trust',
    base: 'created-vpc',
    break: (m) => {
      // Not a missing `identifiers` — the schema already catches that. This is the
      // shape a half-finished session leaves: an identifier, just not the one needed.
      m.plan.resources.find((r) => r.id === 'github-oidc-provider').identifiers = {
        providerUrl: 'token.actions.githubusercontent.com',
      };
    },
    expect: 'records no providerArn',
  },
  {
    name: 'public hostname with no hosted zone to hold the record',
    base: 'created-certificate',
    break: (m) => {
      m.plan.resources = m.plan.resources.filter((r) => r.id !== 'hosted-zone');
    },
    expect: 'does not create hosted zones',
  },
  {
    name: 'public hostname whose certificate was skipped',
    base: 'created-certificate',
    break: (m) => {
      m.plan.resources.find((r) => r.id === 'certificate').action = 'skip';
    },
    expect: 'needs a certificate created or adopted',
  },
  {
    name: 'certificate created against a zone that does not cover it',
    base: 'created-certificate',
    break: (m) => {
      m.plan.resources.find((r) => r.id === 'hosted-zone').identifiers.zoneName = 'elsewhere.com';
    },
    expect: 'would never issue',
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
