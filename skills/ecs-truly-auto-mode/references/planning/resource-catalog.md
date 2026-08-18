# Resource catalog

Every resource the plan can contain, what puts it there, and what is required to
adopt it. The `id` column is the value written to `plan.resources[].id`.

Adoption identifiers are chosen so that `cdk synth` needs **no AWS credentials** —
that is why an adopted VPC requires subnet IDs and availability zones rather than
just a VPC ID. `Vpc.fromLookup` would need only the ID, but it would also make
synthesis environment-dependent and write a `cdk.context.json` that goes stale.

## Networking

### `vpc`

**Included:** always.
**Created when:** no existing VPC is supplied.
**Adopt identifiers:**

| Field | Notes |
| --- | --- |
| `vpcId` | |
| `availabilityZones` | Required by `fromVpcAttributes`. |
| `isolatedSubnetIds` | For `none` egress. |
| `privateSubnetIds` | For `public` egress. |
| `publicSubnetIds` | Required if the load balancer is internet-facing. |

At least one subnet list must be non-empty, and the subnets must span at least two
AZs — an ALB requires two, and a single-AZ service has no availability story.

### `nat-gateway`

**Included:** always, so the plan states the decision either way.
**Action is derived, not chosen:** `skip` when `egress.classification` is `none`,
`create` (or `adopt`, for an existing VPC that already has one) when it is `public`.
The validator rejects a mismatch in either direction.
**Reason must name the finding** that forced it — the file and line of the external
call.

### `vpc-endpoints`

**Included:** when `egress.classification` is `none`.
**Created:** interface endpoints for `analysis.egress.awsServices`, plus the S3
gateway endpoint.

The S3 gateway endpoint is required even for an app that never touches S3, because
ECR stores image layers there. Omitting it produces a task that cannot pull its image
and an error that does not mention S3.

**Adopt identifiers:** `endpointIds` — a map of service key to VPC endpoint ID.

## Compute

### `cluster`

**Included:** always.
**Adopt identifiers:** `clusterName`, `clusterArn`.

### `ecr-repository`

**Included:** always.
**Created with:** a lifecycle policy retaining the last 20 images. Unbounded image
retention is a slow, invisible storage cost.
**Adopt identifiers:** `repositoryName`, `repositoryUri`.

## Ingress

### `load-balancer`

**Included:** when the container accepts inbound traffic.
**Created as:** an ALB, internet-facing when a public hostname is recorded, internal
otherwise.
**Adopt identifiers:** `loadBalancerArn`, `securityGroupId`, `listenerArn`.

Adopting an ALB means sharing it, which means the listener needs a rule with a
host or path condition to route to this service. Ask for the condition — an adopted
listener with no condition either fails to route or hijacks another service's
traffic.

### `target-group`

**Included:** whenever a load balancer is.
**Created in:** the **platform** stack, deliberately. The target group holds the
health check configuration, and putting it in the service stack would mean every
routine deploy replaces the target group and its listener rule.
**Adopt identifiers:** `targetGroupArn`.

### `certificate`

**Included:** when a public hostname is recorded.
**Created:** DNS-validated against the adopted hosted zone. **Offer `create` only when
`hosted-zone` is adopted** — validation writes a record into that zone, so without one
there is nowhere for it to go.
**Adopt identifiers:** `certificateArn`.

Must be in the same region as the ALB. A certificate created for CloudFront in
`us-east-1` is a common thing to have lying around and a common thing to mistakenly
reach for.

Check the hostname against the zone before accepting `create`: it must be the
`zoneName` itself or a subdomain of it. A certificate validated against a zone that is
not authoritative for the name **never issues**, and CloudFormation waits on it rather
than failing — the platform stack sits in `CREATE_IN_PROGRESS` until it times out.
Say that when the user picks `create`: the first platform deploy blocks until ACM
issues, which is normally a couple of minutes. It lands once, because the platform
stack is the rarely-deployed one.

### `hosted-zone` / `dns-record`

**Included:** when a public hostname is recorded.
**Adopt identifiers:** `hostedZoneId`, `zoneName`.

The skill does not create hosted zones. Creating one means delegating nameservers at
a registrar, which is outside what it can verify. The record itself is created inside
the adopted zone.

## Security and identity

### `task-security-group` / `alb-security-group`

**Included:** always, when the VPC is created or the groups are not supplied.
**Created as:** ALB group allows inbound 443/80 from the internet or the VPC; task
group allows inbound on the container port **from the ALB group only**, never from a
CIDR.
**Adopt identifiers:** `securityGroupId`.

### `task-role`

**Included:** always.
**Created with:** permissions derived from `analysis.datastores[].iamActions`, scoped
to the specific resources in the plan. Never wildcards.
**Adopt identifiers:** `roleArn`.

### `execution-role`

**Included:** always.
**Created with:** `AmazonECSTaskExecutionRolePolicy`, plus
`secretsmanager:GetSecretValue` or `ssm:GetParameters` on exactly the secret ARNs in
`analysis.config.secrets`, plus `kms:Decrypt` if any uses a customer-managed key.
**Adopt identifiers:** `roleArn`.

