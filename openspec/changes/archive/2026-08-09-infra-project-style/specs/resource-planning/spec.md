## MODIFIED Requirements

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
