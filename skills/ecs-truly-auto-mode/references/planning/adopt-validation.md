# Validating adopted identifiers

When the user supplies an identifier, check it exists and is usable **before**
recording it. A typo caught here costs a re-ask; the same typo caught at deploy time
costs a CloudFormation rollback, and for an adopted VPC it may not surface until a
task fails to place.

All commands need an explicit `--region`, because the target region comes from the
manifest and a profile may have no default configured.

## When credentials are unavailable

Validation is best-effort. If no credentials are available, or a call is denied:

- Record the identifier with `validated: false`.
- **Do not block.** The user may be planning against an account they cannot reach
  from here, which is legitimate.
- Say so in the plan, once, listing what went unchecked:

  ```
  Could not verify 3 identifiers (no credentials for 071128183726).
  They are recorded as supplied — a wrong value will surface at deploy time.
  ```

Never silently skip validation. "Verified" and "assumed" must be distinguishable.

## Per-resource checks

### VPC and subnets

```bash
aws ec2 describe-vpcs --vpc-ids <vpcId> --region <region>
aws ec2 describe-subnets --subnet-ids <ids...> --region <region>
```

Then check the things that actually break:

- Every subnet's `VpcId` matches the VPC. Subnets from a different VPC is a
  surprisingly common paste error and produces a confusing synth-time failure.
- The subnets span **at least two AZs** — an ALB requires two.
- The recorded `availabilityZones` match the subnets' actual AZs.
- Routing matches the claim. A subnet recorded as `privateSubnetIds` should have a
  default route to a NAT gateway; one recorded as `isolatedSubnetIds` should have no
  default route to a NAT or internet gateway. Check with:

  ```bash
  aws ec2 describe-route-tables --filters Name=association.subnet-id,Values=<id> --region <region>
  ```

  A mislabeled subnet is the worst case in this whole document: everything deploys
  successfully and the service silently has — or lacks — internet access. Check it.

### Security groups

```bash
aws ec2 describe-security-groups --group-ids <id> --region <region>
```

Confirm it belongs to the same VPC.

### ECS cluster

```bash
aws ecs describe-clusters --clusters <name> --region <region>
```

Confirm `status` is `ACTIVE`. A `describe` on a nonexistent cluster returns success
with an empty `clusters` array and a `failures` entry — check `failures`, not the
exit code.

### ECR repository

```bash
aws ecr describe-repositories --repository-names <name> --region <region>
```

Record the returned `repositoryUri` rather than constructing it — the account and
region are already in it, and constructing it by hand is one more place to be wrong.

### Load balancer and listener

```bash
aws elbv2 describe-load-balancers --load-balancer-arns <arn> --region <region>
aws elbv2 describe-listeners --load-balancer-arn <arn> --region <region>
```

Check the ALB's VPC matches, its `Scheme` matches the public-hostname decision, and
that the listener has a rule condition for this service. An adopted listener with no
condition either fails to route or takes over another service's traffic.

### ACM certificate

**Adopt path only.** These checks presuppose a certificate that exists; the create
path is checked differently, below.

```bash
aws acm describe-certificate --certificate-arn <arn> --region <region>
```

Check `Status` is `ISSUED` — a `PENDING_VALIDATION` certificate will fail the
deploy — and that the ARN's region matches the ALB's. A `us-east-1` certificate
created for CloudFront is a common thing to have lying around and a common thing to
reach for by mistake.

Check the domain too: `DomainName` or a `SubjectAlternativeNames` entry must cover
the recorded hostname, including the wildcard case. Note that `*.example.com` covers
`api.example.com` but **not** `example.com` itself, and not `a.b.example.com`.

### A certificate the stack will create

There is nothing in AWS to check yet, so this is a precondition check on the plan
itself — and it needs no credentials:

- `hosted-zone` must be `adopt`. DNS validation writes a record into that zone, and
  the skill does not create zones.
- The recorded hostname must be the zone's `zoneName` or a subdomain of it.

The second one is the check worth running. A certificate validated against a zone that
is not authoritative for the name never issues, and CloudFormation does not fail on
that — it waits, so the platform stack sits in `CREATE_IN_PROGRESS` until the stack
times out. Catching it here costs a re-ask; missing it costs an hour and a rollback.

What this cannot check is whether the adopted zone is the one actually served at the
registrar. A zone that exists but was never delegated looks identical from here. When
the user is unsure, adopting an already-`ISSUED` certificate is the honest recommendation.

### Route 53 hosted zone

```bash
aws route53 get-hosted-zone --id <hostedZoneId>
```

No `--region` — Route 53 is global. Confirm the recorded hostname is within the zone,
and that the zone is public if the hostname is meant to be.

### Secrets Manager and SSM

```bash
aws secretsmanager describe-secret --secret-id <arn> --region <region>
aws ssm describe-parameters --parameter-filters Key=Name,Values=<name> --region <region>
```

`describe`, never `get`. Existence is the question; the value is not, and retrieving
it would leak it into context. If a `jsonKey` was recorded, it cannot be verified
without reading the value — leave it unverified and say so. That is the correct
trade.

