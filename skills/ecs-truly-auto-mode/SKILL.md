---
name: ecs-truly-auto-mode
description: Deploys a containerized application to AWS ECS/Fargate by analyzing the repository first. Use when a user wants to deploy, ship, or host a repo with a Dockerfile on ECS or Fargate, when they ask what AWS resources their containerized app needs, or when they want infrastructure and a CI/CD pipeline generated for a container. Analyzes the Dockerfile for ports and architecture, the source for health checks, external calls, datastores and secrets, then presents a create-or-adopt resource plan and generates a two-stack CDK app — either a plain CDK app or a projen AwsCdkTypeScriptApp — plus a GitHub Actions or CodePipeline pipeline. Not for EKS, Lambda, or non-container workloads.
---

# ECS truly auto mode

Take a repository with a Dockerfile and get it running on ECS — reading the code
first, showing what was inferred, and generating infrastructure the user owns.

## What makes this different from guessing

Two rules run through every phase:

1. **Every inference carries evidence and a confidence level.** Anything below high
   confidence becomes a question, not a default. Anything at high confidence is
   stated, not asked.
2. **Nothing is generated until the plan is approved.** The plan is where a wrong
   inference costs nothing to fix.

## Before starting

Check for `.ecs-auto-mode/manifest.yaml` in the target repository.

- **No manifest** → first run. Start at Phase 1.
- **Manifest exists** → resume. Read [replanning](./references/planning/replanning.md)
  and skip to the phase the recorded state calls for:
  - no approved plan → Phase 2
  - approved plan, no `generated` entries → Phase 3
  - complete → re-analyze and report the diff
- **`schemaVersion` unrecognized** → **stop.** Report the version found and the
  versions supported. Never reinterpret a manifest whose meaning may have changed.

Also confirm there is a Dockerfile. If there isn't, say what is needed and stop —
do not write one.

---

## Phase 1 — Analyze

Read [findings.md](./references/analysis/findings.md) first; it defines the record
format everything else produces.

Then, in order:

1. **Dockerfile** — [dockerfile.md](./references/analysis/dockerfile.md). Ports,
   architecture, build-context paths, entrypoint, build args.
2. **Identify the ecosystem** from the base image and dependency manifest, then read
   only that section of [ecosystems.md](./references/analysis/ecosystems.md).
3. **Inbound surface** — listener port, routes, health check. Tests corroborate.
4. **Outbound surface** — [egress.md](./references/analysis/egress.md). This is the
   highest-consequence output; work all four sources before concluding.
5. **Hostnames and DNS** — public candidates and service-discovery names.
6. **Datastores** — [datastores.md](./references/analysis/datastores.md).
7. **Config and secrets** — [secrets.md](./references/analysis/secrets.md).
8. **Validate the build**:

   ```
   docker build --platform linux/<arch> -f <dockerfile> -t ecs-auto-mode-validate:<name> <context>
   ```

   **On failure: report the error and stop.** Do not modify the Dockerfile, do not
   retry with different flags, do not continue to the plan. Infrastructure for an
   image that does not build is worthless, and the failure is the user's to fix.

Write findings to the manifest as you go.

---

## Phase 2 — Plan

Read [resource-catalog.md](./references/planning/resource-catalog.md) and
[plan-presentation.md](./references/planning/plan-presentation.md).

1. Derive the resource list from the findings.
2. Ask the two generation-shape questions **together** — neither depends on the
   analysis, so asking them separately spends two rounds on one decision point:
   - **Pipeline target** — GitHub Actions or CodePipeline. It adds resources to the plan.
   - **Infrastructure project style** — `plain` (default) or `projen`. See
     [iac-style.md](./references/generation/iac-style.md). Ask it; do not infer it
     from a projen file elsewhere in the repository.
3. Present the plan, ordered by consequence, with the egress classification and its
   evidence as the headline item.
4. Collect create-or-adopt for each entry, and identifiers for every adopted one.
   Validate them against AWS per
   [adopt-validation.md](./references/planning/adopt-validation.md) when credentials
   are available; record `validated: false` and say so when they are not.
5. Collect the target account and region **explicitly**. Do not inherit a region
   from the environment — a profile may not define one, and a silently-wrong region
   is expensive to discover.
6. Verify completeness, then ask for approval.

**The gate:** generation does not run unless `plan.approved` is `true` **and** every
`adopt` entry has non-empty identifiers **and** every finding is `high` or
`confirmedByUser`. Say exactly what is missing rather than proceeding partway.

---

## Phase 3 — Generate infrastructure

Read [manifest-schema.md](./references/manifest-schema.md) for what controls what.

The stacks are the same under either `infra.style`; only the scaffolding around them
differs. Read [iac-style.md](./references/generation/iac-style.md) for the layout, the
generation steps, and the file-ownership rules — then emit into the target repository:

