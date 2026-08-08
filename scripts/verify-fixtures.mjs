#!/usr/bin/env node
/**
 * Assert what each fixture exists to prove.
 *
 * The fixtures are not just sample apps — each one pins down a specific behavior
 * that is easy to regress: the NAT decision in both directions, escalation instead
 * of guessing, and the build gate. This checks those claims against the recorded
 * expected manifests, and synthesizes the stacks to confirm the plan actually
 * produces the infrastructure it promises.
 *
 * Usage: node scripts/verify-fixtures.mjs
 */

import { readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const cdkDir = join(repo, 'templates', 'cdk');

let failures = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? `\n        - ${detail}` : ''}`);
  }
}

function load(fixture) {
  return parseYaml(readFileSync(join(repo, 'examples', fixture, 'expected-manifest.yaml'), 'utf8'));
}

function planEntry(manifest, id) {
  return manifest.plan.resources.find((r) => r.id === id);
}

/** Synthesize a fixture's manifest and return both templates. */
function synth(fixture) {
  const manifestPath = join(repo, 'examples', fixture, 'expected-manifest.yaml');
  const configPath = join(cdkDir, 'lib', 'app-config.ts');

  execFileSync(process.execPath, [join(here, 'generate-config.mjs'), manifestPath, configPath], {
    stdio: 'pipe',
  });

  execFileSync('npx', ['cdk', 'synth', '**', '-q', '--no-notices'], {
    cwd: cdkDir,
    stdio: 'pipe',
    env: {
      ...process.env,
      JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION: '1',
      AWS_CONFIG_FILE: '/dev/null',
      AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
      AWS_PROFILE: '',
      AWS_ACCESS_KEY_ID: '',
      AWS_SECRET_ACCESS_KEY: '',
    },
  });

  const name = load(fixture).app.name;
  const read = (stack) =>
    JSON.parse(readFileSync(join(cdkDir, 'cdk.out', `${name}-${stack}.template.json`), 'utf8'));
  return { platform: read('platform'), service: read('service') };
}

function typesOf(template) {
  const counts = {};
  for (const r of Object.values(template.Resources)) counts[r.Type] = (counts[r.Type] ?? 0) + 1;
  return counts;
}

// ---------------------------------------------------------------------------

console.log('node-express — the isolated case:\n');
{
  const m = load('node-express');
  check('egress classified none', m.analysis.egress.classification.value === 'none');
  check('nat-gateway skipped', planEntry(m, 'nat-gateway').action === 'skip');
  check(
    'skip reason cites the classification',
    /egress\.classification is none/.test(planEntry(m, 'nat-gateway').reason),
  );

  const { platform, service } = synth('node-express');
  const p = typesOf(platform);
  check('no NAT gateway synthesized', !p['AWS::EC2::NatGateway'], `found ${p['AWS::EC2::NatGateway']}`);
  check('VPC endpoints synthesized', p['AWS::EC2::VPCEndpoint'] === 4, `expected 4, got ${p['AWS::EC2::VPCEndpoint']}`);

  const s = typesOf(service);
  const forbidden = [
    'AWS::EC2::VPC', 'AWS::ECS::Cluster', 'AWS::ECR::Repository',
    'AWS::ElasticLoadBalancingV2::LoadBalancer', 'AWS::IAM::Role',
  ];
  check(
    'service stack holds only the task definition and service',
    forbidden.every((t) => !s[t]) && s['AWS::ECS::Service'] === 1 && s['AWS::ECS::TaskDefinition'] === 1,
    `got ${JSON.stringify(s)}`,
  );
  check(
    'service stack declares no Fn::ImportValue',
    !JSON.stringify(service).includes('Fn::ImportValue'),
  );
}

console.log('\ngo-external — the NAT-required case:\n');
{
  const m = load('go-external');
  check('egress classified public', m.analysis.egress.classification.value === 'public');
  check('an external host is named', m.analysis.egress.externalHosts.length > 0);
  check(
    'the forcing call is cited with a file and line',
    m.analysis.egress.externalHosts[0].evidence.some((e) => e.file && e.line),
  );
  check('nat-gateway created', planEntry(m, 'nat-gateway').action === 'create');
  check(
    'the plan reason names the specific call',
    /main\.go|exchangerate/.test(planEntry(m, 'nat-gateway').reason),
    planEntry(m, 'nat-gateway').reason,
  );

  const { platform } = synth('go-external');
  const p = typesOf(platform);
  check('NAT gateway synthesized', p['AWS::EC2::NatGateway'] > 0, 'none found');
  check('no isolated-mode endpoints', !p['AWS::EC2::VPCEndpoint']);
}

console.log('\npython-fastapi — AWS calls stay isolated:\n');
{
  const m = load('python-fastapi');
  check('boto3 usage does not force NAT', m.analysis.egress.classification.value === 'none');
  check('s3 endpoint required', m.analysis.egress.awsServices.includes('s3'));
  check('secretsmanager endpoint required', m.analysis.egress.awsServices.includes('secretsmanager'));
  check('database is adopt-only', planEntry(m, 'database').action === 'adopt');
  check(
    'no secret value is recorded',
    m.analysis.config.secrets.every((s) => !('value' in s)),
  );

  const { platform, service } = synth('python-fastapi');
  const p = typesOf(platform);
  check('no NAT gateway synthesized', !p['AWS::EC2::NatGateway']);
  check(
    'two ingress rules: ALB to task, and task to RDS',
    p['AWS::EC2::SecurityGroupIngress'] === 2,
    `got ${p['AWS::EC2::SecurityGroupIngress']}`,
  );
  check(
    'no secret value appears in the service template',
    !/hunter2|BEGIN (RSA )?PRIVATE KEY/.test(JSON.stringify(service)),
  );
}

console.log('\nambiguous — escalation instead of guessing:\n');
{
  const m = load('ambiguous');
  const port = m.analysis.container.port;

  check('port recorded as a conflict', port.confidence === 'conflict');
  check('every competing port is shown', (port.alternatives ?? []).length >= 2);
  check(
    'the Dockerfile is not preferred as a rule',
    port.value === 4000,
    'resolved to the EXPOSE value, discarding the live listen()',
  );
  check('missing health route is not invented', m.analysis.container.healthCheck.type.confidence !== 'high');
  check('no health path was fabricated', !m.analysis.container.healthCheck.path);
  check('architecture asked, not assumed', m.analysis.architecture.confidence !== 'high');
  check('plan is blocked', m.plan.approved === false);

  // The mechanism, not just the data: approving this plan must be rejected.
  const approved = structuredClone(m);
  approved.plan.approved = true;
  const scratch = join(repo, '.verify-fixtures-tmp.yaml');
  writeFileSync(scratch, stringifyYaml(approved));
  let rejected = false;
  let message = '';
  try {
    execFileSync(process.execPath, [join(here, 'validate-manifest.mjs'), scratch], { stdio: 'pipe' });
  } catch (err) {
    rejected = true;
    message = err.stdout?.toString() ?? '';
  } finally {
    rmSync(scratch, { force: true });
  }
  check('approving an unresolved plan is rejected', rejected);
  check(
    'the rejection explains that questions were skipped',
    /must be asked about, not defaulted/.test(message),
  );
}

console.log('\nfailing-build — the build gate:\n');
{
  const dir = join(repo, 'examples', 'failing-build');
  check('no expected manifest exists', !existsSync(join(dir, 'expected-manifest.yaml')),
    'a manifest here would mean the run continued past a failed build');
  check('Dockerfile runs npm ci', /npm ci/.test(readFileSync(join(dir, 'Dockerfile'), 'utf8')));
  check('no lockfile is present, so npm ci must fail', !existsSync(join(dir, 'package-lock.json')));
}

rmSync(join(cdkDir, 'lib', 'app-config.ts'), { force: true });
rmSync(join(cdkDir, 'cdk.out'), { recursive: true, force: true });

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll fixture expectations hold.');
