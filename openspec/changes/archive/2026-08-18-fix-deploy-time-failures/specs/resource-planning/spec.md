## MODIFIED Requirements

### Requirement: Decision persistence

The system SHALL persist every analysis finding and every user decision to a versioned manifest in the target repository, and SHALL treat that manifest as the input to generation. The manifest SHALL record the target account's CDK bootstrap qualifier, defaulting to `hnb659fds` when the user does not supply one, and the system SHALL validate that qualifier against the target account and region when AWS credentials are available during planning.

#### Scenario: Manifest written

- **WHEN** the user approves the plan
- **THEN** the manifest is written with the schema version, target account and region, the CDK bootstrap qualifier, all findings with evidence, and all create-or-adopt decisions

#### Scenario: Secrets excluded from manifest

- **WHEN** a secret is part of the plan
- **THEN** the manifest records only its name and the ARN or parameter name of its store, never its value

#### Scenario: CDK bootstrap qualifier defaults when unspecified

- **WHEN** the user does not supply a bootstrap qualifier during planning
- **THEN** the manifest records `target.cdkQualifier` as `hnb659fds`, the CDK default

#### Scenario: CDK bootstrap qualifier is validated

- **WHEN** AWS credentials are available during planning
- **THEN** the system checks for the SSM parameter `/cdk-bootstrap/<qualifier>/version` in the target account and region, and reports to the user if it is missing, because a missing parameter means the target account and region have never been CDK-bootstrapped at that qualifier

#### Scenario: Missing bootstrap surfaced in the plan, not at first deploy

- **WHEN** the bootstrap qualifier validation finds no bootstrap parameter
- **THEN** the plan presented to the user states that the target account and region are not bootstrapped at the recorded qualifier, rather than leaving this to surface as a deploy-time failure