## Datastores: discovery, then the decision

Datastore lookups do the same job the [GitHub OIDC provider](#github-oidc-provider)
lookup does — they *decide* `create` versus `adopt` rather than confirming a value the
user typed. So run them **before asking anything** about the entry.

The procedure is the same for every kind:

| Outcome | Record |
| --- | --- |
| The lookup matched | `adopt`, identifiers filled in from the response, `validated: true` — do not ask |
| The lookup succeeded and matched nothing | offer `create`, `validated: true` |
| The lookup could not run | **ask**, offering both actions, `validated: false` |
| `nameFound: false` — nothing to look up | **ask**, offering both actions |

Two rules make this safe, and both are worth stating because getting either wrong is
expensive:

**A lookup that could not run is not evidence of absence.** No credentials, an expired
session, or a denied `describe` all look identical to "there is no table" from the
outside, and the two call for opposite actions. Only a call that *succeeded* and came
back empty means the resource is not there.

**One lookup per recorded name — never an enumeration.** Look up the name the analysis
found. Do not list every RDS instance or table in the account and present a picker: an
account can hold hundreds, a `describe` on a known name needs a far narrower permission
than a `List*`, and the evidence-backed match is a better answer than a menu. When
`nameFound` is `false` there is nothing to look up, so ask — do not enumerate to fill the
gap.

Where the name comes from, per kind: the first label of an `*.rds.amazonaws.com` or
`*.cache.amazonaws.com` host, a table or bucket name literal, a queue or topic name in
configuration.

### RDS instance

```bash
aws rds describe-db-instances --db-instance-identifier <id> --region <region>
```

On a match, record `Endpoint.Address` and `Endpoint.Port` from the response rather than
trusting what was typed. Confirm the instance's VPC matches, and capture its security
group — the generated stack adds an ingress rule to it from the task security group, and
that rule is the piece most often missed.

If `MasterUserSecret` is present, the instance has managed credentials with rotation.
Point the secret entry at that ARN rather than creating a parallel secret that goes
stale after the first rotation.

On no match, `create` is available — with two things to say in the plan, because both
are surprising if unsaid: the instance is **retained and deletion-protected**, so a stack
deletion leaves it (and its bill) behind; and the **first platform deploy blocks for tens
of minutes** while RDS provisions, which reads as a hang otherwise.

An `aurora-*` engine is adopt-only regardless of what the lookup found — a cluster's
writer/reader topology is not derivable from application code.

### ElastiCache cluster

```bash
aws elasticache describe-replication-groups --replication-group-id <id> --region <region>
aws elasticache describe-cache-clusters --cache-cluster-id <id> --region <region>
```

Replication groups for Redis, cache clusters for Memcached. Record the primary endpoint
(or the configuration endpoint for Memcached), the port, and the security group.

### DocumentDB cluster

```bash
aws docdb describe-db-clusters --db-cluster-identifier <id> --region <region>
```

Record the cluster endpoint, port and security group. A `mongodb+srv://` URI is not a
DocumentDB cluster and there is nothing to look up — it is an external service, and the
question it raises is the egress classification.

### DSQL cluster

```bash
aws dsql list-clusters --region <region>
```

On a match, record `arn` and `identifier`, and — only when `egress.classification` is
`none` — the region's DSQL **data-plane** endpoint service name, which is not
returned per-cluster and needs its own lookup:

```bash
aws ec2 describe-vpc-endpoint-services --region <region> \
  --filters "Name=service-name,Values=*dsql*" \
  --query 'ServiceDetails[?contains(ServiceName,`dsql-`)].ServiceName'
```

Record the result as `vpcEndpointServiceName`. Do **not** record a `securityGroupId`
— DSQL has none, and recording one produces a finding the validator rejects.

On no match, `create` is available. Two things to say in the plan, because DSQL
inverts the usual database warnings: it is **not** retained-and-slow like RDS — it
provisions in about 30 seconds — but it **is** still retained and deletion-protected
on stack deletion, the same asymmetry as every other created datastore.

**Availability is a separate question from permission, and the two produce opposite
correct answers.** `list-clusters` returning `AccessDeniedException` naming an
**explicit deny in a service control policy** means the organization has
administratively blocked DSQL in that region — not that DSQL is unavailable there.
Report the distinction: "DSQL is not available in this region" and "your
organization's SCP blocks DSQL in this region" send the user to different next steps,
a support ticket versus a conversation with a cloud administrator. Treat a denied
call the same way the [GitHub OIDC provider check](#github-oidc-provider) treats one
— never read it as absence.

### S3 bucket

```bash
aws s3api head-bucket --bucket <name> --region <region>
```

`404` means it does not exist; `403` means it exists but belongs to someone else —
a meaningful difference, since bucket names are globally unique and a typo can land
on a stranger's bucket. **`403` is not a create signal.** A bucket that exists under
someone else's account will fail the create with `BucketAlreadyExists`, so treat it as a
name to change rather than a resource to make.

### DynamoDB table

```bash
aws dynamodb describe-table --table-name <name> --region <region>
```

On a match, record the table ARN, and the index ARNs if the code queries indexes — index
access needs `<table-arn>/index/*` in addition to the table itself.

On no match, `create` requires a **key schema at `high` confidence or confirmed by the
user**. There is no default. A table's key schema is immutable, so a wrong partition key
is fixed by deleting and rebuilding a table that may by then hold data — this is the one
datastore decision that cannot be corrected after the fact, so it is the one place the
plan refuses to complete on a shape the user has not looked at.

### SQS queue and SNS topic

```bash
aws sqs get-queue-url --queue-name <name> --region <region>
aws sns get-topic-attributes --topic-arn <arn> --region <region>
```

For SQS, record the queue URL and derive the ARN from it. A `NonExistentQueue` error is
the "matched nothing" outcome, not a failure to report.

## Pipeline and bootstrap checks

### CDK bootstrap qualifier

`cdk deploy` publishes templates and executes change sets through the bootstrap
roles, not the deploying principal's own credentials — the deploy role needs
`sts:AssumeRole` on them, scoped to the qualifier the target account was
bootstrapped with. Confirm that qualifier during planning rather than discovering
it at first deploy, where the failure names an S3 bucket rather than the missing
grant:

```bash
aws ssm get-parameter --name /cdk-bootstrap/<qualifier>/version --region <region>
```

Default `<qualifier>` to `hnb659fds` when `target.cdkQualifier` is not supplied. A
missing parameter at that qualifier means the target account and region have never
been CDK-bootstrapped — surface that in the plan:

```
No CDK bootstrap found in 581514672367/us-east-1 at qualifier "hnb659fds".
Run `cdk bootstrap aws://581514672367/us-east-1` before the first deploy, or supply
the qualifier the account was actually bootstrapped with.
```

A custom qualifier changes the name of every bootstrap role and bucket
(`cdk-<qualifier>-deploy-role-...`, `cdk-<qualifier>-assets-...`), so getting this
wrong is silent until the pipeline's first real deploy.

### GitHub OIDC provider

This one decides `create` versus `adopt` rather than confirming a value the user
supplied, so run it **before** asking anything.

```bash
aws iam list-open-id-connect-providers
```

Look for one whose URL ends in `token.actions.githubusercontent.com`.

| Outcome | Record |
| --- | --- |
| A match | `adopt`, `providerArn` set to its ARN, `validated: true` |
| The call succeeded and returned no match | `create`, `validated: true` |
| The call could not run | **ask** — see below |

**A lookup that could not run is not the same as a provider that is not there.** No
credentials, an expired session, or a denied `iam:ListOpenIDConnectProviders` all
produce "no match" to anyone only looking for one. Recording that as `create` is how a
first deploy fails with `EntityAlreadyExists` — and the accounts most likely to deny
the call are the same locked-down accounts most likely to already have a provider. Only
a call that *succeeded* and came back empty is evidence of absence.

So when the call cannot be made, ask, and let the answer decide both ways:

```
Does account 071128183726 already have a GitHub OIDC provider?

  I couldn't check — no credentials for this account.

  yes   Paste its ARN. Suggested:
        arn:aws:iam::071128183726:oidc-provider/token.actions.githubusercontent.com
  no    One will be created by the platform stack.
```

Record `adopt` with the ARN the user gives, or `create`, either way with
`validated: false` and a note in the plan that the answer was not verified. That ARN is
conventional enough to offer as a suggestion, but record what the user confirms rather
than assuming it — the prefix differs outside the commercial partition.

When a provider is found, glance at its `ClientIDList` in the same breath:

```bash
aws iam get-open-id-connect-provider --open-id-connect-provider-arn <arn>
```

It needs `sts.amazonaws.com`. A provider created by another tool without it deploys
fine and then fails on the pipeline's first run, which is a much more expensive place
to find out.

### CodeConnections connection

```bash
aws codeconnections get-connection --connection-arn <arn> --region <region>
```

`ConnectionStatus` must be `AVAILABLE`. `PENDING` means the OAuth handshake was never
completed in the console, and no amount of deploying will fix it — the user has to
finish it by hand.

## On failure

Report what was checked, what came back, and what to do. Do not record the value.

```
Certificate arn:aws:acm:us-east-1:071128183726:certificate/1a2b... is
PENDING_VALIDATION, not ISSUED.

DNS validation hasn't completed. The deploy would fail on the listener.
Complete validation, or supply a different certificate ARN.
```

Then re-ask. A rejected identifier leaves that plan entry incomplete, and an
incomplete plan cannot be approved.

## What validation does not do

It does not check *permissions* — that the deploying principal can actually use these
resources. That surfaces at deploy time and is not worth simulating here.

It also does not re-run on every invocation. Once `validated: true` is recorded, a
re-run trusts it unless the identifier itself changed. Revalidating everything on
every run is slow and mostly rediscovers the same answers.
