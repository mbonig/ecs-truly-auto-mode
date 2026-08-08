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
- **Creating databases, caches, hosted zones, or secrets.** All adopt-only, for
  reasons in [adopting resources](./adopting-resources.md).
- **`--target` multi-stage builds.** The final stage is assumed to be the last
  `FROM`.

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
- Task roles get exact resource ARNs, never wildcards. If the resources can't be
  determined, the plan asks instead of over-granting.
- The GitHub OIDC trust policy is scoped to `repo:<owner>/<repo>:*`. Without that
  condition it could be assumed from any repository on GitHub — an account
  compromise, not a misconfiguration.
- The pipeline's deploy role cannot touch the platform stack, so a compromised
  pipeline cannot modify networking or IAM.
- `iam:PassRole` is scoped to the task and execution roles, with a
  `PassedToService` condition.
