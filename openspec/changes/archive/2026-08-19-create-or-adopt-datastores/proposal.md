## Why

The plan promises a create-or-adopt decision for every resource. For datastores it delivers neither half.

**A `create` decision is silently discarded.** `resource-catalog.md` says the bucket, table, queue and topic entries offer `create` "when the analysis found a name that resolves to nothing." Nothing shipped can do that. `buildDatastores` in `scripts/generate-config.mjs:142` skips any network-reached store whose plan entry is not `adopt`, and line 161 skips any API-reached store for which no adopted entry yields an ARN. So marking a detected DynamoDB table `create` produces no table, no task-role statement, and no environment variable naming it — the generated app synthesizes cleanly, deploys cleanly, and fails at runtime on a table that was never made. This is the same defect the certificate fix closed: a decision the plan records, the projection drops, and the stack therefore gets wrong.

**An `adopt`-only policy makes "I don't have one yet" a dead end.** `database` and `cache` are adopt-only by design — the catalog's stated reason is that a database outlives the service and creating one as a deploy side effect is the wrong default. That reasoning is sound about *defaults* and wrong as a *capability*: it means a repository whose analysis correctly detects Postgres cannot reach an approved plan at all until the user goes and builds a database by hand, and the skill's own instruction is to "stop asking for it." The user is left doing the one part of the job that was mechanical.

**Adoption costs more typing than it needs to.** Every identifier is hand-entered even when the analysis already found the name and the account already holds the resource. The GitHub OIDC provider established the better shape a change ago: look in the account, adopt what is there, and treat a lookup that could not run as a question rather than as absence.

## What Changes

### Discovery before the question

- For each detected datastore, run one targeted account lookup keyed on the name the analysis found — a table name literal, a bucket name, an `*.rds.amazonaws.com` or `*.cache.amazonaws.com` host in configuration, a queue or topic name. A match records `adopt` with the identifiers pre-filled and `validated: true`, and the user is not asked. A lookup that succeeds and finds nothing offers `create` with `validated: true`.
- A lookup that **cannot run** — no credentials, or the describe call denied — falls through to a question. It is never read as absence, because "there is no table" and "I could not check" call for opposite actions and only one of them is safe to guess.
- When the analysis found evidence of a datastore but no name to look up, there is nothing to check: ask, offering both actions.

### Creation for every detected kind

- **Network-reached.** `database` creates an `rds.DatabaseInstance` for the detected engine, `cache` creates an ElastiCache replication group for Redis or a cluster for Memcached, and DocumentDB creates a cluster. Each is created in the platform stack, in the app subnets, with a security group the stack owns and the task security group is admitted into — the same ingress rule the adopt path already writes, now on a group that is not someone else's.
- **API-reached.** DynamoDB tables (key schema and any queried index from the analysis, on-demand billing), S3 buckets (private, encrypted, no public access), SQS queues, and SNS topics. Task-role statements come from the same `analysis.datastores[].iamActions` the adopt path uses, now scoped to the ARNs of the created resources rather than skipped for lack of one.
- Every created stateful resource carries `RemovalPolicy.RETAIN`, and RDS and DocumentDB carry deletion protection. **The plan states this**, so data surviving a stack deletion is an expectation the user agreed to rather than a surprise. `create` also means the *first platform deploy* is no longer a couple of minutes — an RDS instance is tens of minutes — and the plan says that too.
- ElastiCache and DocumentDB creation needs a node type, an engine version and a topology that no analysis can infer. These are asked in planning with a stated default and recorded; they are not defaulted silently.

### Credentials for a created database

- A created database gets a generated Secrets Manager secret at a **deterministic name** derived from the app name and the datastore id, so the service stack can reference it without an environment lookup and without threading a deploy-time ARN through SSM into `Secret.fromSecretCompleteArn`, which cannot take a token.
- The task definition injects the app's detected database environment variables from that secret's JSON fields via ECS `jsonField` — `host`, `port`, `username`, `password`, `dbname`. The mapping from detected variable name to secret field is recorded in the manifest, so it is reviewable in the plan rather than inferred at generation.
- **A single URL-shaped variable cannot be satisfied by a generated secret.** `DATABASE_URL`, `REDIS_URL` and `MONGO_URI` are the common case and the one where the fields exist but the assembled URL does not — nothing can compose one without reading the generated password. When the analysis found such a variable and the datastore is marked `create`, the plan says so and requires a choice: supply an existing secret ARN holding the URL, or accept the discrete variables and adapt the application. Neither is guessed, and the run does not proceed on the assumption that injecting five fields satisfies an app that reads one.

