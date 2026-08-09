## Why

Getting a containerized app onto ECS means answering the same two dozen questions every time — which ports, which VPC, does it need a load balancer, does it talk to RDS, what goes in the task role, how does the image get built and rolled out. ECS Express Mode automates a narrow happy path but hides the resources it creates and doesn't adapt to an app that already has a VPC, a database, or a domain. We want the same "point it at a Dockerfile and go" experience, except the tool reads the actual repository, tells you exactly what it inferred, and hands you infrastructure code you own.

## What Changes

- Add a Claude Code skill (`ecs-truly-auto-mode`) that takes a repository containing a Dockerfile and build context and drives it to a deployed ECS service.
- **Analysis pass** over the repo, producing a structured findings document:
  - Dockerfile parse: exposed ports, base image, architecture, build args, entrypoint, multi-stage layout, and whether the image is buildable as-is.
  - Source scan for inbound surface: HTTP frameworks, route/listener registration, and health-check endpoints; tests are used as corroborating evidence for routes and expected status codes.
  - Source scan for outbound surface: external service calls (public HTTP endpoints, third-party SDKs) versus calls that resolve inside a VPC, to decide NAT/egress and whether the service can run in isolated subnets.
  - Hostname and DNS scan: hardcoded hostnames, `*.amazonaws.com` endpoints, service-discovery names, and candidate custom domains.
  - Datastore detection: RDS/Aurora, DynamoDB, ElastiCache, S3, and other AWS data services inferred from SDK usage, connection strings, ORM config, and env var names.
  - Configuration surface: env vars and secrets the container reads, split into plaintext config versus values that must come from Secrets Manager or SSM Parameter Store.
- **Resource plan** presented to the user before any code is generated: every resource the app needs, each marked `create` or `adopt`. For `adopt`, the user supplies an existing ID/ARN (VPC, subnets, cluster, certificate, hosted zone, DB instance, secret). Decisions are persisted so later runs are incremental rather than starting over.
- **Infrastructure generation** as a CDK (TypeScript) app split into exactly two stacks:
  - a **platform stack** — VPC (or imported), cluster, ECR repository, load balancer, security groups, log groups, certificates, DNS records, task/execution roles, and any adopted-resource lookups. Changes rarely.
  - a **service stack** — task definition and ECS service only, parameterized by image tag. Changes on every deploy.
- **Pipeline generation** for a user-selected target — GitHub Actions (OIDC role assumption) or AWS CodePipeline + CodeBuild — triggered on push with path filters, building and pushing the image to ECR and rolling the service stack forward with the new image tag.
- Add project scaffolding: repository layout, skill packaging, and reference documents the skill loads on demand.

## Capabilities

### New Capabilities
- `workload-analysis`: Deriving a structured, evidence-backed profile of a containerized app from its Dockerfile, source, tests, and configuration — inbound ports and health checks, outbound/external calls, hostnames and DNS, datastores, and required configuration and secrets.
- `resource-planning`: Turning an analysis profile into a complete list of required AWS resources, presenting it for review, and recording a create-or-adopt decision (with an existing identifier where adopted) for every entry.
- `infrastructure-generation`: Emitting a CDK TypeScript app that realizes the resource plan as a rarely-changing platform stack and a frequently-changing service stack, with a stable contract between them.
- `pipeline-generation`: Emitting a path-filtered CI/CD pipeline — GitHub Actions or CodePipeline/CodeBuild — that builds and pushes the image and deploys the service stack with the new image tag.
- `skill-orchestration`: The skill's end-to-end flow — invocation triggers, phase sequencing, the persisted manifest that makes runs resumable and incremental, and how unresolved findings are escalated to the user instead of guessed.

### Modified Capabilities

None — this is the first change in the project.

## Impact

- **New repository content**: the skill package (`SKILL.md` plus reference documents), CDK stack templates the generator emits, pipeline templates for both targets, and the manifest schema.
- **Consumer repositories**: the skill writes an infrastructure directory (CDK app), a pipeline definition, and a manifest file into the target repo. It does not modify application source or the Dockerfile.
- **AWS surface**: ECS/Fargate, ECR, VPC/ELB, IAM, CloudWatch Logs, Route 53/ACM, Secrets Manager/SSM, and — for the CodePipeline target — CodePipeline/CodeBuild/CodeConnections. Deployment is CloudFormation via CDK.
- **Dependencies**: AWS CDK v2 and the AWS CLI in the target repo's toolchain; Docker for image builds; an OIDC role in AWS for the GitHub Actions target.
- **Out of scope**: EKS, non-container workloads, multi-region and multi-account topologies, and automatic remediation of a Dockerfile that does not build.
