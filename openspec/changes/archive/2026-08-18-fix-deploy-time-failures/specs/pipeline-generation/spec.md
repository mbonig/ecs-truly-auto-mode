## MODIFIED Requirements

### Requirement: Pipeline credentials

The generated pipeline SHALL authenticate to AWS without long-lived credentials stored in the repository. The deploy role's permissions SHALL include the ability to assume the CDK bootstrap roles at the recorded bootstrap qualifier, because `cdk deploy` publishes templates and executes change sets through those roles rather than the caller's own credentials. The GitHub Actions OIDC trust condition SHALL accept both the standard and the GitHub Enterprise Managed Users (EMU) forms of the OIDC `sub` claim, since whether a given GitHub org is on EMU is not derivable at generation time.

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
