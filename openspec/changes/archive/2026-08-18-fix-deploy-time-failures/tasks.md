## 1. Deterministic Fargate service name

- [x] 1.1 Add `serviceName: config.name` to the `ecs.FargateService` in `assets/templates/cdk/lib/service-stack.ts`
- [x] 1.2 Confirm the IAM `EcsService` statement in `deploy-permissions.ts`, the GitHub Actions "wait for service to stabilize" step, and the CodePipeline buildspec's `SERVICE_NAME` all resolve to the same value as `config.name`
- [x] 1.3 Add a re-run migration note to `references/generation/iac-style.md`'s "On a re-run" section: regenerating an already-deployed app under this fix replaces the `AWS::ECS::Service` (immutable `serviceName`), a one-time disruption mitigated by the rolling circuit breaker

## 2. CDK bootstrap qualifier and AssumeRole grant

- [x] 2.1 Add `target.cdkQualifier` (string, optional, default `hnb659fds`) to `assets/schemas/manifest.schema.json` and document it in `references/manifest-schema.md`'s `target` section
- [x] 2.2 Add a "CDK bootstrap qualifier" check to `references/planning/adopt-validation.md`: when AWS credentials are available, look up `/cdk-bootstrap/<qualifier>/version` via `aws ssm get-parameter` in the target account/region, and surface a missing parameter in the plan rather than deferring to deploy time
- [x] 2.3 Thread `cdkQualifier` through `DeployPermissionsProps` in `assets/templates/cdk/lib/deploy-permissions.ts`
- [x] 2.4 Add an `AssumeCdkBootstrapRoles` statement to `deployPolicyStatements()` granting `sts:AssumeRole` on the qualifier's deploy, file-publishing, and lookup roles (`arn:aws:iam::${account}:role/cdk-${qualifier}-{deploy,file-publishing,lookup}-role-${account}-${region}`)
- [x] 2.5 Verify the same grant is exercised by both the GitHub Actions role and the CodePipeline CodeBuild role, since both call `deployPolicyStatements()`

## 3. Promote GitHub OIDC role wiring into the shipped templates

- [x] 3.1 Add an optional `githubActions?: { repository: string; branch: string; existingProviderArn?: string }` field to `PlatformStackProps` in `assets/templates/cdk/lib/platform-stack.ts`
- [x] 3.2 In the platform stack constructor, instantiate `GitHubOidcRole` when `githubActions` is present, using the in-scope `taskRole`, `executionRole`, `this.cluster`, and the repository from the prop — no new public stack properties
- [x] 3.3 Apply the identical change to the projen twin of `platform-stack.ts`, keeping both byte-identical apart from import paths (per the equivalence requirement)
- [x] 3.4 Add `pipeline.*` (target, repository, branch) as a generated constant read separately from `config` in `bin/app.ts` and `cdk-projen/src/main.ts`, and pass `githubActions` into the platform stack only when `pipeline.target === 'github-actions'`
- [x] 3.5 Update SKILL.md Phase 4 and `references/generation/iac-style.md`'s file-ownership list to describe `platform-stack.ts`/`bin/app.ts` (and projen twins) as conditionally parameterized by `pipeline.target`, and clarify that "byte-identical across styles" means across infra styles for a fixed pipeline target, not across pipeline targets
- [x] 3.6 Confirm `verify:styles` (or equivalent generation verification) exercises both a `github-actions` and a `codepipeline` generation of the platform stack

## 4. EMU-compatible OIDC trust condition

- [x] 4.1 In `GitHubOidcRole` (`assets/templates/cdk/lib/deploy-permissions.ts`), change the trust condition's `StringLike` value to an array containing both `repo:${props.repository}:*` and the EMU form, splitting `props.repository` into owner/repo the same way `codepipeline.ts`'s `CodeStarConnectionsSourceAction` already does
- [x] 4.2 Add a line to `references/pipeline/contract.md` under "Authenticate" naming the EMU failure mode (`Not authorized to perform sts:AssumeRoleWithWebIdentity`) and the CloudTrail `AssumeRoleWithWebIdentity` lookup as the fastest diagnostic

## 5. Verification

- [x] 5.1 Regenerate a test app with `pipeline.target: github-actions` under both `plain` and `projen` styles and confirm `cdk synth` still succeeds with no AWS credentials
- [x] 5.2 Confirm the generated platform stack template includes the GitHub OIDC role with both trust-condition patterns for `github-actions`, and no OIDC role for `codepipeline`
- [x] 5.3 Confirm the generated service stack template names the `AWS::ECS::Service` resource with the recorded `serviceName`
- [x] 5.4 Confirm the generated deploy role's policy document includes `sts:AssumeRole` on all three bootstrap roles at the recorded (or default) qualifier
