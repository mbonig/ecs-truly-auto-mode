## ADDED Requirements

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