The execution role — not the task role — is what reads secrets, because injection
happens before the container starts. Granting the task role instead produces a task
that fails to start with a permission error naming a role that looks correct.

### `log-group`

**Included:** always.
**Created with:** an explicit retention period. The CDK default is infinite
retention, which is a real and permanent cost.
**Adopt identifiers:** `logGroupName`.

## Data

### `database`

**Included:** when a network-reached datastore is detected.
**Action:** `adopt` only. **The skill never creates a database.** A database outlives
the service by years, and creating one as a side effect of deploying an app is the
wrong default. If the user has none, say it must exist first.
**Adopt identifiers:** `dbInstanceIdentifier`, `endpointAddress`, `port`,
`securityGroupId`.

Generating a security group rule from the task group to `securityGroupId` is the
piece most often missed. Without it, the app fails at startup with a connection
timeout rather than a clear error.

### `cache`

Same treatment as `database`. Adopt-only. Identifiers: `cacheClusterId`,
`endpointAddress`, `port`, `securityGroupId`.

### Bucket, table, queue, topic entries

**Included:** one entry per API-reached resource detected.
**Action:** `adopt` by default — these usually exist and are shared. `create` is
offered when the analysis found a name that resolves to nothing.
**Adopt identifiers:** `bucketName`, `tableName`, `queueUrl`, `topicArn` respectively.

The `id` is derived from the resource's role: `receipts-bucket`, `sessions-table`.

## Pipeline

### `github-oidc-role`

**Included:** when `pipeline.target` is `github-actions`.
**Created with:** a trust policy on the GitHub OIDC provider, scoped to both
`repo:<owner>/<repo>:*` and the GitHub Enterprise Managed Users (EMU) form
`repo:<owner>@*/<repo>@*:*`, and permissions limited to the ECR repository, the
service stack, the SSM prefix, and `sts:AssumeRole` on the CDK bootstrap roles.
**Adopt identifiers:** `roleArn`.

The trust policy must be scoped to the repository. A trust policy accepting the
GitHub OIDC provider without a `sub` condition can be assumed from **any** GitHub
repository in the world, which is a full account compromise rather than a
misconfiguration.

Both `sub` forms are granted unconditionally rather than detected, because whether a
given GitHub org is on EMU is not derivable from the repository, the manifest, or a
synth-time check — see [contract.md](../pipeline/contract.md#2-authenticate) for the
failure mode this avoids and how to diagnose it if it recurs.

### `github-oidc-provider`

**Included:** when `pipeline.target` is `github-actions`. **Required** — this entry is
not optional and has no default.
**Created:** an OIDC provider for `https://token.actions.githubusercontent.com` with
the `sts.amazonaws.com` client ID, for an account that has none.
**Adopt identifiers:** `providerArn`.

Decide it by looking, not by asking or assuming. Most accounts already have a GitHub
provider, and creating a second fails the first platform deploy with
`EntityAlreadyExists` — but an account that genuinely has none needs one, so neither
action is safe as a default. The procedure, including what to do when the account
cannot be reached, is in
[adopt-validation.md](./adopt-validation.md#github-oidc-provider).

An adopted provider is used as-is. The stack reads its ARN and does not touch its
thumbprints or client IDs, so a provider created by another tool without
`sts.amazonaws.com` in its client ID list will fail at pipeline run time rather than at
deploy time.

The created provider is a CDK custom resource, which puts one Lambda function in the
platform stack. That handler runs in the Lambda service rather than the workload's VPC,
so an `egress: none` application with no NAT gateway can still create one.

### `codepipeline`

**Included:** when `pipeline.target` is `codepipeline`.
**Created:** pipeline, CodeBuild project with privileged mode for Docker builds,
artifact bucket, and the roles for each. Lives in the platform stack.
**Adopt identifiers:** `pipelineName`.

### `codeconnection`

**Included:** when `pipeline.target` is `codepipeline`.
**Action:** `adopt` only. A CodeConnections connection is created in `PENDING` status
and requires a human to complete an OAuth handshake in the console — it cannot be
finished by CloudFormation. Ask for the ARN of a connection already in `AVAILABLE`.
**Adopt identifiers:** `connectionArn`.

## Deriving the plan

1. Start with the always-included entries.
2. Add ingress entries if the container accepts traffic.
3. Add `certificate`, `hosted-zone`, `dns-record` if a public hostname is recorded.
4. Add one entry per detected datastore.
5. Add the pipeline entries for the selected target.
6. Set `nat-gateway` and `vpc-endpoints` from the egress classification.
7. For each entry, ask create-or-adopt — except where this catalog says the action is
   derived (`nat-gateway`) or adoption is the only option (`database`, `cache`,
   `hosted-zone`, `codeconnection`).

Every entry needs a `reason` naming what put it in the plan. An entry the user cannot
account for is one they cannot evaluate.
