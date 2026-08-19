# Manifest schema

The manifest lives at `.ecs-auto-mode/manifest.yaml` in the target repository. It is
the single source of truth for the skill: **generation is a pure function of the
manifest.** Nothing is read back out of generated code to recover intent.

That has three consequences worth stating plainly:

- Anything that influences generated output must be recorded here. If a decision
  exists only in the conversation, it is lost.
- Re-running the skill diffs fresh analysis against this file, so the fields must be
  comparable — values, not prose.
- The manifest is reviewed by humans. Prefer explicit, readable values over compact
  encodings.

## Top level

```yaml
schemaVersion: 1
app:            { ... }
target:         { ... }
analysis:       { ... }
plan:           { ... }
pipeline:       { ... }
infra:          { ... }
generated:      { ... }
```

### `schemaVersion` (integer, required)

The manifest format version. The skill compares this against the versions it knows.
On an unrecognized version it **stops and reports** — it never reinterprets a
manifest it may not understand. Current version: `1`.

### `app` (object, required)

Identity of the workload.

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string | Kebab-case. Used for stack names, ECR repo, log group, SSM prefix. |
| `dockerfile` | string | Repo-relative path to the Dockerfile. |
| `buildContext` | string | Repo-relative path to the build context directory. |

### `target` (object, required)

Where this deploys. Both fields are required and explicit — the skill does not
inherit a region from the environment, because a CLI profile may not define one and
a silently-wrong region is expensive to discover.

| Field | Type | Notes |
| --- | --- | --- |
| `account` | string | 12-digit AWS account ID. |
| `region` | string | e.g. `us-east-1`. |
| `ssmPrefix` | string | Path prefix for the inter-stack parameters. Defaults to `/ecs-auto-mode/<app.name>`. |
| `cdkQualifier` | string | The target account's CDK bootstrap qualifier. Defaults to `hnb659fds`. Validated during planning — see [adopt-validation.md](./planning/adopt-validation.md#cdk-bootstrap-qualifier). Only differs from the default when the account was bootstrapped with `cdk bootstrap --qualifier <value>`, which changes the name of every bootstrap role and bucket the deploy role assumes. |

## `analysis` (object, required)

Everything derived from reading the repository. Every leaf that represents an
inference is a **finding record** (see below) rather than a bare value.

```yaml
analysis:
  buildValidated: true
  architecture:   { value: ARM64, evidence: [...], confidence: high }
  container:
    port:          { value: 8080, evidence: [...], confidence: high }
    healthCheck:
      type:        { value: http, evidence: [...], confidence: high }
      path:        { value: /health, evidence: [...], confidence: high }
  egress:
    classification: { value: none, evidence: [...], confidence: high }
    awsServices:    [ecr, ecr-docker, logs, secretsmanager]
    externalHosts:  []
  hostnames:
    public:   [ { value: api.example.com, evidence: [...], confidence: medium } ]
    internal: [ ]
  datastores:
    - kind: rds
      engine: postgres
      planId: database
      nameFound: false
      evidence: [...]
      confidence: high
      iamActions: []
      connection:
        style:     { value: fields, confidence: high, evidence: [...] }
        variables: [ { name: PGHOST, field: host }, { name: PGPASSWORD, field: password } ]
  config:
    environment: [ { name: LOG_LEVEL, value: info } ]
    secrets:     [ { name: DATABASE_PASSWORD, evidence: [...], confidence: high } ]
  buildContextPaths: [src/**, package.json, package-lock.json]
```