```
infra/
  bin/app.ts              two stacks, platform and service   (projen: src/main.ts)
  lib/config.ts           the AppConfig types                 (projen: src/*)
  lib/app-config.ts       generated concrete values from the manifest
  lib/platform-stack.ts   rarely changes
  lib/service-stack.ts    changes every deploy
  lib/deploy-permissions.ts
  scripts/ssm-preflight.sh
  package.json  tsconfig.json  cdk.json    plain only — projen derives these
  .projenrc.ts                             projen only
```

Sources are in [`./assets/templates/cdk/`](./assets/templates/cdk/), inside this skill,
plus [`./assets/templates/cdk-projen/`](./assets/templates/cdk-projen/) for the projen
style. `app-config.ts` is the projection of the manifest; everything else is copied
as-is. The manifest JSON Schema is at
[`./assets/schemas/manifest.schema.json`](./assets/schemas/manifest.schema.json).

Then verify — **with no AWS credentials**. If it needs credentials, something is
using an environment lookup, and that is a bug to fix rather than to work around.

- `plain` → `npm ci && npx tsc --noEmit && npx cdk synth '**'`
- `projen` → `npx projen && npx projen build`

**Before writing any file**, run the overwrite check — see below.

---

## Phase 4 — Generate the pipeline

Read [contract.md](./references/pipeline/contract.md).

Derive the path filter from the build context, dependency manifests, lockfiles, and
the service stack source — never a guessed `src/**`. The platform stack source is
deliberately excluded. Under `infra.style: projen` the service stack lives at
`infra/src/service-stack.ts`, and `infra/.projenrc.ts` joins the filter because it
pins the CDK version the stack is synthesized with.

- **GitHub Actions** → `.github/workflows/deploy.yml` from
  [`./assets/templates/pipeline/github-actions/`](./assets/templates/pipeline/github-actions/).
  The platform stack template already instantiates the GitHub OIDC role itself,
  gated on the `githubActions` prop `bin/app.ts` passes when `pipeline.target` is
  `github-actions` — nothing to hand-wire here.
- **CodePipeline** → `CodePipelineTarget` added to the platform stack.

---

## Rules that apply throughout

### Escalation, not guessing

- Findings below `high` confidence become questions. Findings at `high` are stated.
- Conflicts are presented with **every** competing value and its evidence. Never
  prefer one source as a rule — a stale `EXPOSE` against a live `listen()` is
  exactly how conflicts usually arise, and the user knows which is current.
- **Batch questions per phase**, ordered by consequence. Asking one at a time across
  twenty resources is worse than a wrong default.
- Evidence is `file:line`, not prose. `app/payments.py:15` is checkable in seconds.

### Never read a secret's value

Record the variable name and a pointer to where the value lives. Read `.env.example`,
never `.env`. Learn variable names from the code that consumes them. A secret read
into context has leaked.

### Generated file ownership

Every generated file carries a header naming it as generated and the manifest
section that controls it. Before overwriting, hash the file on disk and compare to
the recorded `sha256`. **If it differs, show the difference and ask** — do not write.

Under `infra.style: projen` this applies to `.projenrc.ts` and `src/`, but **not** to
the files projen derives — `package.json`, `tsconfig.json`, `cdk.json`, `.gitignore`,
`.projen/`, `package-lock.json`. Those are never written or hashed by this skill;
hashing one would make every `npx projen` run look like a user edit.

Never modify application source or the Dockerfile.

### Bias in the egress decision

Wrongly `none` produces a service that cannot reach its dependencies, failing at
runtime for unobvious reasons. Wrongly `public` produces a line on a bill. When a
call genuinely cannot be classified, classify it `public` and say why — but do not
classify `public` on the mere possibility of an external call. "I found no external
calls" and "I couldn't tell" are different answers.

---

## Completion

Report:

1. **What was generated** — the file list.
2. **Deploy the platform stack first**, by hand:
   ```
   cd infra && npm ci && npx cdk deploy <app>-platform          # plain
   cd infra && npx projen && npx projen deploy:platform         # projen
   ```
   It publishes the SSM parameters the service stack reads, so nothing works before
   this runs. Under projen, use `deploy:platform` rather than projen's own `deploy`
   task, which would deploy the service stack too — that one belongs to the pipeline.
3. **The service stack is deployed by the pipeline**, on push to the configured
   branch. It is not deployed by hand and not deployed by the platform stack.
4. **What the user must do** — create secrets that don't exist yet, complete a
   CodeConnections handshake, point DNS.
5. **Adopted resources this depends on**, so a later change to one is understood to
   affect this service.
6. **Expected synth warnings.** `cdk synth` reports template-validation warnings on
   the service stack about subnet IDs and role ARNs "not matching expected format".
   These are false positives: the linter evaluates each SSM parameter's default,
   which is the parameter path, while CloudFormation resolves the real value at
   deploy time. An app that creates the GitHub OIDC provider adds one more — a
   `cfn-lint` W3005 about a redundant `DependsOn` — which comes from the CDK's own
   custom-resource framework and not from anything in the generated stack.

Say plainly that the generated app needs nothing from this skill to keep working.
