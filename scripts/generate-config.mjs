#!/usr/bin/env node
/**
 * Project a manifest into the typed `app-config.ts` the CDK stacks read.
 *
 * This is the concrete implementation of "generation is a pure function of the
 * manifest" — the stacks contain no manifest parsing, and this file contains no
 * infrastructure. Keeping the two apart is what makes the stacks readable and this
 * mapping testable.
 *
 * Usage: node scripts/generate-config.mjs <manifest.yaml> <out.ts>
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

/** Actions granted per API-reached datastore kind, when the manifest doesn't name them. */
const DEFAULT_ACTIONS = {
  s3: ['s3:GetObject', 's3:PutObject'],
  dynamodb: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
  sqs: ['sqs:SendMessage', 'sqs:ReceiveMessage', 'sqs:DeleteMessage'],
  sns: ['sns:Publish'],
};

const NETWORK_KINDS = new Set(['rds', 'elasticache', 'documentdb']);
const API_KINDS = new Set(['dynamodb', 's3', 'sqs', 'sns']);

const DEFAULT_PORTS = { rds: 5432, elasticache: 6379, documentdb: 27017 };
const ENGINE_PORTS = { postgres: 5432, mysql: 3306, mariadb: 3306, sqlserver: 1433, oracle: 1521 };

function resource(manifest, id) {
  return (manifest.plan?.resources ?? []).find((r) => r.id === id);
}

/** A plan entry becomes either {mode:'create'} or {mode:'adopt', ...identifiers}. */
function adoptable(manifest, id, map) {
  const entry = resource(manifest, id);
  if (!entry || entry.action !== 'adopt') return { mode: 'create' };
  return { mode: 'adopt', ...map(entry.identifiers ?? {}) };
}

function buildNetwork(manifest) {
  const vpc = resource(manifest, 'vpc');
  if (vpc?.action !== 'adopt') {
    // AZs are recorded on the create path too, so that synth never needs a context
    // lookup. The skill collects them during planning, where it has credentials.
    const zones = vpc?.identifiers?.availabilityZones ??
      ['a', 'b'].map((s) => `${manifest.target.region}${s}`);
    return { mode: 'create', availabilityZones: zones };
  }
  const ids = vpc.identifiers;
  return {
    mode: 'adopt',
    vpcId: ids.vpcId,
    availabilityZones: ids.availabilityZones,
    ...(ids.isolatedSubnetIds ? { isolatedSubnetIds: ids.isolatedSubnetIds } : {}),
    ...(ids.privateSubnetIds ? { privateSubnetIds: ids.privateSubnetIds } : {}),
    ...(ids.publicSubnetIds ? { publicSubnetIds: ids.publicSubnetIds } : {}),
  };
}

function buildPublicHostname(manifest) {
  const dns = resource(manifest, 'dns-record');
  const cert = resource(manifest, 'certificate');
  const zone = resource(manifest, 'hosted-zone');
  const hostname = manifest.analysis?.hostnames?.public?.[0]?.value;

  if (!hostname || !dns || dns.action === 'skip') return undefined;
  if (cert?.action !== 'adopt' || zone?.action !== 'adopt') return undefined;

  return {
    hostname,
    certificateArn: cert.identifiers.certificateArn,
    hostedZoneId: zone.identifiers.hostedZoneId,
    zoneName: zone.identifiers.zoneName,
  };
}

/**
 * Split datastores by how they are reached. Network-reached stores need a security
 * group rule and no IAM; API-reached stores need IAM and no security group rule.
 * Getting this backwards produces a policy that grants nothing while the real
 * missing piece goes unnoticed.
 */
function buildDatastores(manifest) {
  const networkDatastores = [];
  const apiDatastores = [];

  for (const store of manifest.analysis?.datastores ?? []) {
    if (NETWORK_KINDS.has(store.kind)) {
      const entry = resource(manifest, store.kind === 'rds' ? 'database' : 'cache');
      if (entry?.action !== 'adopt') continue;
      const ids = entry.identifiers;
      networkDatastores.push({
        id: entry.id,
        kind: store.kind,
        securityGroupId: ids.securityGroupId,
        port: ids.port ?? ENGINE_PORTS[store.engine] ?? DEFAULT_PORTS[store.kind],
        endpointAddress: ids.endpointAddress,
      });
      continue;
    }

    if (!API_KINDS.has(store.kind)) continue;

    // Find the plan entry naming the concrete resource this store refers to.
    const entry = (manifest.plan?.resources ?? []).find(
      (r) => r.action === 'adopt' && arnFor(store.kind, r.identifiers, manifest),
    );
    const arn = entry ? arnFor(store.kind, entry.identifiers, manifest) : undefined;
    if (!arn) continue;

    apiDatastores.push({
      id: entry.id,
      kind: store.kind,
      resourceArns: arn,
      actions: store.iamActions?.length ? store.iamActions : DEFAULT_ACTIONS[store.kind],
    });
  }

  return { networkDatastores, apiDatastores };
}

