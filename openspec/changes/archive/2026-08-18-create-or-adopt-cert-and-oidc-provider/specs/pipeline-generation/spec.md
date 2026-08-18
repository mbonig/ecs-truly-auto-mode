## MODIFIED Requirements

### Requirement: Pipeline target selection

The system SHALL let the user choose between a GitHub Actions pipeline and an AWS CodePipeline/CodeBuild pipeline, and SHALL record the choice in the manifest.

#### Scenario: User selects a target

- **WHEN** the plan reaches the pipeline decision
- **THEN** the user is offered both targets with their prerequisites stated, and the selection is recorded

#### Scenario: GitHub Actions prerequisites

- **WHEN** the user selects GitHub Actions
- **THEN** the plan includes an IAM role trusted by the GitHub OIDC provider, scoped to the repository, as a create-or-adopt entry, and the GitHub OIDC provider itself as a separate create-or-adopt entry with its own identifier

#### Scenario: CodePipeline prerequisites

- **WHEN** the user selects CodePipeline
- **THEN** the plan includes the pipeline, build project, artifact bucket, and source connection as resources in the platform stack

#### Scenario: No OIDC provider entry for CodePipeline

- **WHEN** the user selects CodePipeline
- **THEN** the plan contains no GitHub OIDC provider entry, because CodePipeline authenticates through a CodeStar connection rather than GitHub OIDC

### Requirement: Pipeline credentials

The generated pipeline SHALL authenticate to AWS without long-lived credentials stored in the repository. The deploy role's permissions SHALL include the ability to assume the CDK bootstrap roles at the recorded bootstrap qualifier, because `cdk deploy` publishes templates and executes change sets through those roles rather than the caller's own credentials. The GitHub Actions OIDC trust condition SHALL accept both the standard and the GitHub Enterprise Managed Users (EMU) forms of the OIDC `sub` claim, since whether a given GitHub org is on EMU is not derivable at generation time. The generated infrastructure SHALL create a GitHub OpenID Connect provider only when the plan records that the target account has none, and SHALL otherwise trust the provider the plan records.

#### Scenario: GitHub Actions authentication

- **WHEN** the GitHub Actions pipeline runs
- **THEN** it assumes the OIDC role from the plan and no AWS access key is stored as a repository secret

#### Scenario: Least-privilege deploy permissions

- **WHEN** the deployment role is generated
- **THEN** its permissions are scoped to the ECR repository, the service stack, the SSM parameter path in the manifest, and `sts:AssumeRole` on the CDK bootstrap deploy, file-publishing, and lookup roles at the manifest's recorded `target.cdkQualifier`

#### Scenario: EMU-compatible OIDC trust condition

- **WHEN** the GitHub OIDC role's trust policy is generated
- **THEN** the `token.actions.githubusercontent.com:sub` `StringLike` condition is an array containing both `repo:<owner>/<repo>:*` and the EMU form `repo:<owner>@*/<repo>@*:*`, so the role can be assumed regardless of whether the org is on GitHub Enterprise Managed Users

#### Scenario: Bootstrap role assumption diagnosed via CloudTrail

- **WHEN** a deploy fails because the deploy role cannot assume a CDK bootstrap role, or the OIDC role cannot be assumed at all
- **THEN** the pipeline documentation directs the user to look up `AssumeRoleWithWebIdentity` events in CloudTrail to inspect the exact `sub` claim GitHub sent, as the fastest way to diagnose a trust-condition mismatch

#### Scenario: OIDC provider failure modes are documented

- **WHEN** a platform deploy fails because a GitHub OIDC provider already exists, or because the trust policy names a provider that does not exist
- **THEN** the pipeline documentation names both messages — `EntityAlreadyExists` on the provider, and an invalid-principal failure on the role — and states which plan decision produces each
