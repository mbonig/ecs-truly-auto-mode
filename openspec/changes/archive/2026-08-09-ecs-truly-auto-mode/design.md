## Context

The repository is empty. Everything described here is greenfield, so the design is free to pick its own shape, and the main constraint is the delivery vehicle: a Claude Code skill. That means the "program" is a set of instructions an agent follows, not a compiled binary — control flow is prose, state lives in files, and every inference is made by a model reading source code rather than by a parser.

That has two consequences the design has to take seriously. First, analysis is inherently probabilistic, so the output must carry evidence and be reviewable rather than presented as fact. Second, the skill must be *resumable* — an agent session can end at any point, and re-running the skill on a repo that already has generated infrastructure must be an incremental update, not a from-scratch regeneration that clobbers user edits.

The generated artifacts land in someone else's repository and are theirs to own and edit afterward. The skill is a generator, not a runtime dependency: nothing it emits should require the skill to be present again.

Confirmed with the user up front: skill/plugin form, CDK TypeScript output, both GitHub Actions and CodePipeline supported with the target chosen per-run, and an interactive adopt-or-create plan.

## Goals / Non-Goals

**Goals:**

- Take a repo with a Dockerfile and produce a working ECS deployment with no AWS knowledge required from the user beyond answering questions about resources they already own.
- Make every inference visible and attributable to evidence in the repo, so a user can correct a wrong guess before any infrastructure exists.
- Split infrastructure by change cadence so routine deploys touch a small stack containing only the task definition and service.
- Generate CDK the user can read, edit, and continue to own after the skill is gone.
- Be idempotent and resumable: re-running updates the plan and regenerates only what changed.

**Non-Goals:**

- Fixing an app that doesn't containerize. If `docker build` fails, the skill reports and stops; it does not rewrite the Dockerfile or the app.
- Multi-region, multi-account, or multi-environment topologies beyond a single account/region target per manifest.
- EKS, Lambda, or non-container compute.
- Managing the lifecycle of adopted resources. If the user points at an existing RDS instance, the skill wires connectivity and never touches the database.
- Being a deployment runtime. The skill generates the pipeline; the pipeline deploys.

## Decisions

### 1. The manifest is the single source of truth, not the generated code

All analysis findings and all user decisions are written to a versioned manifest (`.ecs-auto-mode/manifest.yaml`) in the target repo. Generation is a pure function of the manifest. Re-running the skill re-analyzes, diffs against the manifest, and asks only about what changed.

*Why:* Without this, resumability means re-reading generated CDK to recover intent, which is lossy and fragile. It also gives the user one reviewable file that captures every decision, and makes the analysis and generation phases independently testable.

*Alternative considered:* Treating the generated CDK as the state. Rejected — user edits to the CDK would be indistinguishable from skill-authored content, so a re-run could not safely regenerate anything.

### 2. Findings carry evidence and a confidence level; low confidence escalates rather than defaults

Every finding records what was inferred, the file and line that support it, and a confidence level. High-confidence findings are presented as defaults in the plan. Low-confidence and conflicting findings become explicit questions to the user. There is no silent fallback.

*Why:* A wrong port or a missed database becomes a broken deploy or, worse, a security group opened wider than it needed to be. Making the model show its work turns a guess into a reviewable claim.

*Trade-off:* More questions in the interactive phase. Mitigated by only escalating what's genuinely ambiguous — a single `EXPOSE 8080` with a matching listener bind is not a question.

### 3. Two stacks, coupled through SSM Parameter Store rather than CloudFormation exports

The platform stack writes its outputs (VPC ID, subnet IDs, cluster ARN, ECR repository URI, target group ARN, security group IDs, role ARNs, log group name) to SSM parameters under a manifest-defined path prefix. The service stack reads them.

*Why:* CloudFormation `Export`/`ImportValue` creates a hard dependency lock — the platform stack cannot change or remove an exported value while the service stack imports it, which is exactly the wrong coupling for a "rarely changes" stack under a "changes constantly" stack. CDK's native cross-stack references produce the same exports. SSM parameters decouple the two deploy cadences completely and let the service stack deploy in a pipeline that has never synthesized the platform stack.

*Alternative considered:* A single stack with the service nested. Rejected outright — it makes every routine deploy a full-stack update and puts the VPC in the blast radius of a task definition change.

*Trade-off:* SSM reads are looser than exports — nothing stops the platform stack from deleting a parameter the service stack needs. Mitigated by a preflight step in the service pipeline that asserts every expected parameter exists before deploying.

### 4. Adopted resources are imported by explicit attributes from the manifest, never by `fromLookup`

When the user supplies an existing VPC or subnet, the generated CDK uses `Vpc.fromVpcAttributes` (and equivalents) with values recorded in the manifest, not `Vpc.fromLookup`.

*Why:* `fromLookup` requires AWS credentials at synth time and writes `cdk.context.json`, which makes synthesis environment-dependent and a frequent source of "works on my machine" failures in CI. Explicit attributes make `cdk synth` a hermetic, offline, deterministic operation — which the pipeline design depends on.

*Trade-off:* The skill must collect more information from the user (subnet IDs and AZs, not just a VPC ID). Acceptable: the interactive plan phase can query AWS on the user's behalf to fill these in once, then record them.

### 5. Image tags are immutable content identifiers passed as a CloudFormation parameter

The service stack takes an `ImageTag` parameter. The pipeline builds, tags with the commit SHA, pushes, and deploys the service stack with that tag. `latest` is never used for deployment.

