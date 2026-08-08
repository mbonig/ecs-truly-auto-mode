# The two-stack model

The generated CDK app has exactly two stacks, split by **how often they change**
rather than by what kind of resource they hold.

| | Platform stack | Service stack |
| --- | --- | --- |
| Contains | VPC, cluster, ECR, load balancer, target group, roles, log group, DNS | Task definition and ECS service |
| Changes | Rarely — when infrastructure changes | Every deploy |
| Deployed by | A human, by hand | The pipeline |
| Blast radius | The whole application | One rollout, with automatic rollback |

The split exists because a routine code deploy should not put the VPC in its blast
radius. If both lived in one stack, every commit would produce a changeset touching
networking and IAM, and a bad template would take out more than the rollout.

## Why SSM instead of CloudFormation exports

The obvious way to pass values between stacks is `Export` / `Fn::ImportValue`, which
is also what CDK's native cross-stack references generate. This design deliberately
does not use them.

**`Fn::ImportValue` creates a lock in the wrong direction.** While the service stack
imports a value, the platform stack cannot change or remove it. That means the
rarely-changing stack becomes hostage to the constantly-changing one — exactly
backwards from what you want. Renaming a resource in the platform stack would require
first deleting the service stack.

Instead, the platform stack writes its outputs to SSM parameters:

```
/ecs-auto-mode/<app>/cluster-name
/ecs-auto-mode/<app>/subnet-ids
/ecs-auto-mode/<app>/task-security-group-id
/ecs-auto-mode/<app>/repository-uri
/ecs-auto-mode/<app>/repository-arn
/ecs-auto-mode/<app>/log-group-name
/ecs-auto-mode/<app>/execution-role-arn
/ecs-auto-mode/<app>/task-role-arn
/ecs-auto-mode/<app>/target-group-arn
```

and the service stack reads them as `AWS::SSM::Parameter::Value<String>` parameters,
resolved by CloudFormation at deploy time.

Three things follow from this:

- The two stacks deploy on **completely independent cadences**.
- The service stack can be deployed by a pipeline that has **never synthesized the
  platform stack** — it needs no knowledge of it beyond the parameter path.
- The synthesized service stack contains **zero `Fn::ImportValue`**, so there is no
  dependency for CloudFormation to enforce.

### The cost of that decoupling

The looseness cuts both ways: nothing stops the service stack from being deployed
against a platform stack that was never deployed. That is what the pipeline's
**preflight step** is for — it asserts every required parameter exists and fails
naming the missing one, before anything has changed.

Without it the failure still happens, just later and less legibly, as a
CloudFormation error about an unresolvable SSM reference partway through a deploy.

## Deploying

**Platform stack — by hand, first:**

```bash
cd infra
npm ci
npx cdk deploy <app>-platform
```

Nothing else works until this has run, because it publishes the parameters
everything downstream reads.

**Service stack — by the pipeline:**

```bash
# what the pipeline runs; you should not normally run this yourself
npx cdk deploy <app>-service --parameters ImageTag=<commit-sha>
```

The image tag is always an immutable commit SHA. `latest` is never deployed — a
mutable tag leaves the template byte-identical between deploys, so CloudFormation
sees no change and **the rollout silently does not happen**.

## Two things that surprise people

**The target group lives in the platform stack**, not with the service. It holds the
health check configuration, and putting it in the service stack would mean every
routine deploy replaced the target group and its listener rule.

**The load balancer's security group egress is wired explicitly.** Normally CDK adds
that rule as a side effect of registering a target — but the target is registered in
the service stack, so the side effect never fires. The symptom of getting this wrong
is memorable: tasks start cleanly, log that they are listening, fail every health
check, and get killed with exit code 137. It looks like an application bug and is
not.
