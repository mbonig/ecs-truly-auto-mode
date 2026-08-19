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
| `database` (RDS or DocumentDB) | `dbInstanceIdentifier`, `endpointAddress`, `port`, `securityGroupId` — or create it, see below |
| `cache` (ElastiCache) | `cacheClusterId`, `endpointAddress`, `port`, `securityGroupId` — or create it |
| `dsql-cluster` (Aurora DSQL) | `clusterIdentifier`, `endpoint`, plus `vpcEndpointServiceName` if egress is `none` — or create it, see below |
| Buckets / tables / queues / topics | `bucketName` / `tableName` / `queueUrl` / `topicArn` — or create them |
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

## Datastores: the skill looks before it asks

Datastores work the same way the OIDC provider does. For each one it detects, the skill
runs a single lookup on whatever name it found in your code — a table name, a bucket
name, the first label of an `*.rds.amazonaws.com` host:

- **Found it** → adopted, identifiers filled in from the response. You are not asked.
- **Checked and it isn't there** → offered as `create`.
- **Couldn't check** → you are asked, with both options. A lookup that failed is never
  read as "it doesn't exist", because those two situations need opposite actions.
- **No name to look up** → you are asked. The skill does not enumerate every table in
  your account to fill the gap.

### What a created datastore commits you to

Creating is a real option now, but it is not free of consequences, and the plan states
all of these before you approve it:

- **Created datastores are retained on stack deletion**, and databases are
  deletion-protected. `cdk destroy` leaves them — and their bill — behind. This is
  deliberate: a retained resource costs money and takes a minute to delete by hand, while
  a destroyed one is gone.
- **A created database's first platform deploy takes tens of minutes.** It is not a
  hang. It happens once, since the platform stack is the rarely-deployed one.
- **A created database comes up empty.** Schema migrations are yours — the skill does not
  generate them and the pipeline does not run them.
- **A created table's key schema cannot be changed.** So the skill refuses to create one
  unless the key schema was read from your code at high confidence or you confirmed it.
  This is the only datastore decision that cannot be revised later.

### Aurora DSQL is unusually cheap to create, and different in two ways worth knowing

DSQL is serverless with no capacity or version to choose, so creating one is a
30-second operation — not the tens-of-minutes wait RDS or DocumentDB take, even
though the retention and deletion-protection asymmetry above still applies to it.

It also differs from every other datastore here in a way that removes a step rather
than adding one: **DSQL has no security group and no generated secret.** There is
nothing to adopt or create for either, and the driver authenticates with a
short-lived IAM token instead of a password. The one thing that *is* still on you:
the IAM grant only authorises the connection attempt, and DSQL separately needs a
database role linked to that IAM principal, created with SQL run against the cluster
after it exists. The plan states the exact statements — see
[known-limits.md](./known-limits.md).

### If your app reads a single DATABASE_URL

This is the common case, and the one place a `create` decision cannot complete on its own.

A created database gets generated credentials in Secrets Manager, holding `host`, `port`,
`username`, `password` and `dbname` as separate fields. It does not hold an assembled
connection URL, and nothing can build one without reading the password to do it. So if
your application reads `DATABASE_URL` (or `REDIS_URL`, or `MONGO_URI`), the plan will stop
and offer you two ways forward:

1. **Give it a secret holding the URL.** The database is still created; your secret is
   injected by reference like any other.
2. **Switch to the discrete variables** — `PGHOST`, `PGUSER`, and so on — and adapt the
   application.

It will not guess, and it will not quietly fall back to making you find a database.

## Resources that can only be adopted

Some things the skill will never create, and the reasons differ:

- **Hosted zones.** Creating one means delegating nameservers at a registrar, which
  is outside what the skill can verify.
- **CodeConnections connections.** A new connection is created in `PENDING` and
  requires a human to complete an OAuth handshake in the console. CloudFormation
  cannot finish it.
- **Aurora clusters.** A cluster's writer/reader topology is not something the skill can
  read out of your application code, and creating a one-instance cluster would
  misrepresent what Aurora is for. A plain RDS engine can be created; `aurora-*` is
  adopt-only.
- **A datastore it could not identify.** If the analysis records a datastore as `other`,
  it cannot create it — it does not know what to make.

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
