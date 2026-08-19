## Context

Datastores are the last resource class where the plan's create-or-adopt contract is not real. `database` and `cache` are adopt-only by policy; buckets, tables, queues and topics nominally offer `create`, but `buildDatastores` in `scripts/generate-config.mjs` drops any entry that is not `adopt` (lines 142 and 161), so the decision never reaches the stack. See [proposal.md](./proposal.md) for the failure in each direction.

Three existing facts constrain the design:

- **Synth must be hermetic.** No `fromLookup`, no `cdk.context.json`, no credentials. Anything a created resource's name or endpoint is needed for has to arrive through the platform → service SSM contract, because a created resource's physical id is a deploy-time value.
- **The platform/service split is by change frequency.** The service stack is redeployed on every push to the branch. Nothing stateful can live there.
- **The manifest is the only input to generation, and it separates read from chosen.** `analysis.*` holds what was read out of the repository, with evidence and a confidence level. `plan.resources[].identifiers` holds what the user supplied. There is currently no place for "what the user chose about a resource the skill is creating."

The GitHub OIDC provider change established the pattern this one follows: look in the account, adopt what is there, create when the account is confirmed empty, and ask when the check could not run.

## Goals / Non-Goals

**Goals:**

- A datastore's `create` decision produces the resource, its permissions or its security group rule, and the environment variables naming it — or the plan says why it cannot, and stops.
- An `adopt` decision costs no typing when the account already holds the resource the analysis named.
- A created database is usable by the container without a manual step nobody was prompted for.
- Created stateful resources survive a stack deletion, and the user agreed to that in the plan.

**Non-Goals:**

- **Schema migrations.** A created database is empty. A repository with `alembic.ini` still needs a migration step, and this change does not add one to the pipeline. The completion report says so.
- **Aurora clusters.** The RDS create path builds a single-instance `rds.DatabaseInstance`. An `aurora-*` engine is offered `adopt` only: a cluster's writer/reader topology is not inferable from application code, and a one-instance cluster misrepresents what Aurora is for.
- **Resizing on re-plan.** Re-analysis reports drift between the manifest and a created datastore's current shape; it does not grow storage or change an instance class.
- **The `other` datastore kind.** It stays adopt-only. The skill cannot create a resource it could not identify.
- **Cross-account or shared datastores**, and **read replicas, global tables, or cross-region replication.**

## Decisions

### Created datastores live in the platform stack

They change rarely and they hold data; the service stack is redeployed on every push. The created security group also has to be reachable from the task security group, which is already a platform-stack construct — putting the datastore anywhere else would mean exporting a security group across stacks to write one ingress rule.

*Alternative considered:* a third "data" stack. Rejected — it adds a stack, a deploy order, and a second SSM contract to solve a problem the platform stack does not have. The platform/service split is by change frequency, and a database is on the platform side of that line.

### Discovery is one name-keyed lookup per datastore, never an enumeration

The analysis already found a specific name — a table name literal, a bucket name, the first label of an `*.rds.amazonaws.com` host. Discovery is a single `describe-*` on that name. A match is `adopt` with pre-filled identifiers and `validated: true`; a successful call that finds nothing offers `create` with `validated: true`; a call that could not run asks.

*Alternative considered:* list every RDS instance and DynamoDB table in the account and let the user pick. Rejected on three counts: an account can hold hundreds, so the picker is noise where a decision was available; a `describe-*` on a known name needs a narrow permission where `List*` needs a broad one; and the evidence-backed match is a better answer than a menu. Where the analysis found no name at all — a `DATABASE_URL` secret and nothing else — there is nothing to look up, so the entry asks rather than enumerating.

A denied or unreachable lookup is never read as absence. "There is no table" and "I could not check" call for opposite actions, and only one of them is safe to guess wrong.

### Create parameters go in `plan.resources[].parameters`, not in `identifiers`

