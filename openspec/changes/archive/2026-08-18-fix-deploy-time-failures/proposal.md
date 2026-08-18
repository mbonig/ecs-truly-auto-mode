## Why

A live end-to-end run against `testing-ecs-truly-auto-mode` (GitHub Actions target, `projen` style) hit four deploy-time failures that `cdk synth` cannot catch because they only surface once a real OIDC token is exchanged and a real `cdk deploy` runs against real IAM: the Fargate service has no deterministic name, the deploy role can't assume the CDK bootstrap roles, GitHub's OIDC `sub` claim is EMU-org-dependent, and the OIDC role wiring that Phase 4 promises was never actually added to the shipped templates. None of these are specific to this app — every one recurs on the next app generated with `pipeline.target: github-actions`, and the bootstrap-role gap also affects `codepipeline`. Each cost a full pipeline run to diagnose.

## What Changes

- Give the generated `ecs.FargateService` a deterministic `serviceName: config.name`, so the IAM resource ARN, the GitHub Actions "wait for steady state" step, and the CodePipeline buildspec all address a service that actually exists under that name. **BREAKING** for repos already generated: `serviceName` is immutable on `AWS::ECS::Service`, so the next deploy after this fix replaces the service (rolling circuit breaker makes this a non-outage, but it is a physical resource replacement).
- Add an `sts:AssumeRole` grant on the three CDK bootstrap roles (deploy, file-publishing, lookup) to `deployPolicyStatements()`, parameterized by a new, validated `target.cdkQualifier` manifest field (default `hnb659fds`) instead of a hardcoded qualifier.
- Always grant both the standard and the GitHub Enterprise Managed Users (EMU) forms of the OIDC trust condition `sub` pattern in `GitHubOidcRole`, since EMU-ness isn't derivable at generation time; document the failure mode and the CloudTrail diagnostic for it.
- Wire `GitHubOidcRole` into the shipped `platform-stack.ts` template (and its projen twin) behind an optional `githubActions` prop, populated from `pipeline.*` manifest fields when `pipeline.target === 'github-actions'`, so this stops being a per-app, hand-authored, untested addition.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `infrastructure-generation`: the service stack's `FargateService` now takes a deterministic `serviceName`; the platform stack now conditionally instantiates the GitHub OIDC role when the pipeline target is `github-actions`; the equivalence-across-styles requirement is clarified to mean equivalence for a fixed pipeline target, not across pipeline targets.
- `pipeline-generation`: the least-privilege deploy permissions requirement now includes `sts:AssumeRole` on the CDK bootstrap roles at the recorded qualifier; the GitHub Actions authentication requirement now covers the EMU `sub` claim form.
- `resource-planning`: the manifest and its validation gain the `target.cdkQualifier` field, validated against the target account/region during planning the same way other AWS-side identifiers are.

## Impact

- `assets/templates/cdk/lib/service-stack.ts` — add `serviceName`.
- `assets/templates/cdk/lib/deploy-permissions.ts` — `GitHubOidcRole` trust condition (EMU pattern), `deployPolicyStatements()` / `DeployPermissionsProps` (bootstrap `AssumeRole`, `cdkQualifier`).
- `assets/templates/cdk/lib/platform-stack.ts` (and projen twin) — new optional `githubActions` prop and conditional `GitHubOidcRole` instantiation.
- `assets/templates/cdk/bin/app.ts`, `cdk-projen/src/main.ts` — pass `githubActions` from `pipeline.*` config when the target is `github-actions`.
- `assets/schemas/manifest.schema.json`, `references/manifest-schema.md` — new `target.cdkQualifier` field.
- `references/planning/adopt-validation.md` — new CDK bootstrap qualifier validation check.
- `references/pipeline/contract.md` — EMU OIDC failure mode and CloudTrail diagnostic.
- `references/generation/iac-style.md` — file-ownership clarification (pipeline-target-conditional files) and a re-run migration note for the service name change.