| Field | Type | Controls |
| --- | --- | --- |
| `buildValidated` | boolean | Gate on generation. Must be `true` to proceed. |
| `architecture` | finding → `ARM64` \| `X86_64` | Service stack Fargate runtime platform. |
| `container.port` | finding → integer | Container port, target group port. |
| `container.healthCheck.type` | finding → `http` \| `tcp` | Target group health check type. |
| `container.healthCheck.path` | finding → string | Health check path. Absent when type is `tcp`. |
| `egress.classification` | finding → `none` \| `public` | **Subnet placement and whether a NAT gateway exists.** |
| `egress.awsServices` | array of service keys | Which VPC interface endpoints the platform stack creates. |
| `egress.externalHosts` | array of finding | Hosts that forced `public`. Empty when classification is `none`. |
| `hostnames.public` | array of finding | Candidate domains for the DNS record and certificate. |
| `hostnames.internal` | array of finding | Service-discovery candidates. |
| `datastores` | array (see below) | Task role permissions, security group rules, plan entries. |
| `config.environment` | array of `{name, value}` | Plaintext task definition environment entries. |
| `config.secrets` | array of secret record | Task definition `secrets` entries. **Structurally cannot hold a value** — see below. |
| `buildContextPaths` | array of glob | Pipeline path filter. |

### Datastore entries

| Field | Type | Notes |
| --- | --- | --- |
| `kind` | `rds` \| `dynamodb` \| `elasticache` \| `documentdb` \| `s3` \| `sqs` \| `sns` \| `other` | `other` is adopt-only: the skill cannot create what it could not identify. |
| `engine` | string | For `rds`: `postgres`, `mysql`, etc. An `aurora-*` engine is adopt-only. |
| `evidence` | array | Supporting evidence. |
| `confidence` | see below | |
| `iamActions` | array of string | Actions granted to the task role. Empty for network-reached stores like RDS. |
| `planId` | string | **The entry in `plan.resources` this datastore is decided by.** |
| `nameFound` | boolean | Whether a name exists to look up in the account. |
| `schema` | object | A table's key shape. Required before `create`. |
| `connection` | object | How a network-reached store is reached. Required before `create`. |
| `attributeVariables` | array of `{name, attribute}` | Environment variables carrying an API-reached resource's name. |

`planId` is the link between a finding and its create-or-adopt decision, and it is not
optional. The network-reached kinds map onto fixed ids (`database`, `cache`), but an
API-reached entry's id names its role — `receipts-bucket`, `sessions-table` — so two
buckets are indistinguishable without it. An adopted entry could once be matched by its
identifiers; a created one has none.

`nameFound` decides which branch planning takes: `true` runs one targeted account lookup,
`false` means there is nothing to look up, so the entry is asked about rather than the
account enumerated. Absent means `false`.

#### `schema` — a table's key shape

```yaml
schema:
  partitionKey:
    value: { name: sessionId, type: string }   # string | number | binary
    confidence: high
    evidence: [ { file: app/sessions.py, line: 14 } ]
  sortKey:   { value: { name: createdAt, type: number }, confidence: high, evidence: [...] }
  indexes:
    - name: by-account
      partitionKey: { name: accountId, type: string }
```

`partitionKey` and `sortKey` are **findings**, carrying evidence and a confidence level;
the index entries are not, because an index is only recorded when the code was found to
query it. A `create` decision requires `partitionKey` at `high` confidence or
`confirmedByUser` — a table's key schema is immutable, so there is no default here at any
confidence level.

#### `connection` — how a network-reached store is reached

```yaml
connection:
  style:
    value: fields                              # fields | url
    confidence: high
    evidence: [ { file: src/db.ts, line: 4 } ]
  variables:
    - { name: PGHOST,     field: host }         # host | port | username | password | dbname
    - { name: PGPASSWORD, field: password }
```

