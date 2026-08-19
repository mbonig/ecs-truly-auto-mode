# Egress classification

This is the single highest-value output of the analysis, and the one most worth
getting right.

The question is narrow: **does anything this container talks to live outside the
VPC?** The answer determines whether the platform stack provisions a NAT gateway,
which is a standing hourly charge plus per-GB data processing — and by a wide margin
the most common piece of accidental spend in a small ECS setup. It is also the
decision a user is least likely to revisit once it exists.

So the classification is *derived and justified*, never defaulted. The plan states
the answer and the evidence behind it as a headline item.

## The two outcomes

| Classification | Subnet placement | NAT | Requires |
| --- | --- | --- | --- |
| `none` | Isolated | No | VPC interface endpoints for the AWS services actually used |
| `public` | Private | Yes | The finding that forced it, named in the plan |

## Procedure

Enumerate every outbound call, then classify each one. Work through all four sources
before concluding — this is exactly the analysis where stopping early produces a
service that cannot reach its dependencies.

### 1. Collect call sites

- HTTP clients: `fetch`, `axios`, `got`, `requests`, `httpx`, `urllib`,
  `http.Client`, `HttpClient`, `Net::HTTP`, `RestTemplate`, `WebClient`.
- URL literals: grep for `https://` and `http://` across source and config.
- SDK clients: AWS SDK, plus third-party SDKs (Stripe, Twilio, SendGrid, Datadog,
  Sentry, Segment, Auth0). A vendor SDK is an external call even with no visible URL,
  and this is the most commonly missed category — the endpoint is inside the library.
- Hostnames in configuration and environment defaults.
- Package installs at **runtime**. A container that runs `npm install` or `pip
  install` on startup needs internet access forever, not just at build time. Installs
  in a `RUN` layer are build-time and do not count; installs in an entrypoint script
  do.

### 2. Classify each

**VPC-internal** — does not force NAT:

- AWS service endpoints reachable through a VPC endpoint (see the table below).
- Hosts resolving inside the VPC: RDS endpoints (`*.rds.amazonaws.com`), ElastiCache
  endpoints, internal load balancers, Cloud Map service-discovery names
  (`*.local`, `*.internal`), and sibling services in the same VPC.
- `localhost` / `127.0.0.1` — a sidecar or the app itself.

**External** — forces `public`:

- Any third-party API.
- Package registries at runtime (`registry.npmjs.org`, `pypi.org`).
- OIDC/OAuth providers, unless the identity provider is inside the VPC.
- Webhook *destinations*. Inbound webhooks arrive through the load balancer and cost
  nothing; outbound ones need egress.
- **Public AWS endpoints for services with no VPC endpoint.** This one is easy to
  miss: an AWS service call is not automatically VPC-internal. If the service has no
  interface endpoint, reaching it requires NAT.

### 3. Record

Set `analysis.egress.classification` with evidence. When `public`, every external
host goes in `externalHosts` with its own evidence — the plan names the specific file
and line that forced NAT, so the user can judge whether that dependency is worth the
cost. When `none`, `externalHosts` must be empty. The manifest validator enforces
both directions.

Populate `awsServices` with the services the workload actually calls, which drives
which interface endpoints get created.

## AWS services to VPC endpoints

Every task in isolated subnets needs the first three regardless of application code —
Fargate cannot pull the image or ship logs without them.

| Key | Endpoint service | Needed for |
| --- | --- | --- |
| `ecr` | `com.amazonaws.<region>.ecr.api` | **Always** — image pull |
| `ecr-docker` | `com.amazonaws.<region>.ecr.dkr` | **Always** — image pull |
| `logs` | `com.amazonaws.<region>.logs` | **Always** — CloudWatch Logs |
| `s3` | `com.amazonaws.<region>.s3` (**gateway**) | **Always** — ECR image layers live in S3 |
| `secretsmanager` | `com.amazonaws.<region>.secretsmanager` | Any secret injection |
| `ssm` | `com.amazonaws.<region>.ssm` | SSM-sourced secrets |
| `dynamodb` | `com.amazonaws.<region>.dynamodb` (**gateway**) | DynamoDB |
| `sqs` | `com.amazonaws.<region>.sqs` | SQS |
| `sns` | `com.amazonaws.<region>.sns` | SNS |
| `kms` | `com.amazonaws.<region>.kms` | Encrypted secrets |
| `sts` | `com.amazonaws.<region>.sts` | Role assumption |
| `events` | `com.amazonaws.<region>.events` | EventBridge |
| `dsql-data` | `com.amazonaws.<region>.dsql-<suffix>` (**discovered**, see below) | Aurora DSQL connections |
| `dsql` | `com.amazonaws.<region>.dsql` | DSQL **control plane** only — not needed to connect |