*Why:* A mutable tag makes the service stack's template identical between deploys, so CloudFormation sees no change and the rollout doesn't happen — or it happens non-deterministically on task replacement. It also makes rollback a matter of redeploying a known tag.

### 6. Egress classification drives subnet placement, and the default is the cheaper one

If the outbound scan finds no calls to endpoints outside the VPC, the service is placed in isolated subnets with VPC interface endpoints for the AWS services it actually uses (ECR, ECR Docker, CloudWatch Logs, Secrets Manager, and so on) and no NAT gateway. If genuine external egress is found, private subnets with NAT are used, and the plan states which finding forced that.

*Why:* A NAT gateway is a standing hourly cost plus data processing charges, and it's the single most common piece of accidental spend in a small ECS setup. Making the choice a *derived, justified* decision rather than a default is the most concretely useful thing the analysis produces.

*Risk:* A missed external call means a service that can't reach a dependency at runtime. Mitigated by surfacing the classification prominently in the plan with the evidence behind it, and by making the isolated-to-private switch a one-line manifest change.

### 7. Pipeline targets share one deployment contract

Both the GitHub Actions and CodePipeline generators emit the same logical steps — path-filtered trigger, build, push to ECR with the SHA tag, preflight the SSM parameters, deploy the service stack — differing only in the mechanics of each. The steps and their contract live in a shared reference document; each target's template implements it.

*Why:* Two independently-drifting pipeline definitions is the obvious failure mode of supporting both. One contract keeps them behaviorally equivalent and makes it cheap to add a third target later.

### 8. Path filters are computed from the build context, not hardcoded

The trigger's path filter is derived from what the Dockerfile's build context actually reads — `COPY`/`ADD` sources, plus the Dockerfile itself and any lockfiles — rather than a guessed `src/**`.

*Why:* A path filter that's too narrow silently skips deploys when a shared dependency changes, which is a genuinely nasty class of bug because the pipeline reports success by staying quiet.

### 9. Secrets are referenced, never read

When the configuration scan finds a value that looks like a credential, the skill records the *name* and asks the user for the Secrets Manager ARN or SSM parameter name. Generated task definitions use `secrets:` (injected by the execution role at task start), not `environment:`. The skill never reads a secret value, and never writes one to the manifest.

*Why:* Plaintext secrets in a task definition are visible to anyone with `ecs:DescribeTaskDefinition`, and a secret value pulled into an agent's context is a secret that has leaked.

### 10. Analysis is language-agnostic prose plus per-ecosystem checklists

Rather than writing parsers, the skill's analysis instructions describe *what* to look for, backed by reference documents that give concrete signals per ecosystem (Node/Express/Fastify, Python/Flask/FastAPI/Django, Go, Java/Spring, Ruby/Rails) — framework listener calls, ORM config file locations, SDK import names, common env var conventions.

*Why:* Static analysis that actually covers five ecosystems is most of the project. The model already reads all of them; the checklists exist to make its coverage systematic rather than whatever it happened to notice, and to be extended without touching the skill's control flow.

*Trade-off:* Non-determinism across runs. Bounded by the manifest — once a finding is recorded and confirmed, later runs diff against it rather than re-deriving from scratch.

### 11. Reference documents are loaded on demand

`SKILL.md` holds the phase flow and decision points only. Ecosystem checklists, the CDK stack templates, the pipeline contract, and the manifest schema live in `references/` and are read when the relevant phase begins.

*Why:* The full body of material is far too large to sit in context for every invocation, and most of it is irrelevant to any given repo — a Go service never needs the Rails checklist.

## Risks / Trade-offs

- **A missed external service call puts the service in isolated subnets and it fails at runtime** → The plan states the egress classification and the evidence for it as a headline item, not a footnote. Switching to NAT is a single manifest field, and the generated CDK includes the private-subnet path already wired but inactive.
- **Analysis misses a datastore, so the task role lacks permissions or the security group blocks the connection** → Datastore findings are presented as an explicit list requiring user confirmation, with an "add one I use that isn't listed" path. Failures here are loud (connection refused at startup) rather than silent.
- **The user edits generated CDK, then re-runs the skill and loses their changes** → Generation writes only to files it owns, marked with a header identifying them as generated and naming the manifest field that controls them. Before overwriting, the skill diffs against the last-generated content recorded in the manifest and stops to ask if the file has diverged.
- **The manifest drifts from real AWS state** (a resource was deleted or changed outside the tool) → The pipeline's SSM preflight catches the platform-stack case at deploy time. For adopted resources, the plan phase re-validates identifiers against AWS when credentials are available and flags anything that no longer resolves.
- **Supporting two pipeline targets doubles the maintenance surface** → Mitigated by the shared contract (Decision 7), and accepted deliberately: the user asked for both.
- **CDK API churn breaks generated code against newer CDK versions** → Generated apps pin a CDK version in `package.json`. The stack templates favor stable L2 constructs over anything experimental.
- **`docker build` may need credentials, private registries, or a specific platform** → The skill attempts a build to validate, and on failure reports the error and stops rather than guessing at fixes. Architecture (`arm64` vs `x86_64`) is read from the Dockerfile or asked, since it must match the Fargate runtime platform.
- **Interactive Q&A can become long enough that users stop reading** → Questions are batched per phase and ordered by consequence, and anything the analysis is confident about is stated as a default rather than asked.
