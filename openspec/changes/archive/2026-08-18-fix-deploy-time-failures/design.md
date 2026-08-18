## Context

Four failures surfaced on a live `github-actions` + `projen` run, all downstream of `cdk synth` succeeding with no credentials: no deterministic ECS service name, no `sts:AssumeRole` on the CDK bootstrap roles, an OIDC trust condition that assumes a non-EMU GitHub `sub` claim shape, and `GitHubOidcRole` never actually wired into the shipped `platform-stack.ts` template despite SKILL.md Phase 4 claiming it is. The last item is why the first three shipped uncaught: there was no tested, canonical template for GitHub OIDC wiring to diverge from, so it was hand-authored per app outside `verify:styles`.

Fixing 1–3 without fixing 4 would leave the same improvisation gap for the next contributor. This design treats template wiring (formerly "bug 4") as the structural fix that the other three sit on top of, and orders the other three so each stands alone if work stops partway.

## Goals / Non-Goals

**Goals:**
- Every `github-actions`-target app generated after this change deploys successfully on the first real run, with no post-synth surprises.
- The CDK bootstrap `AssumeRole` fix applies uniformly to both pipeline targets (`github-actions` and `codepipeline`), since both call `deployPolicyStatements()`.
- `GitHubOidcRole` wiring becomes a template-level concern covered by `verify:styles`, not a per-app addition.
- The EMU trust-condition fix requires no detection logic and no new manifest field — it's unconditionally correct for both EMU and non-EMU orgs.

**Non-Goals:**
- Detecting at generation or planning time whether a given GitHub org is EMU. There is no reliable signal for this (not derivable from the repo, the manifest, or a synth-time check), so the design deliberately grants both trust-condition forms instead.
- Changing the CodePipeline OIDC/authentication path — CodePipeline doesn't use GitHub OIDC at all (it uses a CodeStar connection), so bug 1 is GitHub Actions-only. Bug 2 (bootstrap `AssumeRole`) is the only fix shared across both targets.
- Retrofitting already-generated repositories automatically. The manifest-driven regeneration flow picks up these fixes on the next run; this change does not add a standalone migration script.

## Decisions

### Fargate service name: `serviceName: config.name`, not a derived/suffixed name

