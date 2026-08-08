# Getting started

A walk-through of one application from invocation to a running service, using the
`examples/node-express` fixture.

## Before you begin

- Docker, for the build-validation step
- Node.js 20+ and AWS credentials for the target account
- A CDK-bootstrapped account and region (`npx cdk bootstrap`)

Note that the target region is asked for **explicitly** rather than inherited from
your environment. A CLI profile may not define one, and a silently-wrong region is
expensive to discover.

## 1. Install the skill

```bash
cp -r skills/ecs-truly-auto-mode ~/.claude/skills/
```

## 2. Ask for a deployment

From a repository with a Dockerfile:

> Deploy this to ECS.

## 3. Analysis

The skill reads the Dockerfile and the source, then builds the image to prove it
builds. For the `node-express` fixture it finds:

```
Port 8080          Dockerfile:14 (EXPOSE) and src/server.ts:22 (app.listen)
Health /health     src/server.ts:11, corroborated by test/health.test.ts:7
Architecture ARM64 Dockerfile:1 (--platform=linux/arm64)
Egress none        no outbound client; no third-party SDK in package.json
Datastores none
```

Everything here is corroborated by two independent signals, so it is **stated, not
asked**. Anything the analysis is less sure of becomes a question instead.

If `docker build` fails, the run stops here and reports the error. It will not edit
your Dockerfile.

## 4. The plan

```
## Plan: hello-api → 071128183726 / us-east-1

### Network egress: NONE — isolated subnets, no NAT gateway

  No outbound call leaves the VPC. Checked: HTTP clients, URL literals,
  third-party SDKs, and runtime package installs.

  This saves roughly $32/month versus a NAT gateway. Interface endpoints for
  ECR and CloudWatch Logs are created instead.

### Will be created (11)
  vpc, vpc-endpoints, cluster, ecr-repository, load-balancer, target-group,
  log-group, task-role, execution-role, security groups, github-oidc-role

### Will be skipped (3)
  nat-gateway     egress is none
  certificate     no public hostname recorded
  dns-record      no public hostname recorded
```

The egress decision leads because it is the one that costs money and the one least
likely to be noticed in a list. Nothing is generated until you approve.

## 5. Generated files

```
.ecs-auto-mode/manifest.yaml     every finding and decision
infra/bin/app.ts
infra/lib/config.ts
infra/lib/app-config.ts          the manifest, projected into typed values
infra/lib/platform-stack.ts      rarely changes
infra/lib/service-stack.ts       changes every deploy
infra/scripts/ssm-preflight.sh
.github/workflows/deploy.yml     path-filtered to what the build actually reads
```

## 6. Deploy the platform stack

By hand, once:

```bash
cd infra
npm ci
npx cdk deploy hello-api-platform
```

Nothing else works until this runs — it publishes the SSM parameters everything
downstream reads. You can confirm:

```bash
aws ssm get-parameters-by-path --path /ecs-auto-mode/hello-api --region us-east-1
./scripts/ssm-preflight.sh /ecs-auto-mode/hello-api us-east-1 --load-balanced
```

## 7. Push, and let the pipeline deploy

Push to `main`. The workflow assumes its OIDC role, builds the image, tags it with
the commit SHA, preflights the parameters, and deploys the service stack.

You should see the task definition revision increment and the targets go healthy:

```bash
aws elbv2 describe-target-health --target-group-arn "$(aws ssm get-parameter \
  --name /ecs-auto-mode/hello-api/target-group-arn --region us-east-1 \
  --query Parameter.Value --output text)" --region us-east-1
```

## What you'll notice

**`cdk synth` prints template-validation warnings** on the service stack — subnet
IDs and role ARNs "do not match expected format". These are false positives. The
linter evaluates each SSM parameter's *default*, which is the parameter path, while
CloudFormation resolves the real value at deploy time. `cfn-lint` reports zero
errors.

**The service stack has only two resources.** That is the point — see
[the two-stack model](./two-stack-model.md).

## Tearing down

```bash
npx cdk destroy hello-api-service
npx cdk destroy hello-api-platform
```

The ECR repository is **retained** on purpose, so a stack deletion does not throw
away your images. Delete it explicitly if you want it gone:

```bash
aws ecr delete-repository --repository-name hello-api --force --region us-east-1
```

One consequence worth knowing: if a first platform deploy fails and rolls back, the
retained repository blocks the retry with "already exists". Delete it and redeploy.
