# Known limits

What this tool does not do, and the ways it can be wrong. Most of these are
deliberate; all of them are worth knowing before you rely on the output.

## The analysis can be wrong

Analysis is a model reading source code, not a parser. It is systematic — the
ecosystem checklists exist to make coverage repeatable rather than whatever caught
the eye — but it is not exhaustive, and it is not perfectly deterministic between
runs. That is why every finding carries evidence and a confidence level, and why the
plan exists: it is the moment a wrong inference costs nothing.

### A missed external call

**Symptom:** the service is placed in isolated subnets, deploys successfully, and
then cannot reach a dependency. Failure is at runtime, often intermittent, and the
cause is unobvious.

**Why it happens:** the endpoint is inside a third-party SDK rather than in a visible
URL, or a runtime `npm install` in an entrypoint script.

**Mitigation:** the plan states the egress classification and its evidence as its
headline item, and says what was checked. When a call genuinely cannot be classified
it is classified `public` — the two errors are not symmetric, since being wrongly
`public` costs a line on a bill and being wrongly `none` costs an outage. Switching
is a one-field manifest change, and the private-subnet path is already wired.

### A missed datastore

**Symptom:** the task role lacks a permission, or the security group blocks a
connection. This one at least fails loudly, at startup.

**Why it happens:** data access is behind an internal API the analysis didn't
recognize, or a driver is a transitive dependency that doesn't look load-bearing.

**Mitigation:** detected datastores are listed for explicit confirmation, always with
an "I use one that isn't listed" option. An app with no detected datastore is
reported as *appearing* stateless and asked about — silence is not confirmation.

### A created database whose app reads a single connection URL

**Symptom:** the plan reports the datastore entry as incomplete and refuses to finish.

**Why it happens:** a created database's credentials are generated, and a generated secret
holds `host`, `port`, `username`, `password` and `dbname` as separate fields. It cannot
hold an assembled `DATABASE_URL`, and composing one would mean reading the password to
build it. `DATABASE_URL` is the common shape, so this comes up on most first runs against
a database that does not exist yet.

**Mitigation:** this one is deliberately not mitigated — it is surfaced. The plan names
both resolutions: supply an existing secret holding the URL (the database is still
created), or switch the application to the discrete variables. It will not inject five
variables an application that reads one will never look at, and it will not fall back to
adopt-only.

### An unrecognized ecosystem

Node, Python, Go, Java and Ruby have checklists. Anything else falls back to a
general procedure with every confidence level lowered by one. The skill says plainly
that it could not determine things reliably rather than producing a confident wrong
answer.

Spring's relaxed binding is a genuine blind spot even within the supported set:
`SPRING_DATASOURCE_URL` maps to `spring.datasource.url` without appearing literally
anywhere in the repository.

## Scope

Not covered, and not planned:

- **EKS, Lambda, and non-container workloads.**
- **Multi-region, multi-account, or multi-environment topologies.** One account and
  region per manifest.
- **More than one service per repository.** A repo with a web process *and* a worker
  (Sidekiq, Celery, an SQS consumer) needs two task definitions. The skill flags this
  and asks rather than silently deploying only the web process.
- **Fixing a Dockerfile that doesn't build.** The run stops and reports.
- **Creating hosted zones or secrets, and Aurora clusters.** Adopt-only, for reasons in
  [adopting resources](./adopting-resources.md). Databases, caches, tables, buckets,
  queues and topics *can* be created — with the limits below.
- **Schema migrations.** A created database comes up empty. The skill does not generate a
  migration step and the pipeline does not run one, so a repository with a `migrations/`
  directory still needs that wired up. This is the gap between a deploy that succeeds and
  an application that works.
- **Resizing a created datastore on a re-run.** Re-planning *reports* drift between the
  recorded parameters and the live resource; it does not correct it. A stateful resource
  somebody deliberately resized is not drift to reconcile, and silently reverting a
  production instance class would be worse than a stale parameter.
- **A datastore the analysis could not identify.** Recorded as kind `other` and
  adopt-only — the skill cannot create what it cannot name.
- **`--target` multi-stage builds.** The final stage is assumed to be the last
  `FROM`.
- **Converting a generated app between project styles.** Choosing `projen` on a
  repository that already has a plain `infra/` writes the projen layout; it does not
  move or delete what is there. The overwrite check guards the existing files, and
  the leftovers are yours to remove. There is no in-place conversion, in either
  direction.
- **Any project style beyond `plain` and `projen`.** CDK Pipelines-managed projects,
  Python CDK, and monorepo-nested layouts are not generated.

## Generating the projen style needs a network

`projen` is bootstrapped with `npx projen@latest new`, so that style — and only that
style — requires network access at generation time. In an offline environment the run
fails at the bootstrap step rather than silently falling back to `plain`, because a
silent fallback would generate a project the user did not pick.

Two related notes:

- Projen's own generated output changes between projen versions. The skill pins the
  CDK version but not projen itself, and owns nothing projen writes, so an upgrade
  cannot collide with the overwrite check — but it can change `infra/package.json`
  and friends underneath you. That is projen's contract.
- The bootstrap exits non-zero on a fresh project (it lints an empty `src/`). That is
  expected and documented; the project files are written regardless.

## Manifest drift

The manifest records what was true when it was written. Reality can move underneath
it — a resource deleted, a security group changed, a parameter removed.

- The pipeline's **SSM preflight** catches the platform-stack case at deploy time,
  naming the missing parameter before anything changes.
- **Adopted identifiers are re-validated** when they change, or when validation
  previously failed. They are not re-checked on every run, so a resource deleted
  after validation will not be noticed until deploy.

## Operational notes

**The ECR repository is retained on stack deletion.** Deliberate — losing every image
because a stack was deleted is worse than an orphaned repository. The consequence:
if a first platform deploy fails and rolls back, the retained repository blocks the
retry with "already exists". Delete it and redeploy.

**Container Insights is not enabled.** It is useful and it bills per metric; this
tool does not turn on standing costs nobody asked for. Enable it explicitly.

**`cdk synth` emits template-validation warnings** on the service stack about subnet
IDs and role ARNs not matching expected formats. False positives — the linter reads
each SSM parameter's default (the path) rather than the deploy-time value. There is
no per-rule suppression, so they are documented rather than hidden. `cfn-lint`
reports zero errors; `W2001` on the unused `vpc-id` parameter is expected, since
`FargateService` requires a VPC object at synth time that contributes nothing to the
template.

**An adopted load balancer's egress rule cannot be added for you.** Imported security
groups are immutable in CDK. The stack warns at synth time with the group and port.
Skipping it produces tasks that start, log that they are listening, fail every health
check, and are killed with exit code 137 — a symptom that looks like an application
bug and is not.

## Security posture

- Secret **values** are never read or recorded. Only names and pointers.
- Task roles get exact resource ARNs, never wildcards — for created resources as well as
  adopted ones. If the resources can't be determined, the plan asks instead of
  over-granting.
- A created database's credentials are generated in Secrets Manager and never pass
  through a template. The stack that owns the secret grants the execution role read on
  **that secret alone**, so no wildcard grant is written and no ARN has to be supplied.
- The GitHub OIDC trust policy is scoped to `repo:<owner>/<repo>:*`. Without that
  condition it could be assumed from any repository on GitHub — an account
  compromise, not a misconfiguration.
- The pipeline's deploy role cannot touch the platform stack, so a compromised
  pipeline cannot modify networking or IAM.
- `iam:PassRole` is scoped to the task and execution roles, with a
  `PassedToService` condition.
