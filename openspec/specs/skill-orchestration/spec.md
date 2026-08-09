# skill-orchestration Specification

## Purpose
TBD - created by archiving change ecs-truly-auto-mode. Update Purpose after archive.
## Requirements
### Requirement: Skill packaging and invocation

The system SHALL ship as a Claude Code skill whose description triggers on requests to deploy a containerized application to ECS, and whose instructions load supporting reference material only when the relevant phase begins.

#### Scenario: Skill triggers

- **WHEN** a user asks to deploy a repository containing a Dockerfile to ECS or Fargate
- **THEN** the skill is selected

#### Scenario: Progressive disclosure

- **WHEN** the skill is invoked
- **THEN** only the phase flow is loaded initially, and ecosystem checklists, stack templates, and the pipeline contract are read when their phase begins

#### Scenario: Prerequisites missing

- **WHEN** the target repository has no Dockerfile
- **THEN** the skill reports what it needs and stops rather than inventing one

### Requirement: Phase sequencing

The system SHALL execute in ordered phases — analyze, plan, generate infrastructure, generate pipeline — and SHALL NOT begin a phase before the preceding phase's output has been produced and, where required, approved.

#### Scenario: Generation gated on approval

- **WHEN** the user has not approved the resource plan
- **THEN** no infrastructure or pipeline file is written

#### Scenario: Analysis gated on build validation

- **WHEN** the image build fails
- **THEN** the run stops at the analysis phase

#### Scenario: Progress reported

- **WHEN** a phase completes
- **THEN** the user is told what was produced and what happens next

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

### Requirement: Escalation over guessing

The system SHALL present unresolved and conflicting findings to the user as decisions with their supporting evidence, and SHALL NOT resolve them by silent default.

#### Scenario: Conflicting evidence

- **WHEN** two findings contradict each other
- **THEN** both are presented with their evidence and the user decides

#### Scenario: Questions are batched

- **WHEN** a phase produces multiple questions
- **THEN** they are presented together, ordered by consequence, rather than one at a time across the run

#### Scenario: Confident findings are stated, not asked

- **WHEN** a finding is recorded at high confidence
- **THEN** it is presented as a default in the plan rather than as a question

### Requirement: Final handoff

On completion the system SHALL report what was generated, what remains for the user to do, and how to deploy each stack.

#### Scenario: Completion summary

- **WHEN** all phases complete
- **THEN** the user is shown the generated files, the platform stack deploy command, how the service stack is deployed by the pipeline, and any adopted resources the deployment depends on

#### Scenario: No residual dependency on the skill

- **WHEN** the run completes
- **THEN** the generated CDK application and pipeline can be deployed and maintained without invoking the skill again

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

