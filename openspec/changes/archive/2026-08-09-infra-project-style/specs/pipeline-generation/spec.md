## ADDED Requirements

### Requirement: The pipeline does not run projen

The generated pipeline SHALL install from the committed lockfile and invoke the CDK CLI directly, under both project styles, and SHALL NOT run projen.

#### Scenario: Deploy path is unchanged by the style

- **WHEN** the pipeline runs against a project generated in either style
- **THEN** it installs from the committed lockfile and deploys the service stack with the image tag, with no projen step

## MODIFIED Requirements

### Requirement: Path-filtered triggers

The pipeline trigger's path filter SHALL be derived from the paths the Dockerfile's build context actually reads, together with the Dockerfile, dependency manifests and lockfiles, and the service stack source at the location the recorded project style puts it.

#### Scenario: Filter derived from build context

- **WHEN** the pipeline is generated
- **THEN** the path filter covers every source path copied into the image and is not a guessed default

#### Scenario: Application change triggers deploy

- **WHEN** a file inside the build context changes
- **THEN** the pipeline runs

#### Scenario: Service stack path follows the project style

- **WHEN** the pipeline is generated
- **THEN** the filter names the service stack source at the path the recorded style places it, rather than a fixed path

#### Scenario: Project definition included under the projen style

- **WHEN** the recorded style is `projen`
- **THEN** the filter also includes `.projenrc.ts`, because it pins the CDK version the service stack is synthesized with

#### Scenario: Unrelated change does not trigger deploy

- **WHEN** only files outside the build context and outside the service stack source change
- **THEN** the pipeline does not run

#### Scenario: Platform stack is not deployed by this pipeline

- **WHEN** the platform stack source changes, at whichever path the project style places it
- **THEN** the service pipeline does not deploy it, and the user is told how the platform stack is deployed separately
