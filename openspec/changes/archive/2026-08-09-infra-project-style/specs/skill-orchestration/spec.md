## ADDED Requirements

### Requirement: Recorded infrastructure project style

The manifest SHALL carry an optional `infra` section recording the generated project's style, and the CDK version pinned when that style is `projen`. An absent `infra` section SHALL mean `plain`.

#### Scenario: Style recorded on approval

- **WHEN** the user approves a plan
- **THEN** the manifest records the chosen style, and the pinned CDK version when the style is `projen`

#### Scenario: Manifest predating the field

- **WHEN** a manifest with no `infra` section is read
- **THEN** it is treated as `plain`, the run is not blocked, and the repository is not converted to another style

#### Scenario: Version pinned exactly

- **WHEN** the recorded style is `projen`
- **THEN** the recorded CDK version is an exact version rather than a range, matching the version the plain template pins

## MODIFIED Requirements

### Requirement: Resumable and incremental runs

The system SHALL detect an existing manifest in the target repository and resume from the recorded state rather than restarting, preserving prior decisions — including the recorded project style, which SHALL govern the layout of every later phase.

#### Scenario: Resume mid-run

- **WHEN** the skill is invoked on a repository whose manifest records an approved plan but no generated infrastructure
- **THEN** the run resumes at the generation phase without re-asking the planning questions

#### Scenario: Re-run after application change

- **WHEN** the skill is invoked on a repository with complete generated output
- **THEN** it re-analyzes, reports what changed, and regenerates only the files affected by the change

#### Scenario: Re-run does not re-ask the style

- **WHEN** a run resumes against a manifest that records a project style
- **THEN** the recorded style is used and the question is not asked again

#### Scenario: Configuration change under the projen style

- **WHEN** a re-run changes only the generated configuration values
- **THEN** the configuration source is rewritten and projen is not re-run, because the file is an ordinary source file under both styles

#### Scenario: Manifest schema version

- **WHEN** a manifest records a schema version the skill does not recognize
- **THEN** the skill reports the mismatch and does not silently reinterpret the file