**Aurora DSQL has an interface endpoint, and using it is not automatic.** A DSQL
connection is a PostgreSQL wire-protocol call over TCP, not an SDK call, so it is easy
to reason that it has no VPC endpoint at all — that reasoning is wrong, and confirmed
wrong against `aws ec2 describe-vpc-endpoint-services`, not against a design document
or a prose claim. `boto3.client("dsql")` is present in the code because token
generation needs the client, but generating a token (`generate_db_connect_auth_token`)
is local SigV4 signing that makes **no network call** — so recording `dsql` (the
control plane) instead of `dsql-data` provisions an endpoint that is never used and
never lets the actual connection through. Only `dsql-data` is needed to connect.

The `dsql-data` service name is region-specific and opaque
(`com.amazonaws.us-east-1.dsql-fnh4` was the observed form) and must never be
hardcoded — a literal suffix from one region synthesizes a stack that deploys there
and fails everywhere else. Resolve it one of two ways:

- **The stack creates the cluster:** read it off the cluster's own
  `VpcEndpointServiceName` attribute at synth time. No lookup, no credentials, no
  region-specific constant.
- **The stack adopts a cluster:** a plan-time lookup, recorded into the manifest like
  any other adopted identifier —
  `aws ec2 describe-vpc-endpoint-services --filters Name=service-name,Values=*dsql*
  --query 'ServiceDetails[?contains(ServiceName,\`dsql-\`)].ServiceName'` — and
  carried through `adopt-validation.md`'s `validated: true/false` treatment.

**The hostname the task connects to depends on the egress classification, and this
coupling has no forgiving failure mode.** DSQL's public endpoint
(`<id>.dsql.<region>.on.aws`) and its VPC-endpoint form
(`<id>.dsql-<suffix>.<region>.on.aws`) are different strings, and the server
certificate is cut for whichever one is actually correct. A driver using
`sslmode=verify-full` against the wrong one for the chosen egress mode does not fail
fast — it hangs until the connect timeout. Get the endpoint from the same place the
classification came from, not from a value typed once and reused.

Three things about this table that cause real failures:

- **S3 and DynamoDB are gateway endpoints.** They attach to a route table, are free,
  and do not create an ENI. The rest are interface endpoints, each of which costs an
  hourly charge per AZ. That cost is still typically well below a NAT gateway, but it
  is not zero — which is why endpoints are provisioned for the services actually used
  rather than all of them.
- **The S3 gateway endpoint is required even for an app that never touches S3**,
  because ECR stores image layers in S3. Omitting it produces a task that cannot pull
  its image, with an error that does not mention S3.
- **Interface endpoints need a security group** allowing 443 from the task security
  group, and `privateDnsEnabled` so the normal service hostnames resolve to the
  endpoint. Without private DNS, the SDK still tries the public endpoint and hangs.

Services with **no** interface endpoint force `public` even though they are AWS. Say
so explicitly in the plan when this is the cause — "an AWS call forced NAT" is
surprising enough to deserve a sentence.

## Bias and the cost of each error

The two errors are not symmetric, and the classification should reflect that.

- **Wrongly `none`** → the service deploys and then cannot reach a dependency.
  Failure is at runtime, often intermittent, and the cause is unobvious.
- **Wrongly `public`** → the user pays for a NAT gateway they didn't need. Failure is
  a line on a bill.

So: **when a call genuinely cannot be classified, classify it `public` and say why.**
Do not stretch to reach `none`. But equally, do not classify `public` on the mere
*possibility* of an external call — a real call site with a file and line is required.
"I found no external calls" and "I couldn't tell" are different answers, and only the
first justifies `none`.

Either way, switching later is a one-field manifest change, and the generated
platform stack keeps the private-subnet path wired but inactive so the switch is not
a rewrite.
