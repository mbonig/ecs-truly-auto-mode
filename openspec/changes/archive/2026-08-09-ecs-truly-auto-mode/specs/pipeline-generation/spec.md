## ADDED Requirements

### Requirement: Pipeline target selection

The system SHALL let the user choose between a GitHub Actions pipeline and an AWS CodePipeline/CodeBuild pipeline, and SHALL record the choice in the manifest.

#### Scenario: User selects a target

- **WHEN** the plan reaches the pipeline decision
- **THEN** the user is offered both targets with their prerequisites stated, and the selection is recorded

#### Scenario: GitHub Actions prerequisites

- **WHEN** the user selects GitHub Actions
- **THEN** the plan includes an IAM role trusted by the GitHub OIDC provider, scoped to the repository, as a create-or-adopt entry

#### Scenario: CodePipeline prerequisites

- **WHEN** the user selects CodePipeline
- **THEN** the plan includes the pipeline, build project, artifact bucket, and source connection as resources in the platform stack

### Requirement: Shared deployment contract

Both pipeline targets SHALL implement the same sequence of steps: trigger on push with a path filter, build the image, push it to ECR tagged with the commit SHA, verify the required SSM parameters exist, and deploy the service stack with that tag.

#### Scenario: Equivalent behavior across targets

- **WHEN** either target runs on the same commit
- **THEN** the same image tag is pushed and the same service stack change is applied

#### Scenario: Preflight before deploy

- **WHEN** an SSM parameter the service stack requires is missing
- **THEN** the pipeline fails before attempting the deployment and names the missing parameter

#### Scenario: Immutable tag

- **WHEN** the pipeline pushes an image
- **THEN** it is tagged with the commit SHA and the service stack is deployed with that tag rather than a mutable tag

### Requirement: Path-filtered triggers

The pipeline trigger's path filter SHALL be derived from the paths the Dockerfile's build context actually reads, together with the Dockerfile, dependency manifests and lockfiles, and the service stack source.

#### Scenario: Filter derived from build context

- **WHEN** the pipeline is generated
- **THEN** the path filter covers every source path copied into the image and is not a guessed default

#### Scenario: Application change triggers deploy

- **WHEN** a file inside the build context changes
- **THEN** the pipeline runs

#### Scenario: Unrelated change does not trigger deploy

- **WHEN** only files outside the build context and outside the service stack source change
- **THEN** the pipeline does not run

#### Scenario: Platform stack is not deployed by this pipeline

- **WHEN** the platform stack source changes
- **THEN** the service pipeline does not deploy it, and the user is told how the platform stack is deployed separately

### Requirement: Pipeline credentials

The generated pipeline SHALL authenticate to AWS without long-lived credentials stored in the repository.

#### Scenario: GitHub Actions authentication

- **WHEN** the GitHub Actions pipeline runs
- **THEN** it assumes the OIDC role from the plan and no AWS access key is stored as a repository secret

#### Scenario: Least-privilege deploy permissions

- **WHEN** the deployment role is generated
- **THEN** its permissions are scoped to the ECR repository, the service stack, and the SSM parameter path in the manifest