### Created attributes reaching the container

- A created resource's endpoint address, port, table name, bucket name, queue URL or topic ARN is not known at synth time. The platform stack publishes each to SSM under the existing prefix, and the service stack injects them as environment variables under the names the analysis found the application reading. Without this, a created table exists and the container has no way to name it.

### Contract changes

- `NetworkDatastore` and `ApiDatastore` in `templates/cdk/lib/config.ts:74-90` become `Adoptable` unions carrying the creation parameters on the `create` side. **BREAKING** for the generated `config.ts` / `app-config.ts` contract; both are skill-generated and rewritten together, so the break is contained to a re-run.
- `AppConfig.environment` (`config.ts:161`) is a static `Record<string, string>` and cannot express "this variable's value is a platform-published SSM parameter." A companion field is added for that.
- `analysis.datastores[].kind` in `schemas/manifest.schema.json:123` is `["rds", "dynamodb", "elasticache", "s3", "other"]`, while the config types and the projection already handle `documentdb`, `sqs` and `sns`. The schema rejects a manifest recording any of the three, so a repository using SQS cannot be recorded today even on the adopt path. The enum is corrected.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `workload-analysis`: the datastore requirement gains scenarios for recording what a *created* resource needs beyond what an adopted one needs — key schema and queried indexes, engine and version, the connection variables the application reads and their shape — and for recording that the analysis found a datastore but no name to look up.
- `resource-planning`: datastore entries carry a real create-or-adopt decision, decided by an account lookup before any question; the adopt-only rule for `database` and `cache` is replaced; a created database whose application reads a URL-shaped variable is an incomplete plan rather than a silent mismatch; and a `create` decision on a datastore is carried through to generated code rather than dropping the resource and everything that depends on it.
- `infrastructure-generation`: the platform stack creates each detected datastore when the plan says `create`, owns and admits the task group into the created security group, retains created stateful resources, and publishes created attributes to SSM; the service stack injects those attributes and the created database's credentials into the container.

## Impact

- `templates/cdk/lib/config.ts` — `NetworkDatastore` and `ApiDatastore` become `Adoptable` unions with create parameters; a field for environment variables sourced from platform-published SSM parameters; a field for the created-database credential mapping.
- `templates/cdk/lib/platform-stack.ts` — `wireNetworkDatastores` (line 284) branches on create versus adopt and owns the created security group; the `apiDatastores` loop in `buildTaskRole` (line 359) grants against created ARNs; new construction for RDS, ElastiCache, DocumentDB, DynamoDB, S3, SQS and SNS; `publishParameters` gains the created attributes.
- `templates/cdk/lib/service-stack.ts` — environment variables resolved from the published SSM parameters, and the created database's secret fields injected through `buildSecrets`.
- `scripts/generate-config.mjs` — `buildDatastores` emits both modes instead of skipping non-adopt entries, and fails loudly, naming the missing piece, where it silently `continue`d.
- `schemas/manifest.schema.json` — the `kind` enum; the datastore create parameters; the credential mapping.
- `skills/ecs-truly-auto-mode/references/analysis/datastores.md` — the "the skill does not create databases … do not offer to create one" guidance is replaced by what to record for a create decision; the URL-shaped variable problem is documented where the detection happens.
- `skills/ecs-truly-auto-mode/references/planning/resource-catalog.md` — `database`, `cache`, and the bucket/table/queue/topic entries state both actions, their identifiers, and their creation defaults.
- `skills/ecs-truly-auto-mode/references/planning/adopt-validation.md` — the RDS, S3 and DynamoDB checks become the discovery-then-decide procedure, with the lookup-cannot-run branch stated as it is for the OIDC provider; ElastiCache, DocumentDB, SQS and SNS checks added.
- `skills/ecs-truly-auto-mode/references/manifest-schema.md` — the new datastore fields and identifiers.
- `docs/adopting-resources.md`, `docs/known-limits.md` — databases and caches leave the "can only be adopted" list; hosted zones and CodeConnections stay, for reasons that still hold.
- `examples/` and `scripts/verify-fixtures.mjs` — fixtures for a created database, a created table, an adopted datastore found by lookup, and a created database against a URL-reading application.
