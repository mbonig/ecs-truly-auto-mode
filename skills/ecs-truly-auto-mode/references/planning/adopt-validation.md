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

### Route 53 hosted zone

```bash
aws route53 get-hosted-zone --id <hostedZoneId>
```

No `--region` — Route 53 is global. Confirm the recorded hostname is within the zone,
and that the zone is public if the hostname is meant to be.

### RDS instance

```bash
aws rds describe-db-instances --db-instance-identifier <id> --region <region>
```

Record `Endpoint.Address` and `Endpoint.Port` from the response rather than trusting
what was typed. Confirm the instance's VPC matches, and capture its security group —
the generated stack adds an ingress rule to it from the task security group, and that
rule is the piece most often missed.

If `MasterUserSecret` is present, the instance has managed credentials with rotation.
Point the secret entry at that ARN rather than creating a parallel secret that goes
stale after the first rotation.

### Secrets Manager and SSM

```bash
aws secretsmanager describe-secret --secret-id <arn> --region <region>
aws ssm describe-parameters --parameter-filters Key=Name,Values=<name> --region <region>
```

`describe`, never `get`. Existence is the question; the value is not, and retrieving
it would leak it into context. If a `jsonKey` was recorded, it cannot be verified
without reading the value — leave it unverified and say so. That is the correct
trade.

### S3 bucket

```bash
aws s3api head-bucket --bucket <name> --region <region>
```

`404` means it does not exist; `403` means it exists but belongs to someone else —
a meaningful difference, since bucket names are globally unique and a typo can land
on a stranger's bucket.

### DynamoDB table

```bash
aws dynamodb describe-table --table-name <name> --region <region>
```

Record the table ARN, and the index ARNs if the code queries indexes — index access
needs `<table-arn>/index/*` in addition to the table itself.

### GitHub OIDC provider

```bash
aws iam list-open-id-connect-providers
```

Look for one ending in `token.actions.githubusercontent.com`. Most accounts already
have one, and creating a second fails — so this check decides create versus adopt
rather than merely confirming a value.

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
