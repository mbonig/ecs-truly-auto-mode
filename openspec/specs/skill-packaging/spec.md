# skill-packaging Specification

## Purpose

Defines what a distributable skill package contains so that a skill, once copied out of this repository and into someone's Claude Code setup, resolves every file it references from its own directory and needs nothing from the repository it came from.

## Requirements

### Requirement: The skill directory is the unit of distribution

The system SHALL treat each directory under `skills/` as one independently installable package, identified by the directory name, and SHALL discover the set of installable skills from that directory rather than from a hand-maintained list.

#### Scenario: Skills are discovered

- **WHEN** the installable skills are enumerated
- **THEN** every directory under `skills/` that contains a `SKILL.md` is offered as installable, and its name is the directory name

#### Scenario: A directory without SKILL.md is not a skill

- **WHEN** a directory under `skills/` has no `SKILL.md`
- **THEN** it is not offered as installable and its absence does not fail enumeration

#### Scenario: A second skill needs no code change

- **WHEN** a new skill directory containing a `SKILL.md` is added under `skills/`
- **THEN** it is installable without any change to the installer

### Requirement: An installed skill is self-contained

The system SHALL ensure that every path a `SKILL.md` or its reference documents instruct the reader to open resolves inside the installed skill directory. A skill package SHALL carry the generator sources and schemas its instructions reference, and SHALL NOT reference a path that exists only in this repository.

#### Scenario: Generator sources travel with the skill

- **WHEN** `ecs-truly-auto-mode` is installed into a skills directory
- **THEN** the CDK stack sources, the pipeline definitions, and the manifest JSON Schema its instructions reference are present inside the installed skill directory

#### Scenario: No repo-relative reference survives

- **WHEN** the file paths referenced by an installed skill's `SKILL.md` and reference documents are resolved against the installed skill directory
- **THEN** every one of them exists

#### Scenario: The skill works from a user-global install

- **WHEN** the skill is installed to `~/.claude/skills/` and invoked from an unrelated repository
- **THEN** the generation phases locate their sources without reaching outside the installed skill directory

### Requirement: Packaged skills carry a version

The system SHALL record, inside each installed skill directory, the version of the package the skill was installed from and the skill's name, in a machine-readable form that an installer can read back without parsing `SKILL.md`.

#### Scenario: Version recorded on install

- **WHEN** a skill is installed
- **THEN** the installed skill directory contains a record naming the skill and the package version it came from

#### Scenario: Version read back

- **WHEN** an installed skill directory is inspected
- **THEN** its recorded name and version are readable without reading `SKILL.md`

#### Scenario: Record is not authored by hand

- **WHEN** the package version changes
- **THEN** the version recorded for a subsequently installed skill changes with it, with no separate file to update

### Requirement: The published package contains what installs need

The system SHALL verify, as part of its automated test suite, that the artifact published to the registry contains every file required to install every skill the package ships, and SHALL fail the suite when a required file is absent.

#### Scenario: Missing asset fails the suite

- **WHEN** a file that an installed skill would need is excluded from the published artifact
- **THEN** the test suite fails and names the missing file

#### Scenario: Verification uses the real artifact

- **WHEN** package contents are verified
- **THEN** the check inspects the artifact the registry would receive, not the working tree

#### Scenario: Development-only files are excluded

- **WHEN** the published artifact is inspected
- **THEN** fixture applications, planning documents, uncompiled CLI sources, tests, and repository tooling that no install needs are absent from it

#### Scenario: Verification runs against the shipped CLI

- **WHEN** the packaging verification installs a skill
- **THEN** it does so using the CLI as published in the artifact, not the uncompiled sources in the working tree