`identifiers` means "what to import." The validator already rejects identifiers on a non-adopt entry (`createdResourcesCarryNoIdentifiers`), and that rule is worth keeping — it is what catches a half-finished session. So a created datastore's chosen shape gets its own mirror-image field: `parameters`, permitted only when `action` is `create`, with a new consistency check rejecting it on an `adopt` entry.

This keeps the manifest's existing separation intact: `analysis.datastores[]` holds what was read from the code, with evidence; `plan.resources[].parameters` holds what the user chose about a resource being created.

### What is derived, what is fixed, and what is asked

The rule: **anything carrying a standing monthly cost or a durability consequence is asked. Anything that is a shape with no cost is derived or fixed.**

| Value | Source |
| --- | --- |
| RDS engine, port | Derived from the driver dependency and ORM dialect |
| DynamoDB key schema, queried indexes | Derived from the code, and must be `high` or confirmed — see below |
| Environment variable names | Derived from the code that reads them |
| DynamoDB billing mode, PITR | Fixed: on-demand and PITR on. No capacity is inferable from static analysis, and the alternative to PITR is silent data loss |
| S3 encryption, public access, versioning | Fixed: SSE-S3, block all public access, versioned |
| SQS dead-letter queue | Fixed: a DLQ at 5 receives. A queue with no DLQ loses the messages it cannot process |
| RDS instance class, storage, multi-AZ, engine version | Asked, with a stated default |
| ElastiCache node type, replica count | Asked, with a stated default |
| DocumentDB instance class and count | Asked, with a stated default |

### A created DynamoDB table requires a confirmed key schema

A table's key schema is immutable. A table created with the wrong partition key is not adjustable — it is deleted and rebuilt, and by then it may hold data. Static analysis finds `GetItem({ Key: { pk: … } })` often and reliably identifies the attribute name rarely.

So the key schema is a finding like any other, and a `create` decision on a DynamoDB entry requires it at `high` confidence or `confirmedByUser`. There is no default. This is the one place in the datastore work where the plan refuses to complete on a shape the user did not look at.

### A created database's credentials reach the container through a stack-owned secret

The platform stack creates the database with `rds.Credentials.fromGeneratedSecret`, at a deterministic secret name derived from the app name and the datastore id. Because the platform stack owns both the secret and the execution role, it grants `secret.grantRead(executionRole)` directly — no ARN in the config, no wildcard grant.

The secret's ARN is published to SSM with the rest of the created attributes. The service stack imports it by that resolved ARN and injects the fields the manifest maps — `host`, `port`, `username`, `password`, `dbname` — as ECS secrets with `jsonField`.

*Alternative considered:* import by `Secret.fromSecretNameV2` on the deterministic name and skip SSM. Rejected: that yields a partial ARN, and `secretsmanager:GetSecretValue` on a partial ARN needs a trailing wildcard, which widens the execution role's grant from one secret to every secret sharing the prefix.

*Alternative considered:* inject the whole secret document as one variable and let the application parse it. Rejected: it only works for applications written to expect that shape.

### A URL-shaped connection variable is an incomplete plan, not a guess

`DATABASE_URL`, `REDIS_URL` and `MONGO_URI` are the common case, and a generated secret cannot satisfy any of them: the fields exist, the assembled URL does not, and composing one would mean reading the generated password. So each network datastore records a connection *style* — `fields` or `url` — as a finding.

`create` plus `url` is an incomplete plan. It reports the mismatch and names the two resolutions: supply an existing secret holding the URL (the adopt-secret path that already works), or accept the discrete variables and adapt the application. Generation does not proceed on the assumption that injecting five fields satisfies an application that reads one.

*Alternative considered:* a custom resource that reads the generated password and writes a URL-shaped secret. Rejected: it puts a Lambda function with read access to the database password into every stack that creates a database, to paper over a mismatch the plan can simply state.

### Created attributes arrive as SSM-sourced environment variables

`AppConfig.environment` is a static `Record<string, string>` and cannot carry a deploy-time value. It gains a companion — a map from environment variable name to published parameter suffix — which the service stack resolves the same way it already resolves the cluster name and the subnet ids.

