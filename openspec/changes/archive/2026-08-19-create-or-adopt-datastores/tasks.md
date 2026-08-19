## 1. Manifest schema

- [x] 1.1 In `schemas/manifest.schema.json`, correct `analysis.datastores[].kind` (line 123) to `["rds", "dynamodb", "elasticache", "documentdb", "s3", "sqs", "sns", "other"]` — the config types and the projection already handle `documentdb`, `sqs` and `sns`, so the current enum rejects manifests the working adopt path could otherwise generate from
- [x] 1.2 Add `analysis.datastores[].schema` for a table's key shape: `partitionKey` and optional `sortKey` as `{ name, type }` findings, and `indexes` as a list of `{ name, partitionKey, sortKey? }` — each carrying evidence and confidence like every other finding
- [x] 1.3 Add `analysis.datastores[].connection` for network-reached stores: `style` (`fields` | `url`) as a finding, and `variables` as a list of `{ name, field? }` naming the environment variables the application reads
- [x] 1.4 Add `analysis.datastores[].attributeVariables` for API-reached stores: a list of `{ name, attribute }` mapping an environment variable to the resource attribute it carries (`tableName`, `bucketName`, `queueUrl`, `topicArn`)
- [x] 1.5 Add `analysis.datastores[].nameFound` (boolean) so planning can tell "the analysis found a name to look up" from "there is nothing to look up", which are different branches of the discovery procedure
- [x] 1.6 Add `parameters` to the `plan.resources[]` item as the mirror of `identifiers`, with an `if action is create` shape and a comment stating why create parameters cannot live in `identifiers`
- [x] 1.7 Confirm `secretFinding` still forbids a value field and that none of the new fields can carry a credential value — the connection mapping names variables and fields only

## 2. Manifest validator

- [x] 2.1 In `scripts/validate-manifest.mjs`, add `createParametersOnlyOnCreate` — the mirror of the existing `createdResourcesCarryNoIdentifiers`, rejecting `parameters` on an `adopt` entry with a message saying the shape would be silently ignored
- [x] 2.2 Add `createdDatastoreParametersArePresent` — a datastore entry marked `create` whose kind needs asked parameters (instance class, node type) must carry them, and the message names which
- [x] 2.3 Add `createdTableHasConfirmedKeySchema` — a `create` decision on a DynamoDB entry requires `analysis.datastores[].schema.partitionKey` at `high` confidence or `confirmedByUser`, with a message stating that a table's key schema is immutable
- [x] 2.4 Add `createdDatabaseCredentialsAreResolvable` — a network-reached store marked `create` whose recorded `connection.style` is `url` and which has no adopted secret is an incomplete plan, and the message names both resolutions
- [x] 2.5 Add `unidentifiedDatastoreIsAdoptOnly` — a datastore of kind `other`, or a relational store whose engine is an Aurora engine, marked `create` is rejected with the reason
- [x] 2.6 Add `endpointSetCoversCreatedDatastores` — an `egress: none` plan that creates a database with generated credentials must include Secrets Manager in `analysis.egress.awsServices`, because on Fargate the credential fetch leaves through the task ENI

## 3. Config contract

- [x] 3.1 In `templates/cdk/lib/config.ts`, turn `NetworkDatastore` (line 74) into an `Adoptable` union: the `adopt` side keeps `securityGroupId`, `port` and `endpointAddress`; the `create` side carries engine, engine version, instance class, allocated storage, multi-AZ, node type and replica count as the kind requires
- [x] 3.2 Turn `ApiDatastore` (line 83) into an `Adoptable` union: the `adopt` side keeps `resourceArns`; the `create` side carries the table key schema and indexes, or the bucket, queue or topic shape, plus the `actions` both sides share
- [x] 3.3 Add a field alongside `environment` (line 161) mapping an environment variable name to the SSM parameter suffix that supplies its value, with a comment explaining that a created resource's physical id is a deploy-time value and `Record<string, string>` cannot carry one
- [x] 3.4 Add the created-database credential mapping type: variable name to secret field, plus the parameter suffix carrying the created secret's ARN
- [x] 3.5 Document on each type why a created stateful resource is retained, why the key schema is required before creation, and why a URL-shaped variable cannot be served by a generated secret — matching the comment density of the surrounding types

## 4. Platform stack: network-reached datastores

- [x] 4.1 In `templates/cdk/lib/platform-stack.ts`, split `wireNetworkDatastores` (line 284) into a create branch and an adopt branch, keeping the adopt branch byte-for-byte equivalent in behavior to what it does today
- [x] 4.2 In the create branch, define a security group owned by this stack and admit the task security group on the engine port, rather than importing and mutating one
- [x] 4.3 Create an `rds.DatabaseInstance` for the recorded engine, placed in the application subnets, with `removalPolicy: RETAIN` and deletion protection, and `credentials: rds.Credentials.fromGeneratedSecret` at a deterministic secret name derived from the app name and the datastore id
- [x] 4.4 Create the ElastiCache resource with `elasticache.CfnReplicationGroup` for Redis or `CfnCacheCluster` for Memcached, with a subnet group over the application subnets, and a comment saying why an L1 construct is used and that it has no `grant*` methods
- [x] 4.5 Create the DocumentDB cluster with `RETAIN` and deletion protection, and its own generated secret on the same deterministic-name rule
- [x] 4.6 Grant the execution role read access to each created credentials secret directly — the stack owns both, so no ARN comes from the config and no wildcard grant is written
- [x] 4.7 Confirm no `fromLookup` or otherwise context-dependent call was introduced on either branch, so synth stays hermetic

