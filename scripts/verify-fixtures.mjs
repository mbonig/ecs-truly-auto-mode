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

/**
 * The CDK app under templates/ is a separate npm project, and synthesizing needs
 * its dependencies. A clean checkout — which is exactly what CI is — does not have
 * them, and the resulting failure is an opaque `npx cdk` error rather than
 * anything that names the cause. Install them on demand instead.
 */
function ensureCdkDependencies() {
  if (existsSync(join(cdkDir, 'node_modules'))) return;

  console.log('Installing templates/cdk dependencies (first run in this checkout)...\n');
  execFileSync('npm', ['ci'], { cwd: cdkDir, stdio: 'inherit' });
}

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
  return synthManifest(join(repo, 'examples', fixture, 'expected-manifest.yaml'));
}

/**
 * Synthesize any manifest and return both templates.
 *
 * Split out from `synth` so the standalone manifests under examples/manifests/ can be
 * synthesized too. The fixtures are sample *applications*, and none of them serves a
 * public hostname — which is exactly why a certificate that could only ever be adopted
 * went unnoticed for as long as it did.
 */
function synthManifest(manifestPath) {
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

  const name = parseYaml(readFileSync(manifestPath, 'utf8')).app.name;
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

ensureCdkDependencies();

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

console.log('\ncreated-certificate — the create paths for the certificate and the OIDC provider:\n');
{
  const path = join(repo, 'examples', 'manifests', 'created-certificate.manifest.yaml');
  const m = parseYaml(readFileSync(path, 'utf8'));
  check('certificate is created, not adopted', planEntry(m, 'certificate').action === 'create');
  check('hosted zone is adopted', planEntry(m, 'hosted-zone').action === 'adopt');
  check('OIDC provider is created', planEntry(m, 'github-oidc-provider').action === 'create');

  const { platform } = synthManifest(path);
  const p = typesOf(platform);
  const resources = Object.values(platform.Resources);

  check(
    'one certificate is synthesized',
    p['AWS::CertificateManager::Certificate'] === 1,
    `got ${p['AWS::CertificateManager::Certificate']}`,
  );

  const cert = resources.find((r) => r.Type === 'AWS::CertificateManager::Certificate');
  check(
    'the certificate is DNS-validated against the recorded zone',
    cert?.Properties?.ValidationMethod === 'DNS' &&
      cert?.Properties?.DomainValidationOptions?.[0]?.HostedZoneId ===
        planEntry(m, 'hosted-zone').identifiers.hostedZoneId,
    JSON.stringify(cert?.Properties?.DomainValidationOptions),
  );
  check(
    'the certificate is issued for the recorded hostname',
    cert?.Properties?.DomainName === m.analysis.hostnames.public[0].value,
    cert?.Properties?.DomainName,
  );

  // The hostname is only actually served if all three exist together: without the
  // listener it is unreachable, without the record it is unresolvable.
  check(
    'an HTTPS listener and an HTTP redirect are both present',
    p['AWS::ElasticLoadBalancingV2::Listener'] === 2,
    `got ${p['AWS::ElasticLoadBalancingV2::Listener']}`,
  );
  check('exactly one alias record', p['AWS::Route53::RecordSet'] === 1, `got ${p['AWS::Route53::RecordSet']}`);
  check(
    'the load balancer is internet-facing',
    resources.find((r) => r.Type === 'AWS::ElasticLoadBalancingV2::LoadBalancer')
      ?.Properties?.Scheme === 'internet-facing',
  );

  const provider = resources.find((r) => r.Type === 'Custom::AWSCDKOpenIdConnectProvider');
  check('an OIDC provider is synthesized', provider !== undefined);
  check(
    'the provider is GitHub\'s, with the STS client ID',
    provider?.Properties?.Url === 'https://token.actions.githubusercontent.com' &&
      provider?.Properties?.ClientIDList?.includes('sts.amazonaws.com'),
    JSON.stringify(provider?.Properties?.ClientIDList),
  );
  // The provider's custom resource handler carries no VpcConfig, so it runs in the
  // Lambda service rather than the workload's VPC. That is what lets an egress:none
  // application — no NAT, isolated subnets — create a provider at all.
  check(
    'the provider handler is not placed in the VPC',
    resources.filter((r) => r.Type === 'AWS::Lambda::Function').every((r) => !r.Properties?.VpcConfig),
  );
}

console.log('\nadopted-vpc — the adopt paths for the certificate and the OIDC provider:\n');
{
  const path = join(repo, 'examples', 'manifests', 'adopted-vpc.manifest.yaml');
  const m = parseYaml(readFileSync(path, 'utf8'));
  check('certificate is adopted', planEntry(m, 'certificate').action === 'adopt');

  const { platform } = synthManifest(path);
  const p = typesOf(platform);

  check(
    'no certificate is synthesized',
    !p['AWS::CertificateManager::Certificate'],
    `found ${p['AWS::CertificateManager::Certificate']}`,
  );
  check(
    'the listener references the adopted certificate ARN',
    JSON.stringify(platform).includes(planEntry(m, 'certificate').identifiers.certificateArn),
  );
  check(
    'an HTTPS listener and an HTTP redirect are both present',
    p['AWS::ElasticLoadBalancingV2::Listener'] === 2,
    `got ${p['AWS::ElasticLoadBalancingV2::Listener']}`,
  );
  check('exactly one alias record', p['AWS::Route53::RecordSet'] === 1, `got ${p['AWS::Route53::RecordSet']}`);
}

console.log('\ncreated-vpc — an adopted OIDC provider is trusted, not recreated:\n');
{
  const path = join(repo, 'examples', 'manifests', 'created-vpc.manifest.yaml');
  const m = parseYaml(readFileSync(path, 'utf8'));
  const entry = planEntry(m, 'github-oidc-provider');
  check('OIDC provider is adopted', entry.action === 'adopt');

  const { platform } = synthManifest(path);
  const p = typesOf(platform);

  // The failure this pins down is EntityAlreadyExists on the first platform deploy
  // into any account that already has a GitHub provider — which is most of them.
  check(
    'no OIDC provider is synthesized',
    !p['Custom::AWSCDKOpenIdConnectProvider'],
    `found ${p['Custom::AWSCDKOpenIdConnectProvider']}`,
  );
  check(
    'and no custom-resource handler comes with it',
    !p['AWS::Lambda::Function'],
    `found ${p['AWS::Lambda::Function']}`,
  );
  check(
    'the deploy role trusts the recorded provider ARN',
    JSON.stringify(platform).includes(entry.identifiers.providerArn),
  );
}

console.log('\ncreated-datastores — a create decision reaches the generated stacks:\n');
{
  const path = join(repo, 'examples', 'manifests', 'created-datastores.manifest.yaml');
  const m = parseYaml(readFileSync(path, 'utf8'));

  check('database is created', planEntry(m, 'database').action === 'create');
  check('table is created', planEntry(m, 'entries-table').action === 'create');
  check(
    'created entries carry parameters, never identifiers',
    !planEntry(m, 'database').identifiers && !planEntry(m, 'entries-table').identifiers,
  );
  check(
    'the isolated plan provisions a Secrets Manager endpoint for the generated credentials',
    m.analysis.egress.awsServices.includes('secretsmanager'),
  );

  const { platform, service } = synthManifest(path);
  const p = typesOf(platform);
  const sv = typesOf(service);

  // The failure this pins down is a create decision that generated nothing at all:
  // before this change the projection skipped any datastore entry that was not
  // `adopt`, so the stacks came out with no database, no table, no grant and no
  // environment variable — and synthesized and deployed cleanly.
  check('a database instance is synthesized', p['AWS::RDS::DBInstance'] === 1, `got ${p['AWS::RDS::DBInstance']}`);
  check('a table is synthesized', p['AWS::DynamoDB::Table'] === 1, `got ${p['AWS::DynamoDB::Table']}`);
  check(
    'the database generates its own credentials secret',
    p['AWS::SecretsManager::Secret'] === 1,
    `got ${p['AWS::SecretsManager::Secret']}`,
  );

  const database = Object.values(platform.Resources).find((r) => r.Type === 'AWS::RDS::DBInstance');
  const table = Object.values(platform.Resources).find((r) => r.Type === 'AWS::DynamoDB::Table');

  // A stack deletion that silently dropped production data would be the worst failure
  // this tool could have, and the asymmetry is total: a retained instance costs money
  // and is deletable by hand, a destroyed one is gone.
  check('the database is retained on stack deletion', database.DeletionPolicy === 'Retain');
  check('the database is deletion-protected', database.Properties.DeletionProtection === true);
  check('the table is retained on stack deletion', table.DeletionPolicy === 'Retain');

  check(
    'the database is built to the recorded shape',
    database.Properties.DBInstanceClass === 'db.t4g.micro' &&
      database.Properties.EngineVersion === '16.4' &&
      database.Properties.AllocatedStorage === '20',
    JSON.stringify({
      class: database.Properties.DBInstanceClass,
      version: database.Properties.EngineVersion,
      storage: database.Properties.AllocatedStorage,
    }),
  );

  // A table's key schema is immutable, so this is the one shape that cannot be fixed
  // later — it is asserted rather than assumed.
  check(
    'the table carries the confirmed key schema',
    JSON.stringify(table.Properties.KeySchema) ===
      JSON.stringify([
        { AttributeName: 'accountId', KeyType: 'HASH' },
        { AttributeName: 'entryId', KeyType: 'RANGE' },
      ]),
    JSON.stringify(table.Properties.KeySchema),
  );

  // The rule the adopt path already held to, now holding for created resources: exact
  // ARNs, never a wildcard resource.
  const tableStatement = Object.values(platform.Resources)
    .filter((r) => r.Type === 'AWS::IAM::Policy')
    .flatMap((r) => r.Properties.PolicyDocument.Statement)
    .find((st) => st.Sid === 'EntriesTableAccess');
  check('the task role is granted on the created table', Boolean(tableStatement));
  check(
    'and scoped to it rather than to a wildcard',
    tableStatement && JSON.stringify(tableStatement.Resource).includes('Fn::GetAtt') &&
      !JSON.stringify(tableStatement.Resource).includes('"*"'),
    JSON.stringify(tableStatement?.Resource),
  );

  const prefix = m.target.ssmPrefix;
  const published = Object.values(platform.Resources)
    .filter((r) => r.Type === 'AWS::SSM::Parameter')
    .map((r) => r.Properties.Name);
  for (const suffix of ['database-endpoint', 'database-port', 'database-secret-arn', 'entries-table-table-name']) {
    check(`the platform stack publishes ${suffix}`, published.includes(`${prefix}/${suffix}`));
  }

  const container = Object.values(service.Resources).find(
    (r) => r.Type === 'AWS::ECS::TaskDefinition',
  ).Properties.ContainerDefinitions[0];
  const envNames = container.Environment.map((e) => e.Name);
  const secretNames = container.Secrets.map((e) => e.Name);

  // A created resource's name is a deploy-time value, so without this the table exists
  // and the container has no way to address it.
  check('the container reads the created table name', envNames.includes('ENTRIES_TABLE'));
  check('the container reads the created database host and port', envNames.includes('PGHOST') && envNames.includes('PGPORT'));
  check(
    'the container reads the credentials from the secret, by field',
    ['PGUSER', 'PGPASSWORD', 'PGDATABASE'].every((n) => secretNames.includes(n)),
    JSON.stringify(secretNames),
  );
  check(
    'and each is a field reference rather than a value',
    container.Secrets.every((sec) => JSON.stringify(sec.ValueFrom).includes('::')),
  );

  // The service stack is redeployed on every push. Nothing stateful can live there.
  const stateful = Object.keys(sv).filter((t) =>
    /RDS|DynamoDB|SecretsManager|ElastiCache|S3::Bucket|SQS|SNS|SecurityGroup|IAM::Role/.test(t),
  );
  check('the service stack holds nothing stateful', stateful.length === 0, stateful.join(', '));
  check(
    'no credential value appears in either template',
    !Object.values(platform.Resources).some(
      (r) => typeof r.Properties?.MasterUserPassword === 'string' || typeof r.Properties?.SecretString === 'string',
    ),
  );
}

rmSync(join(cdkDir, 'lib', 'app-config.ts'), { force: true });
rmSync(join(cdkDir, 'cdk.out'), { recursive: true, force: true });

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll fixture expectations hold.');