*Alternative considered:* give created resources deterministic physical names so their names are synth-time literals. Rejected: deterministic physical names on stateful resources block replacement and collide across environments, which is exactly why the CDK warns against them. The generated ECS *service* name is deliberately deterministic, but a service is stateless and is addressed by name from an IAM statement and a pipeline step; a table is neither.

### Endpoint selection is computed after the datastore decisions, not before

A created database with a generated secret means the ECS agent fetches a secret it did not fetch before. On Fargate that fetch goes out through the task's own ENI, so an `egress: none` workload that previously needed no Secrets Manager endpoint now needs one. If the endpoint set is fixed before the create decisions are made, the result is a task that cannot start and an error naming Secrets Manager rather than the database.

So `vpc-endpoints` is derived after the datastore actions are settled, and the create decision feeds the required service set.

### Datastore kinds and the schema enum

`analysis.datastores[].kind` is corrected to `["rds", "dynamodb", "elasticache", "documentdb", "s3", "sqs", "sns", "other"]`. The config types and the projection already handle `documentdb`, `sqs` and `sns`; the schema rejects them, which means a repository using SQS cannot be recorded today even on the working adopt path. That is a live bug, fixed here because this change touches the same enum.

ElastiCache and DocumentDB creation uses L1 constructs (`elasticache.CfnReplicationGroup`, `CfnCacheCluster`) where no L2 exists. That is stated in the generated code rather than hidden, because an L1 resource has no `grant*` methods and its property names differ from every other construct in the stack.

### Created stateful resources are retained

Every created datastore carries `RemovalPolicy.RETAIN`, and RDS and DocumentDB carry deletion protection. The plan states it.

The asymmetry is total: a retained resource costs money and can be deleted by hand in a minute, while a destroyed one is gone. A stack deletion that silently drops production data would be the worst failure this tool could have.

## Risks / Trade-offs

- **A wrong DynamoDB partition key produces an immutable, unusable table.** → The key schema must be `high` confidence or explicitly confirmed before `create` is accepted. No default, at any confidence level.
- **`Secret.fromSecretCompleteArn` may reject an ARN that is an unresolved token.** → The fixture suite synthesizes a created-database manifest with no credentials, which is where this surfaces. If it rejects the token, the fallback is a `CfnTaskDefinition` `valueFrom` property override, which builds the same string without the import.
- **A created RDS instance turns the first platform deploy from a couple of minutes into tens.** → The plan states the expected duration alongside the existing note about a created certificate blocking on ACM. `RETAIN` also means a rolled-back first deploy leaves the instance behind, which the plan states too.
- **Discovery needs `describe-*` permissions the planning caller may not have.** → Each lookup is one narrow call, and a denied call is the "could not run" branch: it asks. No lookup failure is ever read as absence, and none of them is required for the run to proceed.
- **A created resource may collide with something the lookup missed** — a table outside the region checked, or a name that differs from the literal in the code. → Lookup-first narrows this, `RETAIN` bounds the damage, and a collision fails the deploy with `AlreadyExists` rather than mutating data.
- **Seven resource kinds in one change is a large surface.** → The branching is confined to two places: `buildDatastores` in the projection, and the create/adopt branch in the platform stack. Each kind is one construct plus one published parameter. The fixture suite covers create and adopt for each, and the ordering risk above (endpoints after decisions) is the only cross-kind interaction.
- **The manifest gains a second free-form object on plan entries.** → `parameters` is constrained per resource id in the schema where the identifiers already are, and a new consistency check rejects it on an `adopt` entry — the mirror of the rule that already rejects `identifiers` on a `create` entry.
- **Removing the adopt-only policy removes a guardrail that was doing real work.** → It is replaced by narrower ones rather than dropped: retention and deletion protection on by default, the deploy duration stated, the key schema confirmed, and discovery run first so `create` is only ever offered against an account confirmed not to have the resource.
