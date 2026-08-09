## Purpose

Defines the repository's configuration as something generated from one checked-in definition rather than maintained by hand, so that build, packaging, and release settings cannot drift from what was reviewed, and a hand-edited generated file is caught by CI rather than discovered at release time.

## ADDED Requirements

### Requirement: Configuration is generated from a single definition

The system SHALL generate its build, packaging, ignore, and CI configuration from one checked-in project definition, and SHALL provide a single command that regenerates all of it.

#### Scenario: Regeneration command exists

- **WHEN** the regeneration command is run in a clean checkout
- **THEN** every generated configuration file is produced and the command exits zero

#### Scenario: Regeneration is reproducible

- **WHEN** the regeneration command is run twice with no change to the definition
- **THEN** the second run leaves every generated file byte-identical to the first

#### Scenario: A definition change reaches the generated file

- **WHEN** the project definition is changed and regeneration is run
- **THEN** the corresponding generated file reflects the change

### Requirement: Generated files are identifiable and not hand-edited

The system SHALL mark each generated file as generated in a way a reader encounters before editing it, and SHALL treat a manual edit to a generated file as something to be overwritten rather than preserved.

#### Scenario: File announces itself

- **WHEN** a generated configuration file that supports comments is opened
- **THEN** it states that it is generated and names what to edit instead

#### Scenario: Manual edit does not survive

- **WHEN** a generated file is edited by hand and regeneration is run
- **THEN** the hand edit is replaced by the generated content

### Requirement: Drift fails CI

The system SHALL verify in continuous integration that the generated files committed to the repository match what the definition produces, and SHALL fail the build when they do not.

#### Scenario: Committed output is stale

- **WHEN** the project definition is changed and committed without regenerating
- **THEN** the build fails and reports which generated files differ

#### Scenario: Drift never reaches a release

- **WHEN** a build fails on drift
- **THEN** no package is published from that commit

### Requirement: Existing validation entry points are preserved

The system SHALL continue to expose the repository's existing manifest, example, pipeline-equivalence, resume, and fixture validation steps, and SHALL run all of them — together with the packaging verification — as part of the single test command.

#### Scenario: Every existing check still runs

- **WHEN** the test command is run
- **THEN** manifest validation, example validation, pipeline equivalence, resume checks, fixture assertions, and packaging verification all execute

#### Scenario: One failing check fails the command

- **WHEN** any one of those checks fails
- **THEN** the test command exits non-zero and names the check that failed

### Requirement: Development-time behavior of the packaged version

The system SHALL keep the checked-in package version at a placeholder that is replaced at release time, and every consumer of that version SHALL behave correctly when it is the placeholder.

#### Scenario: Placeholder version in a working tree

- **WHEN** the CLI is run from a working tree rather than an installed package
- **THEN** it reports the placeholder version without failing, and records the same value in the install record

#### Scenario: Real version in a published package

- **WHEN** the CLI is run from a package installed from the registry
- **THEN** it reports the released version
