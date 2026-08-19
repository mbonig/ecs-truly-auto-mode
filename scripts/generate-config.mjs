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
const IAM_AUTH_KINDS = new Set(['dsql']);

const DEFAULT_PORTS = { rds: 5432, elasticache: 6379, documentdb: 27017 };
const ENGINE_PORTS = { postgres: 5432, mysql: 3306, mariadb: 3306, sqlserver: 1433, oracle: 1521 };

/** dsql:DbConnect for a named database role, dsql:DbConnectAdmin for admin. */
const DSQL_ACTIONS = { admin: ['dsql:DbConnectAdmin'], default: ['dsql:DbConnect'] };

/** The identifier an adopted API-reached datastore has to name, for the error message. */
const ADOPT_IDENTIFIER = {
  s3: 'bucketName',
  dynamodb: 'tableName',
  sqs: 'queueName',
  sns: 'topicArn',
};

/**
 * The SSM parameter suffix a created API-reached resource's name is published under.
 *
 * Named after the attribute rather than the kind, because that is what the container is
 * reading: a queue's URL and a topic's ARN are not interchangeable with a name.
 */
const ATTRIBUTE_PARAMETER = {
  s3: 'bucket-name',
  dynamodb: 'table-name',
  sqs: 'queue-url',
  sns: 'topic-arn',
};

function resource(manifest, id) {
  return (manifest.plan?.resources ?? []).find((r) => r.id === id);
}

/**
 * Stop with a message naming what is missing.
 *
 * The plan is the gate, and a gate that lets an incomplete plan through quietly is
 * worse than no gate: the output looks like a successful generation of a different
 * application.
 */
function fail(message) {
  console.error(`generate-config: ${message}`);
  process.exit(1);
}