Use the app name directly rather than inventing a new naming scheme (e.g. `${config.name}-service`). Three other generated files already hardcode the assumption that the service is named exactly `<app.name>` (the IAM `EcsService` statement, the GitHub Actions wait step, the CodePipeline buildspec's `SERVICE_NAME`), so matching that existing assumption fixes all three call sites with a one-line change instead of also editing every consumer.

**Alternative considered:** derive the service name and thread it as a generated constant everywhere it's consumed (a `SERVICE_NAME` in `app-config.ts`). Rejected as unnecessary indirection — the consumers already spell `appName`/`config.name`, so setting `serviceName: config.name` at the construct site makes the implicit assumption explicit rather than introducing a new shared symbol.

### Bootstrap qualifier: new optional manifest field, not a hardcoded constant or a runtime lookup

`hnb659fds` is the CDK default, but it's not universal — accounts bootstrapped with `--qualifier` change every bootstrap role/bucket name. Options considered:
1. **Hardcode `hnb659fds`** — what the live repo's first fix attempt did. Works only by coincidence; rejected as the exact bug being fixed.
2. **Look up the qualifier at deploy time** (e.g. read `/cdk-bootstrap/*/version` and pattern-match). Rejected: adds a runtime AWS call and ambiguity resolution to every deploy for a value that's static per target account and already knowable at planning time.
3. **Add `target.cdkQualifier` to the manifest, default `hnb659fds`, validated during Phase 2 planning** — chosen. Consistent with how every other AWS-side identifier in the manifest is validated (`adopt-validation.md`), and a missing `/cdk-bootstrap/<qualifier>/version` SSM parameter at plan time is itself useful signal (the account/region was never bootstrapped) surfaced when it's cheap to fix, not at first deploy.

### EMU trust condition: always grant both patterns, array-valued `StringLike`

Rejected any form of EMU detection (asking the user, probing GitHub's API, inferring from the repository owner) as unreliable and unnecessary — IAM's `StringLike` already accepts an array of patterns OR'd together, so granting both the standard `repo:<owner>/<repo>:*` and the EMU `repo:<owner>@*/<repo>@*:*` forms is strictly more permissive in exactly the one dimension that matters (which literal `sub` string GitHub sends) while staying scoped to the same repository. This is the smallest change that is correct for every org shape without a detection step that could itself be wrong.

### OIDC role wiring: optional `githubActions` prop on `PlatformStackProps`, populated by the entry point

`GitHubOidcRole` needs the task role, execution role, cluster, and repository — all already in scope inside `platform-stack.ts`'s constructor as local variables (`buildTaskRole()`/`buildExecutionRole()` aren't exposed as public stack properties today). Two shapes were considered:
1. **Expose task/execution role and cluster as public stack properties**, and instantiate `GitHubOidcRole` in `bin/app.ts` from the platform stack's outputs. Rejected — this makes the OIDC role a second stack that must be deployed and ordered after the platform stack, doubling the moving parts on a rarely-changing stack, and forces every consumer of `platform-stack.ts` to reason about extra public surface it doesn't otherwise need.
2. **Instantiate `GitHubOidcRole` inside `platform-stack.ts`'s constructor**, gated on an optional `githubActions` prop — chosen. Keeps the OIDC role a resource of the platform stack it belongs to, needs no new public properties, and is a no-op (prop is `undefined`) for `codepipeline`-target apps.

`pipeline.repository`/`pipeline.branch` are read as a second generated constant alongside `config` (not folded into `AppConfig`), because `AppConfig` is documented as a pure infra projection of the resource plan and pipeline target/repository are pipeline concerns, not resource-plan concerns — matching how `main.ts` already imports `config` separately from stack wiring.

## Risks / Trade-offs

- [Setting `serviceName` on an already-deployed service forces a CloudFormation replacement] → Acceptable one-time disruption given the rolling circuit breaker; documented as a re-run migration note in `iac-style.md` so it isn't a silent surprise on the next regeneration of an old manifest.
- [Granting the EMU trust-condition pattern broadens which `sub` claims are accepted] → Both patterns still anchor on the exact repository name; the risk is bounded to "this repo, EMU-style claim" vs. "this repo, standard-style claim," not a wildcard across repositories.
- [New `target.cdkQualifier` manifest field adds a planning-time AWS call] → Consistent with existing adopt-validation checks; a missing bootstrap at the default qualifier is diagnostic information worth surfacing regardless.
- [`sts:AssumeRole` on bootstrap roles widens the deploy role's reach to CDK-managed infrastructure outside this app's own resources] → Scoped to exactly the three bootstrap roles for the qualifier recorded in the manifest, which is the minimum CDK's own CLI requires to deploy any stack; this is what CDK's own bootstrap documentation assumes callers have.

## Migration Plan

- Existing manifests without `target.cdkQualifier` default to `hnb659fds` on regeneration — no manifest edit required unless the account uses a custom qualifier.
- Existing `platform-stack.ts` files regenerate with the new optional `githubActions` field; apps already on `github-actions` with hand-authored OIDC wiring will see that wiring superseded by the template on next regeneration (subject to the existing generated-file-ownership diff/confirm flow).
- The `FargateService` rename causes exactly one resource replacement on the next deploy after regeneration; no other migration step is required.
- Rollback: revert the four template/schema changes; already-regenerated repos keep the deterministic service name and widened bootstrap-role grant (both harmless to leave in place) even if rolled back at the skill level.

## Open Questions

- None outstanding — the priority order in the proposal (service name → bootstrap AssumeRole → template wiring → EMU pattern) resolves the one sequencing question (whether EMU support requires the template-wiring fix first) by making the EMU fix land in the same canonical `deploy-permissions.ts` file regardless of wiring order.
