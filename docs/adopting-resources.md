# Adopting existing resources

Every entry in the plan is either **created** or **adopted**. Adopting means you
supply the identifier of something you already own, and the generated CDK imports it
rather than creating it.

## What you have to supply

Identifiers are chosen so that `cdk synth` needs **no AWS credentials**. That is why
an adopted VPC requires subnet IDs and availability zones rather than just a VPC ID —
`Vpc.fromLookup` would need only the ID, but it would also make synthesis
environment-dependent and write a `cdk.context.json` that goes stale.

| Resource | Required identifiers |
| --- | --- |
| `vpc` | `vpcId`, `availabilityZones`, and at least one of `isolatedSubnetIds` / `privateSubnetIds` / `publicSubnetIds` (plus `publicSubnetIds` if the load balancer is internet-facing) |
| `cluster` | `clusterName`, `clusterArn` |
| `ecr-repository` | `repositoryName`, `repositoryUri` |
| `load-balancer` | `loadBalancerArn`, `securityGroupId`, `listenerArn`, and `listenerRuleHostHeader` if the listener is shared |
| `target-group` | `targetGroupArn` |
| `certificate` | `certificateArn` (same region as the ALB) — or create it, see below |
| `hosted-zone` | `hostedZoneId`, `zoneName` |
| `database` | `dbInstanceIdentifier`, `endpointAddress`, `port`, `securityGroupId` |
| `cache` | `cacheClusterId`, `endpointAddress`, `port`, `securityGroupId` |
| Buckets / tables / queues / topics | `bucketName` / `tableName` / `queueUrl` / `topicArn` |
| `github-oidc-role` | `roleArn` |
| `github-oidc-provider` | `providerArn` |
| `codeconnection` | `connectionArn` (must already be `AVAILABLE`) |

## The certificate does not have to exist first

A certificate is created or adopted like anything else. If you already have one that
covers the hostname, adopt it. If you don't, the platform stack issues one,
DNS-validated against your hosted zone — you don't need to go and make one first.

Two things follow from that:

- **Creating requires an adopted hosted zone**, because validation writes a record
  into it. The skill doesn't create zones (below), so with no zone the certificate has
  to be adopted.
- **The first platform deploy blocks until ACM issues the certificate**, usually a
  couple of minutes. If the zone isn't the one actually serving the hostname, it never
  issues and the stack sits there until it times out rather than failing — which is why
  the hostname is checked against the zone name before the plan is accepted.

## The GitHub OIDC provider is decided by looking

For a GitHub Actions pipeline, AWS needs an OIDC provider for
`token.actions.githubusercontent.com`. Most accounts already have one, and a second
cannot be created — the deploy fails with `EntityAlreadyExists`. Accounts that have
none need one.

So the skill checks your account rather than guessing, and records what it found. If it
can't reach the account, it asks — and a failed check is never read as "there isn't
one", because those two situations need opposite actions.

An adopted provider is used as-is. Its thumbprints and client IDs stay yours; the skill
only reads the ARN.

## Resources that can only be adopted

Some things the skill will never create, and the reasons differ:

- **Databases and caches.** A database outlives the service by years. Creating one as
  a side effect of deploying an app is the wrong default, so if you don't have one
  yet, it has to exist before the plan can complete. The skill wires connectivity and
  credentials to it and never touches the database itself.
- **Hosted zones.** Creating one means delegating nameservers at a registrar, which
  is outside what the skill can verify.
- **CodeConnections connections.** A new connection is created in `PENDING` and
  requires a human to complete an OAuth handshake in the console. CloudFormation
  cannot finish it.

## Validation

When credentials are available, every identifier you supply is checked before it is
recorded — the resource exists, is in the right VPC and region, and is in a usable
state. A typo caught here costs a re-ask; the same typo at deploy time costs a
rollback.

Checks worth knowing about because they catch real mistakes:

- **Subnet routing is verified against the label you gave it.** A subnet recorded as
  private but actually isolated (or vice versa) is the worst failure in this whole
  area: everything deploys successfully and the service silently has — or lacks —
  internet access.
- **Certificates you adopt must be `ISSUED`, not `PENDING_VALIDATION`**, and in the
  ALB's region. A `us-east-1` certificate created for CloudFront is a common thing to
  have lying around and a common thing to reach for by mistake. (A certificate the
  stack creates is checked differently — the hostname has to sit inside the zone that
  will validate it.)
- **`*.example.com` does not cover `example.com`** itself, or `a.b.example.com`.
- **S3 `head-bucket` distinguishes 404 from 403.** Bucket names are globally unique,
  so a typo can land on a stranger's bucket.
- **RDS instances with `MasterUserSecret`** already have a rotating managed secret.
  The plan points at it rather than creating a parallel secret that goes stale after
  the first rotation.

When credentials are **not** available, identifiers are recorded with
`validated: false` and the plan says so. Nothing is blocked — you may be planning
against an account you cannot reach — but "verified" and "assumed" stay
distinguishable.

## Adopting a shared load balancer

If you adopt an ALB that already serves other services, the listener needs a rule
condition so traffic is routed to this service specifically. Supply
`listenerRuleHostHeader`. Without a condition, the rule either fails to attach or
takes over another service's traffic.

One thing the generated stack **cannot** do for you: an imported security group is
immutable in CDK, so it cannot add the load balancer's egress rule to your task
security group. You have to add it yourself — the platform stack emits a warning at
synth time telling you exactly which group and port. Skipping it produces tasks that
start cleanly, fail every health check, and are killed with exit code 137.

## What adoption does not change

Adopted resources are never modified, with one deliberate exception: an **ingress
rule is added to an adopted database's security group** so tasks can reach it. That
rule is the single most commonly missed piece of an ECS-plus-RDS setup, and without
it the application fails at startup with a connection timeout rather than a clear
error.