The `style` decides whether a **created** datastore is usable: a generated secret holds
discrete fields and cannot hold an assembled URL. `style: url` plus a `create` decision is
an incomplete plan — see
[resource-catalog.md](./planning/resource-catalog.md#database).

`host` and `port` are served from the published endpoint parameters rather than from the
secret; the rest are injected as secret fields. Like `secrets`, this object records names
and fields only — **there is no property in it that could hold a value.**

## Finding records

Every inference is recorded as:

```yaml
value: 8080
confidence: high
evidence:
  - file: Dockerfile
    line: 12
    excerpt: "EXPOSE 8080"
  - file: src/server.ts
    line: 41
    excerpt: "app.listen(8080)"
```

`confidence` is one of:

| Level | Meaning | Behavior in the plan |
| --- | --- | --- |
| `high` | Multiple corroborating signals, or one unambiguous one. | Stated as a default. Not asked about. |
| `medium` | One plausible signal, no corroboration. | **Asked**, with the finding pre-filled as the suggested answer. |
| `low` | Weak or indirect signal. | **Asked**, presented as a guess. |
| `conflict` | Signals disagree. | **Asked**, with all competing values and their evidence shown. |

The rule the skill enforces: **anything not `high` becomes a question.** There is no
silent fallback. A finding recorded at `medium` that the user confirms is rewritten
to `high` with a `confirmedByUser: true` marker, so later runs stop asking.

`evidence` entries may omit `line` and `excerpt` when the signal is the existence of
a file (a `Gemfile`, a `migrations/` directory) rather than a line within one.

### Secret records

Secrets are the one thing that is deliberately *not* a finding record, because a
finding record has a `value` field and that is precisely the field someone would
paste a credential into. A secret entry has no `value` property at all, and the JSON
Schema sets `additionalProperties: false`, so a secret value cannot be written to the
manifest even by mistake:

```yaml
config:
  secrets:
    - name: DATABASE_PASSWORD        # the env var name the container reads
      source: secretsmanager
      arn: arn:aws:secretsmanager:us-east-1:071128183726:secret:prod/db-AbC123
      jsonKey: password              # optional, for JSON-valued secrets
      confidence: high
      evidence:
        - file: src/db.ts
          line: 8
          excerpt: "password: process.env.DATABASE_PASSWORD"
```

The skill records the name and a pointer to where the value lives. It does not read
the value — a secret pulled into an agent's context is a secret that has leaked.

## `plan` (object, required)

One entry per AWS resource. This is what the user reviews and approves.

```yaml
plan:
  approved: true
  resources:
    - id: vpc
      action: adopt
      identifiers:
        vpcId: vpc-0abc123
        availabilityZones: [us-east-1a, us-east-1b]
        isolatedSubnetIds: [subnet-0a, subnet-0b]
      reason: "User supplied an existing VPC"
    - id: cluster
      action: create
      reason: "No existing cluster supplied"
    - id: nat-gateway
      action: skip
      reason: "egress.classification is none — no outbound call leaves the VPC"
```

| Field | Type | Notes |
| --- | --- | --- |
| `approved` | boolean | Generation is blocked until `true`. |
| `resources[].id` | string | Key from the resource catalog. |
| `resources[].action` | `create` \| `adopt` \| `skip` | |
| `resources[].identifiers` | object | **Required and non-empty when `action: adopt`.** Shape is per-resource; see the resource catalog. |
| `resources[].parameters` | object | **Only valid when `action: create`.** The chosen shape of a resource being built. |
| `resources[].reason` | string | Why this action. Shown in the plan. |
| `resources[].validated` | boolean | Set when an adopted identifier was verified against AWS. |

A plan containing any `adopt` entry with missing identifiers is **incomplete**, and
generation does not run regardless of `approved`.

`identifiers` and `parameters` are mirror images: the first says what to *import*, the
second says what to *build*. They are separate fields rather than one bag because a
created resource has nothing to import and an adopted one has no shape to choose, so a
value in the wrong one would apply to nothing at all — silently. The validator rejects
each on the wrong action for that reason.

Identifiers are shape-checked per resource by the resource catalog rather than by the
JSON Schema, which only requires that an adopted entry carries at least one. Two
entries are worth calling out because a missing decision on either produces a deploy
failure rather than a generation failure:

| Entry | `create` means | `adopt` identifiers |
| --- | --- | --- |
| `certificate` | Issue a DNS-validated certificate against the adopted hosted zone. Requires `hosted-zone` to be `adopt`. | `certificateArn` |
| `github-oidc-provider` | The target account has no provider for `token.actions.githubusercontent.com`, so create one. | `providerArn` |
| `database` | Build a single-instance relational or document database, retained and deletion-protected, with generated credentials. Needs `parameters`. | `dbInstanceIdentifier`, `endpointAddress`, `port`, `securityGroupId` |
| `cache` | Build an ElastiCache cluster, retained. Needs `parameters`. | `cacheClusterId`, `endpointAddress`, `port`, `securityGroupId` |
| bucket / table / queue / topic | Build the resource to a fixed shape, retained. A table also needs a confirmed key schema. | `bucketName` / `tableName` / `queueUrl` / `topicArn` |

The `github-oidc-provider` entry is **required** when `pipeline.target` is
`github-actions`. It is not optional and it does not default: the generated role
creates a provider when handed no ARN, and most accounts already have one, so an
absent entry is a first deploy that fails with `EntityAlreadyExists`. Planning decides
it by looking in the account, and asks when it cannot look — see
[adopt-validation.md](./planning/adopt-validation.md#github-oidc-provider).

## `pipeline` (object, required)

| Field | Type | Notes |
| --- | --- | --- |
| `target` | `github-actions` \| `codepipeline` | Which generator runs. |
| `branch` | string | Branch the trigger watches. |
| `pathFilter` | array of glob | Derived from `analysis.buildContextPaths` plus the Dockerfile, lockfiles, and service stack source. |
| `roleArn` | string | For `github-actions`: the OIDC role. Recorded once created or adopted. |
| `repository` | string | For `github-actions`: `owner/repo`, used to scope the OIDC trust policy. |
| `connectionArn` | string | For `codepipeline`: the CodeConnections ARN. |

## `infra` (object)

The shape of the generated CDK project. Chosen by the user in Phase 2, alongside the
pipeline target — see [iac-style.md](./generation/iac-style.md).

```yaml
infra:
  style: projen
  cdkVersion: 2.263.0
```

| Field | Type | Notes |
| --- | --- | --- |
| `style` | `plain` \| `projen` | `plain` is a hand-maintained CDK app; `projen` derives the project files from `.projenrc.ts`. |
| `cdkVersion` | string | Required when `style` is `projen`. Exact version, no range prefix — `AwsCdkTypeScriptApp` takes a version, not a range. Kept equal to the `aws-cdk-lib` floor the plain template pins. |

**An absent `infra` means `plain`.** Manifests written before this field existed
describe a plain app, and reading one must not silently convert a repository to
projen. This is why the field is optional rather than required — an optional field
with a stated default costs nothing, while a required one would break resume on every
existing repository and buy no clarity.

The style changes the file layout and who owns the scaffolding. It does not change
the stacks, and both styles synthesize identical CloudFormation.

## `generated` (object)

The overwrite-protection record. Each entry is a file the skill owns and the SHA-256
of the content it last wrote.

```yaml
generated:
  - path: infra/lib/platform-stack.ts
    sha256: 3f2a...
    section: plan.resources
```

Before overwriting, the skill hashes the file on disk. If it differs from `sha256`,
the file has been edited since generation and the skill **shows the difference and
asks** rather than writing. `section` names the manifest field that controls the
file, so the header in the generated file can point back here.

Under `infra.style: projen`, projen's own outputs — `package.json`, `tsconfig.json`,
`cdk.json`, `.gitignore`, `.projen/`, `package-lock.json` — **never** appear here.
They are regenerated by `npx projen` on a cadence this skill does not control, so a
recorded hash would go stale on a run the user did themselves and stall the next
generation on a diff nobody made.

## What never appears in the manifest

- Secret **values**. Only names, and the ARN or parameter name of the store holding
  them. A secret read into an agent's context is a secret that has leaked.
- Anything recoverable by lookup at synth time. Adopted resources record explicit
  attributes precisely so that `cdk synth` needs no credentials.
