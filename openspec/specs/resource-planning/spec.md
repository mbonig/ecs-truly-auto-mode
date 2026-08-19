# resource-planning Specification

## Purpose
Turns an analysis profile into a complete list of the AWS resources the application needs, presents it for review
alongside the shape of the project that will be generated, and records a create-or-adopt decision — with an
existing identifier wherever a resource is adopted — for every entry. This is the gate: nothing is generated until
the plan is complete and approved, because the plan is where a wrong inference costs nothing to fix.
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

### Requirement: Datastore discovery before the decision

For every detected datastore, the system SHALL attempt one targeted lookup in the target account, keyed on the name the analysis recorded, before asking the user anything about that entry. A lookup that cannot be run SHALL NOT be treated as evidence that the resource does not exist.

#### Scenario: Datastore found in the account

- **WHEN** the lookup for a detected datastore's recorded name succeeds and returns a matching resource
- **THEN** the entry is recorded as `adopt` with that resource's identifiers filled in and `validated: true`, and the user is not asked

#### Scenario: Datastore confirmed absent from the account

- **WHEN** the lookup succeeds and returns no matching resource
- **THEN** the entry offers `create` with `validated: true`, because the account has been checked rather than assumed

#### Scenario: Lookup cannot be run

- **WHEN** the lookup cannot be performed, because credentials are unavailable or the describe call is denied
- **THEN** the system asks the user, offering both `create` and `adopt`, and does not treat the failed lookup as evidence that the resource does not exist

#### Scenario: No name to look up

- **WHEN** the analysis recorded a datastore but no identifying name for it
- **THEN** the system asks the user, offering both actions, rather than enumerating every candidate resource in the account

#### Scenario: Discovery is name-keyed, not an enumeration

- **WHEN** discovery runs for a datastore whose name the analysis recorded
- **THEN** exactly one lookup is made against that name, rather than a listing of every resource of that kind in the account

### Requirement: Datastore create-or-adopt decision

Every detected datastore SHALL appear in the plan with both `create` and `adopt` available, except a datastore recorded as kind `other`, which SHALL be `adopt` only. A `create` decision SHALL record the chosen shape of the resource in the plan entry's `parameters`, and SHALL be carried through to the generated infrastructure. The system SHALL NOT respond to a `create` decision on a datastore by omitting the resource, its permissions, or the environment variables naming it.

#### Scenario: A create decision produces the resource

- **WHEN** generation runs against a manifest whose datastore entry is marked `create`
- **THEN** the generated infrastructure defines that datastore, the task role statement or security group rule it requires, and the environment variables naming it — it does not omit the datastore and leave the application pointing at nothing

#### Scenario: Create parameters are recorded separately from adopt identifiers

- **WHEN** the user chooses `create` for a datastore and supplies its shape
- **THEN** the chosen values are recorded in the entry's `parameters` and the entry carries no `identifiers`, because `identifiers` means what to import and a created resource has nothing to import

#### Scenario: Parameters on an adopted entry are rejected

- **WHEN** a plan entry is marked `adopt` and carries `parameters`
- **THEN** the plan is reported invalid, because the shape of a resource the system does not create would be silently ignored

#### Scenario: An unidentifiable datastore is adopt-only

- **WHEN** a datastore is recorded as kind `other`
- **THEN** the entry offers only `adopt`, because the system cannot create a resource it was unable to identify

#### Scenario: An Aurora engine is adopt-only

- **WHEN** the recorded relational engine is an Aurora engine
- **THEN** the entry offers only `adopt`, because a cluster's writer and reader topology is not derivable from application code and a single-instance cluster misrepresents it

#### Scenario: Cost-bearing shape is asked, costless shape is derived

- **WHEN** a datastore entry is marked `create`
- **THEN** values carrying a standing cost or a durability consequence — instance class, storage, multi-AZ, node type, replica count — are asked with a stated default, and values that are shape alone — a table's key schema, a bucket's encryption, a queue's dead-letter policy — are derived or fixed and stated rather than asked

#### Scenario: Retention of created datastores is stated in the plan

- **WHEN** the plan includes a datastore marked `create`
- **THEN** the plan states that the resource is retained on stack deletion, and that a relational or document database also carries deletion protection, so surviving data is an expectation the user agreed to

#### Scenario: First-deploy duration is stated

- **WHEN** the plan includes a relational or document database marked `create`
- **THEN** the plan states that the first platform deploy blocks for tens of minutes while the instance is provisioned, and that a rolled-back first deploy leaves the retained instance behind

### Requirement: Created database credentials must be resolvable

When a network-reached datastore is marked `create`, the system SHALL resolve how the application's recorded connection variables are satisfied by the credentials the created resource produces, and SHALL treat an unresolvable mapping as an incomplete plan rather than proceeding.

#### Scenario: Application reads discrete connection fields

- **WHEN** the analysis recorded connection variables carrying discrete fields and the datastore is marked `create`
- **THEN** the plan records the mapping from each variable to the field of the generated secret that supplies it, and the entry is complete

#### Scenario: Application reads a single connection URL

- **WHEN** the analysis recorded a single URL-shaped connection variable and the datastore is marked `create`
- **THEN** the plan reports that a generated secret cannot supply an assembled URL and names both resolutions — supply an existing secret holding the URL, or accept the discrete variables and adapt the application — and the entry stays incomplete until one is chosen

#### Scenario: An adopted secret satisfies the URL case

- **WHEN** the user supplies an existing secret whose value is the connection URL
- **THEN** the entry is complete, the datastore is still created, and the secret is injected by reference as any other recorded secret is

#### Scenario: Credential mapping never records a value

- **WHEN** the credential mapping is recorded
- **THEN** it names variables, secret fields, and the secret's location only, and no credential value is read or written

### Requirement: Created table key schema must be confirmed

The system SHALL NOT accept a `create` decision on a DynamoDB table whose key schema is below high confidence and unconfirmed by the user, because a table's key schema cannot be changed after the table exists.

#### Scenario: Key schema derived at high confidence

- **WHEN** the analysis recorded the partition key, its type, and any sort key at high confidence
- **THEN** `create` is available and the recorded schema is used

#### Scenario: Key schema unconfirmed

- **WHEN** the key schema is below high confidence and the user has not confirmed it
- **THEN** the entry stays incomplete and the system asks for the key schema, rather than creating a table on a defaulted key

#### Scenario: Key schema is not required to adopt

- **WHEN** the table entry is marked `adopt`
- **THEN** no key schema is required, because the existing table already has one

### Requirement: Endpoint set derived after the datastore decisions

The system SHALL derive the `vpc-endpoints` entry after the datastore create-or-adopt decisions are settled, so that a service a created datastore forces the task to reach is included.

#### Scenario: A created database adds a secrets endpoint requirement

- **WHEN** the egress classification is `none` and a relational database is marked `create`, producing a generated secret the container did not previously need
- **THEN** the endpoint set includes Secrets Manager, because on Fargate the credential fetch leaves through the task's own network interface and an isolated task without that endpoint cannot start

#### Scenario: Endpoint entry reflects the settled decisions

- **WHEN** a datastore decision changes the set of AWS services the task must reach
- **THEN** the `vpc-endpoints` entry is recomputed before the plan is presented, rather than derived from the egress analysis alone

