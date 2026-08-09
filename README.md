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

```bash
npx @matthewbonig/ecs-truly-auto-mode-skill install
```

It asks where to put the skill — `~/.claude/skills` (the default, available in every
project) or `./.claude/skills` (this project only) — and copies it there along with
everything it needs at runtime. Then, from a repository with a Dockerfile, ask Claude
Code to deploy it to ECS.

| | |
| --- | --- |
| `install [skill...]` | Install the named skills, or all of them if none are named |
| `list` | Show what this package ships and what is installed |
| `uninstall <skill...>` | Remove installed skills |

| | |
| --- | --- |
| `--user` | `~/.claude/skills` — the default |
| `--project` | `./.claude/skills` |
| `--dir <path>` | An explicit directory |
| `--force` | Replace a skill that is already installed |
| `--dry-run` | Report what would happen and write nothing |

When stdin is not a terminal — piped through a script, or running in CI — nothing is
prompted and the user-global default applies. The resolved destination is printed on
every run either way.

An install never overwrites silently: if the skill is already there, the CLI reports
both versions and stops until you pass `--force`. It writes only inside the skills
directory it resolved, and never touches Claude Code settings or other skills.

### Installing by hand

If you would rather not use the CLI, copy the skill and the assets it references:

```bash
cp -r skills/ecs-truly-auto-mode ~/.claude/skills/
mkdir -p ~/.claude/skills/ecs-truly-auto-mode/assets
cp -r templates ~/.claude/skills/ecs-truly-auto-mode/assets/templates
cp -r schemas   ~/.claude/skills/ecs-truly-auto-mode/assets/schemas
```

The two `assets` copies are not optional. `SKILL.md` refers to the CDK sources and the
manifest schema as `./assets/...`, so a skill copied without them analyzes and plans
correctly and then has nothing to generate from.

> **Breaking change.** Those paths used to be repo-relative (`templates/cdk/`), which
> never resolved once the skill was copied out of this repository. If you installed the
> skill by hand before this change and worked around the missing templates, re-install.

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
| `skills/ecs-truly-auto-mode/` | The skill package — `SKILL.md`, its references, and `skill.json` |
| `templates/` | CDK stacks and pipeline definitions the skill emits |
| `schemas/` | JSON Schema for the manifest |
| `src/` | The installer CLI |
| `test/` | CLI tests |
| `scripts/` | Validation tooling |
| `examples/` | Fixture applications exercising each analysis path |
| `openspec/` | Change proposals, specs, and design docs |
| `.projenrc.ts` | Project definition — the source of truth for all generated config |

`templates/` and `schemas/` live at the repository root but ship *inside* an installed
skill, as `assets/templates` and `assets/schemas`. Each skill declares what it needs in
its `skill.json`, and the CLI does the copy at install time. They are not committed
under the skill because `templates/` is live source that the fixture suite synthesizes
from — a second committed copy would drift from it.

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
npx projen build   # compile, lint, and the full suite
npm test           # the suite on its own
```

The suite runs the CLI tests, 15 manifest-corruption checks, 13 pipeline-equivalence
properties, 16 resume/incremental checks, 33 fixture assertions that synthesize real
CloudFormation and assert on what came out, and a packaging check.

The packaging check is the one worth knowing about: it packs the real tarball, installs
from it into a temporary directory using the packed CLI, and then resolves every
relative path the installed `SKILL.md` and reference documents point at. A missing
ignore rule, a wrong `skill.json`, or a stale path in a document all fail there rather
than reaching someone's machine.

Two things about `verify:fixtures`: it needs `templates/cdk` dependencies installed
(`cd templates/cdk && npm ci`), and it needs Docker for the fixtures that build.

While working on a skill in this repository, its own `./assets/...` paths do not
resolve, because assets are copied in at install time. To make them resolve locally:

```bash
npx projen skills:materialize   # writes skills/*/assets, which is gitignored
```

### This repository is managed by projen

`package.json`, `tsconfig.json`, `.gitignore`, `.npmignore`, and everything under
`.github/workflows/` are **generated**. Edit `.projenrc.ts` and run `npx projen`; edits
made directly to a generated file are overwritten on the next synth, and CI fails on
the difference rather than letting it through.

### Releases

Merging to `main` publishes. The workflow computes the next version from git history,
runs the full suite, publishes to npm with a provenance attestation, and pushes a tag
and a GitHub release. It does not commit anything back to `main` — the version in
`package.json` stays `0.0.0` and the real version lives in the tag, so there is no
version to bump in a pull request.

Because the bump size comes from commit messages, PR titles are linted as conventional
commits: a `feat:` title produces a minor release, anything else a patch.

Two prerequisites, neither of which the workflow can solve for itself:

- **`NPM_TOKEN`** as a repository secret — see below.
- **A public repository.** npm provenance requires one; on a private repository the
  publish fails until `npmProvenance: false` is set in `.projenrc.ts`.

#### Creating the npm token

The token must be an **automation** ("Automation" / CI) token. The publish runs
non-interactively, and a classic *Publish* token with 2FA enabled will fail with a
`EOTP` / "one-time password required" error that gives no hint about the cause.
Automation tokens bypass the 2FA prompt by design, which is exactly what CI needs.

1. Sign in at [npmjs.com](https://www.npmjs.com/) as the account that owns the
   `@matthewbonig` scope.
2. Open the avatar menu (top right) → **Access Tokens**, or go straight to
   <https://www.npmjs.com/settings/matthewbonig/tokens>.
3. Click **Generate New Token**, and pick the kind:
   - **Granular Access Token** (preferred) — scope it as narrowly as it will go:
     - *Expiration*: pick a date you will actually renew; npm caps these, and an
       expired token surfaces as a failed release, not a warning.
     - *Packages and scopes*: **Read and write**, restricted to
       `@matthewbonig/ecs-truly-auto-mode-skill`. On the very first publish the
       package does not exist yet, so select the `@matthewbonig` **scope** instead,
       then narrow the token to the single package afterwards.
     - *Organizations*: no access needed.
   - **Classic Token** → **Automation** — simpler, never expires, but it can publish
     *any* package the account owns. Use only if granular tokens are unavailable.
4. Copy the token. npm shows it exactly once.
5. In GitHub: **Settings** → **Secrets and variables** → **Actions** →
   **New repository secret**.
   - Name: `NPM_TOKEN` (exactly — it is the name projen's workflow reads)
   - Secret: the token you copied
6. Confirm it took: the secret appears under *Repository secrets* with no value shown.

To verify before trusting a real release, run the **release** workflow manually from
the Actions tab with **Dry run** ticked — projen's workflow exposes a
`workflow_dispatch` input for exactly this. It exercises authentication and the build
without publishing.

If the token ever leaks, revoke it on the same npm Access Tokens page; that
immediately invalidates it, and a new one can be added to the secret without any
change to this repository.

A note on the alternative: npm also supports **trusted publishing** via OIDC, which
removes the long-lived token entirely. projen supports it (`npmTrustedPublishing`),
but it has to be configured on the npm side against this specific repository and
workflow first. Worth moving to later; it is not a prerequisite now.

## License

MIT