## 5. Platform stack: API-reached datastores

- [x] 5.1 Split the `apiDatastores` loop in `buildTaskRole` (line 359) so a created resource is constructed and granted against its own ARN, while an adopted one keeps granting against the recorded ARNs unchanged
- [x] 5.2 Create the DynamoDB table from the recorded key schema and queried indexes, on-demand billing, point-in-time recovery on, `RETAIN`
- [x] 5.3 Create the S3 bucket with SSE-S3, block all public access, versioning on, `RETAIN`
- [x] 5.4 Create the SQS queue with a dead-letter queue at 5 receives, and the SNS topic, both `RETAIN`
- [x] 5.5 Grant the task role exactly the recorded `iamActions` on each created resource, scoped to its ARN and — for a table with indexes — that table's index ARNs, never a wildcard resource

## 6. Platform stack: publishing

- [x] 6.1 Extend `publishParameters` to write a parameter for each created datastore attribute the container needs: endpoint address and port, table name, bucket name, queue URL, topic ARN
- [x] 6.2 Publish the ARN of each created credentials secret
- [x] 6.3 Confirm nothing is published for an adopted datastore that the service stack does not read, so the parameter set stays a contract rather than a dump

## 7. Service stack

- [x] 7.1 In `templates/cdk/lib/service-stack.ts`, resolve the SSM-sourced environment variables from the published parameters and merge them with the static `environment`, with a collision between the two treated as an error rather than a silent overwrite
- [x] 7.2 Extend `buildSecrets` to inject a created database's credential variables from the stack-owned secret's JSON fields, importing the secret by the ARN resolved from SSM
- [x] 7.3 Verify at synth that `secretsmanager.Secret.fromSecretCompleteArn` accepts an unresolved token ARN; if it rejects it, fall back to a `CfnTaskDefinition` `valueFrom` property override that builds the same string, and record which path was taken in a comment
- [x] 7.4 Confirm the service stack still contains no datastore, security group, or secret resource — only the task definition and the service
- [x] 7.5 Confirm no credential value appears anywhere in the synthesized service-stack template

## 8. Entry points and style equivalence

- [x] 8.1 Confirm `templates/cdk/bin/app.ts` and `templates/cdk-projen/src/main.ts` need no change — datastores travel in `AppConfig`, not through a stack prop — and record that finding rather than editing them speculatively
- [x] 8.2 Run `scripts/verify-styles.mjs` and confirm the plain and projen sources stay identical apart from import paths
- [x] 8.3 Confirm `scripts/derive-path-filter.mjs` needs no change — the datastore work adds no new source file to the service-stack side of the filter

## 9. Manifest projection

- [x] 9.1 In `scripts/generate-config.mjs`, rewrite `buildDatastores` so the network-reached branch emits `{ mode: 'create', ... }` from the plan entry's `parameters` instead of `continue`-ing at line 142
- [x] 9.2 Rewrite the API-reached branch so a `create` entry emits the created shape instead of `continue`-ing at line 161 for want of an ARN
- [x] 9.3 Replace every silent `continue` in that function with a `fail()` naming the entry and what is missing, so an incomplete datastore stops generation rather than producing an application that omits it
- [x] 9.4 Emit the SSM-sourced environment variable map from `analysis.datastores[].attributeVariables` for created resources, and confirm an adopted resource's variables continue to come through the static `environment`
- [x] 9.5 Emit the created-database credential mapping from `analysis.datastores[].connection.variables`, and fail with the two named resolutions when `connection.style` is `url` and no adopted secret covers it
- [x] 9.6 Confirm a manifest with every datastore marked `adopt` projects exactly the same `app-config.ts` it does today

## 10. Analysis behavior

- [x] 10.1 In `skills/ecs-truly-auto-mode/references/analysis/datastores.md`, replace the "the skill does not create databases … do not offer to create one" guidance under RDS with what to record so a create decision is possible, keeping the adopt identifiers
- [x] 10.2 Add a section on the connection-variable style: how to tell discrete fields from a single URL, and why the distinction decides whether a created database is usable
- [x] 10.3 Add to the DynamoDB section what a create decision needs — partition key, sort key, types, queried indexes — and that an unconfirmed key schema blocks creation because the schema is immutable
- [x] 10.4 State in the recording section that a datastore with no discoverable name is recorded as such, because planning branches on it
- [x] 10.5 Update the ElastiCache, DocumentDB, S3, SQS and SNS sections with the attributes a create decision needs, and keep the MongoDB-Atlas-forces-public-egress warning intact

## 11. Planning behavior