/** Concrete ARNs per API-reached kind. Never wildcards. */
function arnFor(kind, ids = {}, manifest) {
  const { account, region } = manifest.target;
  if (kind === 's3' && ids.bucketName) {
    return [`arn:aws:s3:::${ids.bucketName}`, `arn:aws:s3:::${ids.bucketName}/*`];
  }
  if (kind === 'dynamodb' && ids.tableName) {
    const table = `arn:aws:dynamodb:${region}:${account}:table/${ids.tableName}`;
    return [table, `${table}/index/*`];
  }
  if (kind === 'sqs' && ids.queueName) {
    return [`arn:aws:sqs:${region}:${account}:${ids.queueName}`];
  }
  if (kind === 'sns' && ids.topicArn) {
    return [ids.topicArn];
  }
  return undefined;
}

function buildConfig(manifest) {
  const { analysis, app, target } = manifest;
  const health = analysis.container.healthCheck;
  const { networkDatastores, apiDatastores } = buildDatastores(manifest);

  const awsServices = new Set(analysis.egress.awsServices ?? []);
  // ECR image layers live in S3, so the gateway endpoint is required even for an app
  // that never touches S3. Omitting it produces an image pull failure that never
  // mentions S3.
  if (analysis.egress.classification.value === 'none') awsServices.add('s3');
  // Secret injection happens over the network like anything else.
  if (analysis.config?.secrets?.some((s) => s.source === 'secretsmanager')) {
    awsServices.add('secretsmanager');
  }
  if (analysis.config?.secrets?.some((s) => s.source === 'ssm')) awsServices.add('ssm');

  const lbEntry = resource(manifest, 'load-balancer');

  return {
    name: app.name,
    env: { account: target.account, region: target.region },
    ssmPrefix: target.ssmPrefix ?? `/ecs-auto-mode/${app.name}`,

    architecture: analysis.architecture.value,
    containerPort: analysis.container.port.value,
    healthCheck: {
      type: health.type.value,
      ...(health.type.value === 'http' ? { path: health.path.value } : {}),
    },
    sizing: { cpu: 512, memoryLimitMiB: 1024, desiredCount: 2 },

    egress: analysis.egress.classification.value,
    awsServices: [...awsServices].sort(),

    network: buildNetwork(manifest),
    cluster: adoptable(manifest, 'cluster', (i) => ({ clusterName: i.clusterName })),
    repository: adoptable(manifest, 'ecr-repository', (i) => ({ repositoryName: i.repositoryName })),
    logGroup: adoptable(manifest, 'log-group', (i) => ({ logGroupName: i.logGroupName })),
    logRetentionDays: 30,

    ...(lbEntry && lbEntry.action !== 'skip'
      ? {
          loadBalancer: adoptable(manifest, 'load-balancer', (i) => ({
            loadBalancerArn: i.loadBalancerArn,
            securityGroupId: i.securityGroupId,
            listenerArn: i.listenerArn,
            ...(i.listenerRuleHostHeader ? { listenerRuleHostHeader: i.listenerRuleHostHeader } : {}),
          })),
        }
      : {}),

    ...(buildPublicHostname(manifest) ? { publicHostname: buildPublicHostname(manifest) } : {}),

    networkDatastores,
    apiDatastores,

    environment: Object.fromEntries(
      (analysis.config?.environment ?? []).map((e) => [e.name, e.value]),
    ),
    secrets: (analysis.config?.secrets ?? []).map((s) => ({
      name: s.name,
      source: s.source,
      arn: s.arn,
      ...(s.jsonKey ? { jsonKey: s.jsonKey } : {}),
    })),
  };
}

function main() {
  const [manifestPath, outPath] = process.argv.slice(2);
  if (!manifestPath || !outPath) {
    console.error('usage: generate-config.mjs <manifest.yaml> <out.ts>');
    process.exit(2);
  }

  const manifest = parseYaml(readFileSync(manifestPath, 'utf8'));
  const config = buildConfig(manifest);

  const body = `// GENERATED by ecs-truly-auto-mode from .ecs-auto-mode/manifest.yaml
// Controlled by: (whole manifest)
//
// Do not edit. Change the manifest and re-run the skill; it detects edits here and
// asks before overwriting.

import { AppConfig } from './config';

export const config: AppConfig = ${JSON.stringify(config, null, 2)};
`;

  writeFileSync(outPath, body);
  console.log(`wrote ${outPath}`);
}

main();
