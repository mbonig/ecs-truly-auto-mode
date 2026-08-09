# resource-planning Specification

## Purpose
TBD - created by archiving change ecs-truly-auto-mode. Update Purpose after archive.
## Requirements
### Requirement: Complete resource plan

The system SHALL derive from the analysis findings a complete list of every AWS resource the application needs to run, and SHALL present that list — together with the shape of the project it will generate — to the user before generating any infrastructure code.

#### Scenario: Plan presented before generation

- **WHEN** the analysis phase completes
- **THEN** the full resource plan is presented and no infrastructure code is written until the user has reviewed it

#### Scenario: Every resource is accounted for

- **WHEN** the plan is presented
- **THEN** it includes networking, cluster, image registry, load balancing, DNS and certificates, IAM roles, logging, secrets, and every detected datastore

#### Scenario: Plan explains derivations

- **WHEN** a resource appears in the plan because of an analysis finding
- **THEN** the plan states the finding that caused it, including the reason for the subnet placement and NAT decision

#### Scenario: Generated project shape is stated

- **WHEN** the plan is presented
- **THEN** it states the chosen pipeline target and the chosen infrastructure project style, so the user approves both rather than discovering them in the generated output

### Requirement: Create-or-adopt decision per resource

Every entry in the resource plan SHALL be marked either `create` or `adopt`, and the system SHALL require an existing identifier from the user for every entry marked `adopt`.

#### Scenario: User adopts an existing resource

- **WHEN** the user marks a resource as adopted
- **THEN** the system prompts for the identifier it needs, records it in the manifest, and generates code that imports rather than creates the resource

#### Scenario: Adopting a VPC requires subnet detail

- **WHEN** the user adopts an existing VPC
- **THEN** the system collects the subnet IDs, their availability zones, and their routing type, so that generation does not depend on environment lookups

#### Scenario: Adopted identifier is validated

- **WHEN** AWS credentials are available and the user supplies an identifier
- **THEN** the system verifies the resource exists and is usable, and reports the problem without recording the value if it does not

#### Scenario: Plan is incomplete

- **WHEN** any entry marked `adopt` has no identifier
- **THEN** the plan is incomplete and generation does not proceed

### Requirement: Decision persistence

The system SHALL persist every analysis finding and every user decision to a versioned manifest in the target repository, and SHALL treat that manifest as the input to generation.

#### Scenario: Manifest written

- **WHEN** the user approves the plan
- **THEN** the manifest is written with the schema version, target account and region, all findings with evidence, and all create-or-adopt decisions

#### Scenario: Secrets excluded from manifest

- **WHEN** a secret is part of the plan
- **THEN** the manifest records only its name and the ARN or parameter name of its store, never its value

### Requirement: Incremental re-planning

On a repository that already has a manifest, the system SHALL re-run analysis, diff the results against the recorded findings, and ask the user only about entries that changed or are newly ambiguous.

#### Scenario: Nothing changed

- **WHEN** re-analysis produces findings matching the manifest
- **THEN** the user is told the plan is unchanged and is not asked to re-confirm decisions

#### Scenario: A finding changed

- **WHEN** re-analysis produces a finding that conflicts with the manifest
- **THEN** the system presents the old value, the new value, and the evidence, and asks the user which to keep

#### Scenario: A new resource is needed

- **WHEN** re-analysis detects a dependency absent from the manifest
- **THEN** the new resource is added to the plan with a create-or-adopt decision required before generation