/** How a plan entry reads in an error message, including when it is not there at all. */
function describeAction(entry) {
  return entry ? `marked '${entry.action}'` : 'missing';
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

/**
 * The public hostname, or nothing at all.
 *
 * The hosted zone is what gates this, not the certificate. Without a zone there is
 * nowhere to put the alias record or a DNS validation record, so neither the record
 * nor a created certificate can exist — and the skill never creates zones.
 *
 * Anything short of that is an error rather than an omission. Returning `undefined`
 * for an incomplete plan is how a `certificate: create` decision used to produce an
 * internal HTTP-only load balancer with no DNS record and no diagnostic.
 */
function buildPublicHostname(manifest) {
  const dns = resource(manifest, 'dns-record');
  const cert = resource(manifest, 'certificate');
  const zone = resource(manifest, 'hosted-zone');
  const hostname = manifest.analysis?.hostnames?.public?.[0]?.value;

  // No hostname wanted: an internal load balancer serving HTTP is the intended shape.
  if (!hostname || !dns || dns.action === 'skip') return undefined;

  if (zone?.action !== 'adopt' || !zone.identifiers?.hostedZoneId || !zone.identifiers?.zoneName) {
    fail(
      `plan.resources: '${hostname}' is recorded as a public hostname, but the 'hosted-zone' entry is ` +
        `${describeAction(zone)}. A public hostname needs an adopted hosted zone with hostedZoneId and ` +
        'zoneName — the skill does not create hosted zones, because that means delegating nameservers ' +
        'at a registrar.',
    );
  }

  if (!cert || cert.action === 'skip') {
    fail(
      `plan.resources: '${hostname}' is recorded as a public hostname, but the 'certificate' entry is ` +
        `${describeAction(cert)}. Serving it over HTTPS needs a certificate created or adopted.`,
    );
  }

  if (cert.action === 'adopt' && !cert.identifiers?.certificateArn) {
    fail("plan.resources: the 'certificate' entry is marked adopt but records no certificateArn.");
  }

  return {
    hostname,
    certificate:
      cert.action === 'adopt'
        ? { mode: 'adopt', certificateArn: cert.identifiers.certificateArn }
        : { mode: 'create' },
    hostedZoneId: zone.identifiers.hostedZoneId,
    zoneName: zone.identifiers.zoneName,
  };
}

/**
 * Split datastores by how they are reached, and project each as created or adopted.
 *
 * Network-reached stores need a security group rule and no IAM; API-reached stores need
 * IAM and no security group rule. Getting this backwards produces a policy that grants
 * nothing while the real missing piece goes unnoticed.
 *
 * Every branch here that cannot produce a datastore calls `fail`. It used to `continue`,
 * which is how a `create` decision came to produce an application with no table, no
 * grant and no environment variable naming it — a silent success describing a different
 * application. An incomplete entry stops generation instead.
 */
function buildDatastores(manifest) {
  const networkDatastores = [];
  const apiDatastores = [];
  const iamAuthDatastores = [];
  const environmentFromSsm = {};

  for (const store of manifest.analysis?.datastores ?? []) {
    if (store.kind === 'other') {
      const entry = datastoreEntry(manifest, store);
      if (entry?.action === 'create') {
        fail(
          `plan.resources: entry '${entry.id}' is marked create for a datastore of kind 'other'. ` +
            'The skill cannot create a resource it was unable to identify — adopt it, or record a ' +
            'kind it can name.',
        );
      }
      // An adopted or skipped `other` contributes nothing generable, by design.
      continue;
    }

    const entry = datastoreEntry(manifest, store);
    if (!entry) {
      fail(
        `analysis.datastores: the ${store.kind} datastore records planId '${store.planId ?? '(none)'}', ` +
          'which is not an entry in plan.resources. Without that link the datastore cannot be matched ' +
          'to its create-or-adopt decision.',
      );
    }
    if (entry.action === 'skip') continue;

    if (NETWORK_KINDS.has(store.kind)) {
      networkDatastores.push(buildNetworkDatastore(manifest, store, entry, environmentFromSsm));
      continue;
    }

    if (IAM_AUTH_KINDS.has(store.kind)) {
      iamAuthDatastores.push(buildIamAuthDatastore(manifest, store, entry, environmentFromSsm));
      continue;
    }

    if (!API_KINDS.has(store.kind)) {
      fail(`analysis.datastores: kind '${store.kind}' is neither network-reached nor API-reached`);
    }

    apiDatastores.push(buildApiDatastore(manifest, store, entry, environmentFromSsm));
  }

  return { networkDatastores, apiDatastores, iamAuthDatastores, environmentFromSsm };
}

/** The plan entry a datastore is linked to. */
function datastoreEntry(manifest, store) {
  return store.planId ? resource(manifest, store.planId) : undefined;
}

/** The port for a network-reached store, from the plan, the engine, or the kind. */
function portFor(store, ids = {}) {
  return ids.port ?? ENGINE_PORTS[store.engine] ?? DEFAULT_PORTS[store.kind];
}

function buildNetworkDatastore(manifest, store, entry, environmentFromSsm) {
  if (entry.action === 'adopt') {
    const ids = entry.identifiers ?? {};
    for (const key of ['securityGroupId', 'endpointAddress']) {
      if (!ids[key]) {
        fail(
          `plan.resources: entry '${entry.id}' is marked adopt for a ${store.kind} datastore but ` +
            `records no ${key}. Without it the generated stack cannot reach the datastore, and the ` +
            'application fails at startup with a connection timeout rather than a clear error.',
        );
      }
    }
    return {
      id: entry.id,
      mode: 'adopt',
      kind: store.kind,
      securityGroupId: ids.securityGroupId,
      port: portFor(store, ids),
      endpointAddress: ids.endpointAddress,
    };
  }

  if (store.kind === 'rds' && store.engine?.startsWith('aurora')) {
    fail(
      `plan.resources: entry '${entry.id}' is marked create for engine '${store.engine}'. An Aurora ` +
        "cluster's writer and reader topology is not derivable from application code, and a " +
        'single-instance cluster misrepresents it — an Aurora engine can only be adopted.',
    );
  }

  const params = entry.parameters ?? {};
  const require = (...keys) => {
    const missing = keys.filter((k) => params[k] === undefined);
    if (missing.length) {
      fail(
        `plan.resources: entry '${entry.id}' is marked create for a ${store.kind} datastore but ` +
          `records no [${missing.join(', ')}] in parameters. These carry a standing cost or a ` +
          'durability consequence, so they are asked rather than defaulted.',
      );
    }
  };

  const port = portFor(store, params);
  const common = {
    id: entry.id,
    mode: 'create',
    kind: store.kind,
    endpointParameter: `${entry.id}-endpoint`,
    portParameter: `${entry.id}-port`,
    port,
  };

  // Variables the application reads for this datastore that are served from SSM rather
  // than from the credentials secret — a cache endpoint, typically, since ElastiCache
  // has no generated secret to read a host out of.
  const fromSsm = (variables) => {
    for (const variable of variables) {
      if (variable.field === 'host') environmentFromSsm[variable.name] = common.endpointParameter;
      else if (variable.field === 'port') environmentFromSsm[variable.name] = common.portParameter;
    }
  };

  // Host and port come from the published parameters for every created kind, not just
  // the ones with no secret: the endpoint is a deploy-time value either way, and the
  // secret's `host` field is only populated for engines that report one.
  fromSsm(store.connection?.variables ?? []);

  if (store.kind === 'elasticache') {
    require('nodeType', 'engine');
    return {
      ...common,
      engine: params.engine,
      nodeType: params.nodeType,
      ...(params.replicaCount === undefined ? {} : { replicaCount: params.replicaCount }),
    };
  }

  const credentials = buildDatabaseCredentials(manifest, store, entry);

  if (store.kind === 'documentdb') {
    require('instanceClass', 'instanceCount');
    return {
      ...common,
      instanceClass: params.instanceClass,
      instanceCount: params.instanceCount,
      credentials,
    };
  }

  require('instanceClass', 'engineVersion', 'allocatedStorageGb', 'multiAz');
  return {
    ...common,
    engine: store.engine,
    engineVersion: params.engineVersion,
    instanceClass: params.instanceClass,
    allocatedStorageGb: params.allocatedStorageGb,
    multiAz: params.multiAz,
    credentials,
  };
}

/**
 * How a created database's generated credentials reach the container.
 *
 * A generated secret holds host, port, username, password and dbname. It does not hold
 * an assembled connection URL, and composing one would mean reading the password to
 * build it — so an application that reads a single `DATABASE_URL` cannot be served from
 * here. That case is not silently approximated by injecting five variables the
 * application never reads: it stops, and names the two things that would resolve it.
 */
function buildDatabaseCredentials(manifest, store, entry) {
  const style = store.connection?.style?.value;
  if (!style) {
    fail(
      `plan.resources: entry '${entry.id}' is marked create for a ${store.kind} datastore but the ` +
        'analysis records no connection style. Whether the application reads discrete fields or a ' +
        'single URL decides whether a generated secret can serve it at all.',
    );
  }

  const variables = store.connection.variables ?? [];

  if (style === 'url') {
    const named = new Set(
      (manifest.analysis?.config?.secrets ?? []).filter((s) => s.arn).map((s) => s.name),
    );
    const uncovered = variables.map((v) => v.name).filter((name) => !named.has(name));
    if (uncovered.length) {
      fail(
        `plan.resources: entry '${entry.id}' is marked create, but the application reads ` +
          `[${uncovered.join(', ')}] as a single connection URL and a generated secret cannot supply ` +
          'one. Either record an existing secret holding the URL for each of those variables — the ' +
          'database is still created — or record connection.style "fields" and adapt the application ' +
          'to read the discrete fields.',
      );
    }
    // The URL comes from an adopted secret in analysis.config.secrets, which is
    // projected like any other. Nothing is injected from the generated one.
    return { secretArnParameter: `${entry.id}-secret-arn`, fields: {} };
  }

  const fields = {};
  for (const variable of variables) {
    // host and port are served from the published parameters instead — see fromSsm.
    if (!variable.field || variable.field === 'host' || variable.field === 'port') continue;
    fields[variable.name] = variable.field;
  }
  return { secretArnParameter: `${entry.id}-secret-arn`, fields };
}

/**
 * An IAM-authenticated network datastore: reached over TCP like RDS/ElastiCache, but
 * authorised by IAM like DynamoDB/S3/SQS/SNS. Aurora DSQL — the only kind implemented
 * so far — has no security group, no generated secret, and no password anywhere in
 * the system, so it belongs to neither `NETWORK_KINDS` nor `API_KINDS`.
 *
 * The endpoint is never a secret — it is plaintext configuration, like a bucket name.
 * On the adopt path its value is already known at plan time, so it is the analysis's
 * job to have recorded it as a literal in `analysis.config.environment`; this function
 * only checks that literal exists. On the create path it is a deploy-time value, like
 * a created cache's endpoint, so it goes through `environmentFromSsm` instead.
 */
function buildIamAuthDatastore(manifest, store, entry, environmentFromSsm) {
  if (!store.endpointEnvVar) {
    fail(
      `analysis.datastores: the dsql entry '${entry.id}' records no endpointEnvVar — the environment ` +
        'variable the container reads the endpoint from must be named, learned from the code that ' +
        'reads it, never invented.',
    );
  }

  const dbUser = store.dbUser ?? 'admin';
  const actions = store.iamActions?.length
    ? store.iamActions
    : dbUser === 'admin'
      ? DSQL_ACTIONS.admin
      : DSQL_ACTIONS.default;
  const common = { id: entry.id, kind: store.kind, port: 5432, actions, dbUser };
  const classification = manifest.analysis.egress.classification.value;

  if (entry.action === 'adopt') {
    const ids = entry.identifiers ?? {};
    if (!ids.clusterIdentifier) {
      fail(
        `plan.resources: entry '${entry.id}' is marked adopt for a dsql datastore but records no ` +
          'clusterIdentifier.',
      );
    }
    if (classification === 'none' && !ids.vpcEndpointServiceName) {
      fail(
        `plan.resources: entry '${entry.id}' is adopted and egress.classification is 'none', but ` +
          'records no vpcEndpointServiceName. The certificate DSQL presents on the public endpoint ' +
          'does not cover the VPC-endpoint hostname, so the isolated form has to be resolved and ' +
          'recorded — see references/analysis/egress.md.',
      );
    }
    const environment = manifest.analysis?.config?.environment ?? [];
    if (!environment.some((e) => e.name === store.endpointEnvVar)) {
      fail(
        `analysis.config.environment: '${store.endpointEnvVar}' is the dsql entry '${entry.id}'s ` +
          "endpoint variable, but it is not recorded there. An adopted cluster's endpoint is known " +
          'at plan time, so it belongs in the literal environment, not derived here.',
      );
    }

    return {
      ...common,
      mode: 'adopt',
      clusterIdentifier: ids.clusterIdentifier,
      ...(ids.vpcEndpointServiceName ? { vpcEndpointServiceName: ids.vpcEndpointServiceName } : {}),
    };
  }

  // Created: the endpoint does not exist until deploy, so it travels through SSM —
  // same mechanism as a created ElastiCache cluster's endpoint, which has no secret
  // to read a host out of either.
  const endpointParameter = `${entry.id}-endpoint`;
  environmentFromSsm[store.endpointEnvVar] = endpointParameter;

  return { ...common, mode: 'create', endpointParameter };
}

function buildApiDatastore(manifest, store, entry, environmentFromSsm) {
  const actions = store.iamActions?.length ? store.iamActions : DEFAULT_ACTIONS[store.kind];

  if (entry.action === 'adopt') {
    const arns = arnFor(store.kind, entry.identifiers, manifest);
    if (!arns) {
      fail(
        `plan.resources: entry '${entry.id}' is marked adopt for a ${store.kind} datastore but its ` +
          'identifiers do not name the resource — expected ' +
          `${ADOPT_IDENTIFIER[store.kind]}. Without it the task role has nothing to be scoped to.`,
      );
    }
    return { id: entry.id, mode: 'adopt', kind: store.kind, resourceArns: arns, actions };
  }

  const attributeParameter = `${entry.id}-${ATTRIBUTE_PARAMETER[store.kind]}`;
  for (const variable of store.attributeVariables ?? []) {
    environmentFromSsm[variable.name] = attributeParameter;
  }

  const created = { id: entry.id, mode: 'create', kind: store.kind, actions, attributeParameter };

  if (store.kind !== 'dynamodb') return created;

  const pk = store.schema?.partitionKey;
  if (!pk) {
    fail(
      `plan.resources: entry '${entry.id}' is marked create for a DynamoDB table but the analysis ` +
        "records no key schema. A table's key schema is immutable, so a table created on a guess is " +
        'deleted and rebuilt rather than altered.',
    );
  }
  if (pk.confidence !== 'high' && !pk.confirmedByUser) {
    fail(
      `plan.resources: entry '${entry.id}' is marked create for a DynamoDB table whose partition key ` +
        `is '${pk.confidence}' confidence and unconfirmed. A table's key schema is immutable, so this ` +
        'one has to be asked about rather than defaulted.',
    );
  }

  return {
    ...created,
    partitionKey: pk.value,
    ...(store.schema.sortKey ? { sortKey: store.schema.sortKey.value } : {}),
    ...(store.schema.indexes?.length ? { indexes: store.schema.indexes } : {}),
  };
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

/**
 * The pipeline's shape, including the OIDC provider decision.
 *
 * That decision is required rather than defaulted. `GitHubOidcRole` creates a provider
 * when it is handed no ARN, and most accounts already have one for
 * `token.actions.githubusercontent.com` — so a missing decision here is a first deploy
 * that fails with `EntityAlreadyExists`. Planning looks in the account, or asks; either
 * way the answer is recorded in the plan and this reads it.
 */
function buildPipeline(manifest) {
  const { pipeline } = manifest;
  if (pipeline.target !== 'github-actions') {
    return { target: pipeline.target, branch: pipeline.branch };
  }

  const provider = resource(manifest, 'github-oidc-provider');
  if (!provider || provider.action === 'skip') {
    fail(
      "plan.resources: the pipeline target is github-actions but there is no 'github-oidc-provider' " +
        'entry. Look for one in the account with `aws iam list-open-id-connect-providers`, or ask — ' +
        'do not leave it undecided, because the generated stack would create a second provider and ' +
        'fail with EntityAlreadyExists on any account that already has one.',
    );
  }
  if (provider.action === 'adopt' && !provider.identifiers?.providerArn) {
    fail(
      "plan.resources: the 'github-oidc-provider' entry is marked adopt but records no providerArn.",
    );
  }

  return {
    target: 'github-actions',
    branch: pipeline.branch,
    repository: pipeline.repository,
    oidcProvider:
      provider.action === 'adopt'
        ? { mode: 'adopt', providerArn: provider.identifiers.providerArn }
        : { mode: 'create' },
  };
}

function buildConfig(manifest) {
  const { analysis, app, target } = manifest;
  const health = analysis.container.healthCheck;
  const { networkDatastores, apiDatastores, iamAuthDatastores, environmentFromSsm } = buildDatastores(manifest);

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
  // A created database generates its own secret, which the ECS agent fetches through the
  // task's own network interface on Fargate. An isolated workload that previously needed
  // no Secrets Manager endpoint needs one now, and without it the task cannot start —
  // with an error naming Secrets Manager rather than the database.
  if (networkDatastores.some((d) => d.mode === 'create' && d.credentials)) {
    awsServices.add('secretsmanager');
  }
  // The service stack reads created datastore attributes from Parameter Store, but that
  // read is CloudFormation's at deploy time rather than the task's, so it adds no
  // endpoint requirement of its own.

  // The DSQL *data* plane, not the control plane: connecting never calls the latter,
  // since generating a connection auth token is local SigV4 signing with no request.
  // Recording 'dsql' here would provision an endpoint that bills hourly and is never
  // used to reach the datastore.
  if (iamAuthDatastores.length > 0 && analysis.egress.classification.value === 'none') {
    awsServices.add('dsql-data');
  }

  const lbEntry = resource(manifest, 'load-balancer');

  return {
    name: app.name,
    env: { account: target.account, region: target.region },
    ssmPrefix: target.ssmPrefix ?? `/ecs-auto-mode/${app.name}`,
    cdkQualifier: target.cdkQualifier ?? 'hnb659fds',

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
    iamAuthDatastores,

    environment: Object.fromEntries(
      (analysis.config?.environment ?? []).map((e) => [e.name, e.value]),
    ),
    // Variables whose values are published SSM parameters: a created resource's
    // physical id is a deploy-time value, so it cannot be a literal above.
    environmentFromSsm,
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
  const pipeline = buildPipeline(manifest);

  const body = `// GENERATED by ecs-truly-auto-mode from .ecs-auto-mode/manifest.yaml
// Controlled by: (whole manifest)
//
// Do not edit. Change the manifest and re-run the skill; it detects edits here and
// asks before overwriting.

import { AppConfig, PipelineConfig } from './config';

export const config: AppConfig = ${JSON.stringify(config, null, 2)};

// Kept separate from \`config\`: the pipeline's shape, not the resource plan's.
// bin/app.ts reads this to decide whether the platform stack needs the GitHub OIDC role.
export const pipeline: PipelineConfig = ${JSON.stringify(pipeline, null, 2)};
`;

  writeFileSync(outPath, body);
  console.log(`wrote ${outPath}`);
}

main();
