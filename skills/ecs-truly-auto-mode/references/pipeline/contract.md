# Pipeline deployment contract

Both targets — GitHub Actions and CodePipeline — implement the same logical steps.
This document is the contract; each target's template is an implementation of it.

The reason for a shared contract rather than two independently-written pipelines is
the obvious failure mode of supporting both: they drift, and then a bug fixed in one
survives in the other. If a step changes, it changes here first.

## The steps

```
1. Trigger      push to <branch>, filtered to <pathFilter>
2. Authenticate short-lived credentials — no stored AWS keys
3. Build        docker build --platform <architecture>
4. Push         tag with the commit SHA, push to ECR
5. Preflight    assert every required SSM parameter exists
6. Deploy       service stack, ImageTag=<sha>
7. Wait         service reaches a steady state, or the deploy fails
```

### 1. Trigger

Push to the configured branch, filtered to `pipeline.pathFilter`. See
[path filters](#path-filters) below.

### 2. Authenticate

No long-lived AWS credentials are ever stored in the repository.

- **GitHub Actions** — OIDC. The workflow requests an ID token and assumes the role
  in `pipeline.roleArn`, whose trust policy is scoped to this repository.
- **CodePipeline** — the CodeBuild service role, already inside AWS.

### 3. Build

```
docker build --platform linux/<arch> -f <dockerfile> -t <repo>:<sha> <context>
```

`--platform` must match `analysis.architecture`. A mismatch produces a task that
fails to start with an exec-format error whose cause is not obvious from the message.

### 4. Push

Tag with the **full commit SHA**. Never `latest`, and never a mutable tag.

Two reasons, and the second is the one that bites:

- Rollback becomes redeploying a known tag.
- A mutable tag leaves the service stack's template byte-identical between deploys,
  so CloudFormation sees no change and **the rollout does not happen**. The pipeline
  reports success and the old code keeps running.

A `latest` tag may be pushed *additionally* for human convenience, but it is never
what gets deployed.

### 5. Preflight

Before deploying, assert every SSM parameter the service stack reads exists under
`target.ssmPrefix`. This is the guard against the one weakness of coupling the stacks
through SSM instead of CloudFormation exports: nothing stops the platform stack from
not having been deployed, or from having been changed underneath.

Required parameters:

```
<prefix>/cluster-name
<prefix>/vpc-id
<prefix>/subnet-ids
<prefix>/task-security-group-id
<prefix>/repository-uri
<prefix>/repository-arn
<prefix>/log-group-name
<prefix>/execution-role-arn
<prefix>/task-role-arn
<prefix>/target-group-arn          (only when the service is load-balanced)
```

Failing here names the missing parameter. Without this step the failure surfaces as
a CloudFormation error about an unresolvable SSM reference, which is considerably
harder to act on.

### 6. Deploy

Deploy **only** the service stack:

```
cdk deploy <app>-service --parameters ImageTag=<sha> --require-approval never
```

**The pipeline never runs projen**, under either infra style. It installs with
`npm ci` from the committed lockfile and calls `npx cdk` from `devDependencies` —
projen writes both, then stays out of the deploy path. A pipeline that regenerated
project files mid-deploy could change what it deploys, which is the opposite of what
a lockfile is for.

The platform stack is deliberately **not** deployed by this pipeline. It changes
rarely, its changes are worth a human looking at, and it contains the resources whose
accidental replacement would cause an outage. It is deployed by hand, or by a
separate pipeline the user sets up knowingly.

### 7. Wait

Wait for the ECS service to reach a steady state and fail the build if it does not.

A deploy that returns success while tasks are crash-looping is worse than a failed
deploy, because nobody looks at it. The service stack sets a deployment circuit
breaker with rollback, so a failed rollout reverts on its own — but the pipeline must
still surface it as a failure.

## Path filters

Derived from what the image build actually reads, never guessed:

- Every `COPY`/`ADD` source in the Dockerfile (excluding `--from=<stage>` copies)
- The Dockerfile itself
- Dependency manifests and lockfiles
- The service stack source, since changing it changes what gets deployed —
  `infra/lib/service-stack.ts`, or `infra/src/service-stack.ts` under
  [`infra.style: projen`](../generation/iac-style.md)
- `infra/.projenrc.ts`, under the projen style only: it pins the CDK version the
  service stack is synthesized with

Explicitly **not** included: the platform stack source. Changing it must not trigger
a service deploy, because this pipeline does not deploy the platform stack — a
trigger that runs a pipeline which ignores the change is worse than no trigger.

Bias toward **wider**. A pipeline that runs unnecessarily costs a few minutes. A
pipeline that fails to run when it should costs an incident, and does so silently.

## Equivalence

For a given commit, both targets must produce:

- the same image tag (the full commit SHA)
- the same image contents (same Dockerfile, context, and `--platform`)
- the same service stack change (`ImageTag` set to that SHA)

Anything else — log formatting, caching, notifications — is free to differ.

## Deploy permissions

The deploying principal is scoped to what these steps need and nothing more:

| Permission | Resource |
| --- | --- |
| `ecr:GetAuthorizationToken` | `*` (the API takes no resource) |
| `ecr:BatchCheckLayerAvailability`, `InitiateLayerUpload`, `UploadLayerPart`, `CompleteLayerUpload`, `PutImage`, `BatchGetImage` | the app's repository only |
| `ssm:GetParameter`, `GetParameters` | `<ssmPrefix>/*` only |
| `cloudformation:*` on the stack | `<app>-service/*` only — **not** the platform stack |
| `ecs:RegisterTaskDefinition`, `UpdateService`, `DescribeServices` | scoped to the cluster where possible |
| `iam:PassRole` | the task and execution roles only |

`iam:PassRole` is the one worth scoping carefully. Unscoped, it lets the pipeline
pass *any* role to ECS, which is an escalation path to whatever the most privileged
role in the account can do.

The platform stack is excluded from the CloudFormation permissions on purpose: the
pipeline has no reason to modify networking or IAM, and not granting it means a
compromised pipeline cannot.
