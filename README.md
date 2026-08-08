# ecs-truly-auto-mode

A Claude Code skill that takes a repository with a Dockerfile and gets it running
on ECS — by reading the code first, showing you what it inferred, and handing you
CDK you own.

ECS Express Mode automates a narrow happy path and hides the resources it creates.
This does the opposite: it analyzes the actual repository, presents every inference
with the file and line that supports it, asks about anything it isn't sure of, and
generates infrastructure code that keeps working after the skill is gone.

## What it produces

- **A CDK TypeScript app split into two stacks.** A *platform* stack (VPC, cluster,
  ECR, load balancer, roles, logging, DNS) that changes rarely, and a *service*
  stack (task definition and service, nothing else) that changes on every deploy.
- **A CI/CD pipeline** — GitHub Actions or CodePipeline, your choice — triggered on
  push with a path filter derived from what the image build actually reads. It
  builds, pushes to ECR tagged with the commit SHA, and rolls the service stack
  forward.
- **A manifest** (`.ecs-auto-mode/manifest.yaml`) recording every finding and every
  decision, so re-runs are incremental instead of starting over.

## The four phases

**1. Analyze.** Parse the Dockerfile for ports, architecture, and build context.
Scan the source for the HTTP listener and health-check endpoint, for outbound calls
that leave the VPC, for hostnames and candidate domains, for datastores, and for the
environment variables the container reads. Build the image to prove it builds — if
it doesn't, the run stops here.

**2. Plan.** Present every AWS resource the app needs. Each one is either *created*
or *adopted*; adopting means you supply the ID of something you already own. Nothing
is generated until the plan is complete and you've approved it.

**3. Generate infrastructure.** Emit the two CDK stacks from the manifest. They
synthesize without AWS credentials, because adopted resources are imported from
recorded attributes rather than looked up.

**4. Generate the pipeline.** Emit the target you picked, implementing the same
deployment contract either way.

## Two design decisions worth knowing about

**The stacks are coupled through SSM Parameter Store, not CloudFormation exports.**
`Fn::ImportValue` locks the exporting stack — the platform stack could not change a
value while the service stack imported it. That is exactly the wrong coupling to put
between a stack that changes rarely and one that changes constantly. The platform
stack writes its outputs to SSM parameters; the service stack reads them, and can
deploy in a pipeline that has never synthesized the platform stack.

**Whether you get a NAT gateway is a derived decision, with its reasoning shown.**
If the outbound scan finds nothing that leaves the VPC, the service goes in isolated
subnets with interface endpoints for exactly the AWS services it calls, and no NAT.
If something does need the public internet, you get private subnets with NAT — and
the plan names the file and line that forced it. A NAT gateway is the most common
piece of accidental spend in a small ECS setup, so this is stated up front rather
than buried.

## Installing

Copy the skill package into a project's skills directory:

```bash
cp -r skills/ecs-truly-auto-mode /path/to/your/project/.claude/skills/
```

Or into `~/.claude/skills/` to make it available everywhere. Then, from a repository
with a Dockerfile, ask Claude Code to deploy it to ECS.

## Requirements

- Docker, for the build-validation step
- Node.js and AWS CDK v2, for the generated app
- AWS credentials with permission to deploy the platform stack

## What it does not do

- Fix an app that doesn't containerize. If `docker build` fails it reports the error
  and stops; it does not rewrite your Dockerfile or your app.
- Manage adopted resources. Point it at an existing database and it wires
  connectivity and permissions, and never touches the database itself.
- Multi-region, multi-account, EKS, or non-container compute.

## Repository layout

| Path | Contents |
| --- | --- |
| `skills/ecs-truly-auto-mode/` | The skill package — `SKILL.md` and its references |
| `templates/` | CDK stacks and pipeline definitions the skill emits |
| `schemas/` | JSON Schema for the manifest |
| `scripts/` | Validation tooling |
| `examples/` | Fixture applications exercising each analysis path |
| `openspec/` | Change proposals, specs, and design docs |

## Documentation

| | |
| --- | --- |
| [Getting started](docs/getting-started.md) | One app from invocation to a running service |
| [The two-stack model](docs/two-stack-model.md) | Why the split, and why SSM instead of CloudFormation exports |
| [Adopting resources](docs/adopting-resources.md) | What identifiers each resource needs, and what is adopt-only |
| [Editing generated code](docs/editing-generated-code.md) | The overwrite check, and when to change the manifest instead |
| [Known limits](docs/known-limits.md) | How the analysis can be wrong, and what is out of scope |

## Development

```bash
npm install
npm test          # manifest validation, pipeline equivalence, resume, fixtures
```

`npm test` runs 15 manifest-corruption checks, 13 pipeline-equivalence properties,
16 resume/incremental checks, and 33 fixture assertions — the last of which
synthesize real CloudFormation and assert on what came out.

## License

MIT