- [x] 11.1 In `skills/ecs-truly-auto-mode/references/planning/adopt-validation.md`, turn the RDS, S3 and DynamoDB checks into the discovery-then-decide procedure: one name-keyed lookup, a match records `adopt` with pre-filled identifiers and `validated: true`, a successful miss offers `create` with `validated: true`
- [x] 11.2 State in that procedure that a lookup which could not run — no credentials, or the describe call denied — falls through to a question and is never read as absence, in the same terms the GitHub OIDC provider procedure uses
- [x] 11.3 Add the equivalent lookups for ElastiCache, DocumentDB, SQS and SNS
- [x] 11.4 State that discovery is one lookup per recorded name and never an enumeration of the account, and why
- [x] 11.5 In `skills/ecs-truly-auto-mode/references/planning/resource-catalog.md`, rewrite the `database` and `cache` entries to state both actions, the adopt identifiers, the create parameters and which of them are asked versus derived, the retained-on-delete behavior, and the tens-of-minutes first deploy
- [x] 11.6 Rewrite the bucket, table, queue and topic entries with their create parameters and fixed defaults, replacing "`create` is offered when the analysis found a name that resolves to nothing" with what actually happens
- [x] 11.7 Add the Aurora-engine and kind-`other` adopt-only exceptions, and remove `database` and `cache` from the adopt-only list in the "Deriving the plan" steps
- [x] 11.8 Change step 6 of "Deriving the plan" so `vpc-endpoints` is derived **after** the datastore decisions, and state the created-database-needs-a-secrets-endpoint case that forces the ordering
- [x] 11.9 In `skills/ecs-truly-auto-mode/references/planning/plan-presentation.md`, add how a created datastore is presented: its parameters, its retention, and its effect on first-deploy duration
- [x] 11.10 In `skills/ecs-truly-auto-mode/references/planning/replanning.md`, state that drift between a created datastore's recorded shape and its current shape is reported, not corrected
- [x] 11.11 In `skills/ecs-truly-auto-mode/references/manifest-schema.md`, document the new analysis fields, the `parameters` plan field, and the identifiers for each datastore kind

## 12. Skill entry point

- [x] 12.1 In `skills/ecs-truly-auto-mode/SKILL.md`, add the datastore discovery step to Phase 2 so the lookups run before the create-or-adopt questions
- [x] 12.2 Add to the Completion report that a created database is **empty** — schema migrations are the user's, and the pipeline does not run them
- [x] 12.3 Add to the Completion report that created datastores are retained on stack deletion, so the user knows what a teardown leaves behind

## 13. Documentation

- [x] 13.1 In `docs/adopting-resources.md`, remove databases and caches from "Resources that can only be adopted", replace that bullet with what the create path does and what it retains, and keep hosted zones and CodeConnections with their reasons intact
- [x] 13.2 Add the datastore discovery behavior to the same document, alongside the OIDC provider section it mirrors
- [x] 13.3 Extend the adopt-identifier table with `documentdb`, queue and topic entries
- [x] 13.4 In `docs/known-limits.md`, remove "Creating databases, caches, hosted zones, or secrets" and replace it with the narrower limits that remain: Aurora clusters, schema migrations, resizing on re-plan, and a datastore the analysis could not identify
- [x] 13.5 Add the URL-shaped-connection-variable limitation to `docs/known-limits.md`, since it is the one case where a create decision cannot complete on its own

## 14. Fixtures

- [x] 14.1 Add a fixture manifest creating a relational database whose application reads discrete connection fields, and assert in `scripts/verify-fixtures.mjs` that the synthesized platform stack contains the instance, its security group rule, and its secret, and that the service stack injects the fields
- [x] 14.2 Add a fixture manifest creating a DynamoDB table with a confirmed key schema, and assert the table, the scoped task-role statement, and the SSM-sourced environment variable naming it
- [x] 14.3 Add a negative fixture: a created database against an application reading `DATABASE_URL`, asserting that the validator reports an incomplete plan naming both resolutions
- [x] 14.4 Add a negative fixture: a created DynamoDB table with an unconfirmed key schema, asserting the validator rejects it
- [x] 14.5 Add a fixture asserting that an `egress: none` plan creating a database includes the Secrets Manager endpoint
- [x] 14.6 Update `examples/python-fastapi/expected-manifest.yaml` to record the new datastore fields for its adopted RDS instance and bucket, and confirm it still validates and still projects the same infrastructure
- [x] 14.7 Add a fixture asserting that an all-adopt manifest synthesizes to the same template it did before this change

## 15. Verification

- [x] 15.1 Run `node scripts/validate-manifest.mjs` over every fixture and example manifest and confirm the positive ones pass and the negative ones fail with the intended message
- [x] 15.2 Run `node scripts/verify-fixtures.mjs` and confirm every synth succeeds **with no AWS credentials present**
- [x] 15.3 Run `node scripts/verify-styles.mjs`, `node scripts/verify-pipeline-equivalence.mjs`, and `node scripts/check-generated.mjs`
- [x] 15.4 Run `npx projen build` at the repository root and confirm the full check suite passes
- [x] 15.5 Confirm the generated `plain` and `projen` projects both type-check and synth both stacks with a created database in the plan, with no credentials
