## MODIFIED Requirements

### Requirement: Create-or-adopt decision per resource

Every entry in the resource plan SHALL be marked either `create` or `adopt`, and the system SHALL require an existing identifier from the user for every entry marked `adopt`. A `create` decision SHALL be carried through to the generated infrastructure for every resource the system is able to create; the system SHALL NOT respond to a `create` decision by omitting the resource and everything that depends on it.

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

#### Scenario: Certificate may be created

- **WHEN** a public hostname is recorded and a hosted zone covering it is adopted in the target account
- **THEN** the certificate entry offers both `create` and `adopt`, and a `create` decision requires no certificate ARN from the user

#### Scenario: Certificate creation requires an adopted hosted zone

- **WHEN** a public hostname is recorded and no hosted zone is adopted
- **THEN** the certificate entry offers only `adopt`, because a certificate the system creates is DNS-validated against a zone it does not create

#### Scenario: Recorded hostname is checked against the adopted zone

- **WHEN** the certificate is marked `create` and the recorded hostname is neither the adopted `zoneName` nor a subdomain of it
- **THEN** the plan reports the mismatch and the entry stays incomplete, because validation records written into that zone would never issue the certificate

#### Scenario: A create decision never silently drops the public hostname

- **WHEN** generation runs against a manifest whose certificate entry is marked `create`
- **THEN** the generated application serves the recorded hostname over HTTPS with a created certificate and an alias record — it does not fall back to an internal HTTP-only load balancer with no DNS record

#### Scenario: Incomplete public hostname is reported

- **WHEN** generation runs against a manifest recording a public hostname whose certificate or hosted zone entry is incomplete
- **THEN** generation states exactly what is missing rather than emitting an application that omits the hostname

#### Scenario: OIDC provider found in the account

- **WHEN** the pipeline target is `github-actions` and a lookup of the target account's OpenID Connect providers returns one whose URL ends in `token.actions.githubusercontent.com`
- **THEN** the entry is recorded as `adopt` with that provider's ARN and `validated: true`, the user is not asked, and the generated infrastructure creates no provider

#### Scenario: OIDC provider confirmed absent from the account

- **WHEN** the pipeline target is `github-actions` and a lookup of the target account's OpenID Connect providers succeeds and returns no match
- **THEN** the entry is recorded as `create` with `validated: true`, and the generated infrastructure creates the provider

#### Scenario: OIDC provider lookup cannot be run

- **WHEN** the pipeline target is `github-actions` and the provider lookup cannot be performed, because credentials are unavailable or the caller is not permitted to list OpenID Connect providers
- **THEN** the system asks the user whether the target account already has a GitHub OpenID Connect provider, and does not treat the failed lookup as evidence that none exists

#### Scenario: User confirms an existing OIDC provider

- **WHEN** the user answers that the account already has a GitHub OpenID Connect provider
- **THEN** the system collects its ARN, records the entry as `adopt` with that ARN and `validated: false`, and the generated infrastructure trusts it and creates no provider

#### Scenario: User confirms no OIDC provider exists

- **WHEN** the user answers that the account has no GitHub OpenID Connect provider
- **THEN** the entry is recorded as `create` with `validated: false`, and the generated infrastructure creates one

#### Scenario: OIDC provider decision is never implicit

- **WHEN** a manifest reaches generation with the pipeline target `github-actions` and no recorded OIDC provider decision
- **THEN** generation reports the missing decision rather than emitting infrastructure that creates a provider by default
