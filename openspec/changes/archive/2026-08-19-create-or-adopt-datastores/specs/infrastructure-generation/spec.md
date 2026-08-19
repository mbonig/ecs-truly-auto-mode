## ADDED Requirements

### Requirement: Datastore provisioning in the platform stack

The platform stack SHALL define every datastore the plan marks `create`, and SHALL import every datastore the plan marks `adopt`. Created datastores SHALL carry a removal policy that retains them, and created relational and document databases SHALL also carry deletion protection. A created network-reached datastore SHALL get a security group owned by this stack, with the task security group admitted to it; an adopted one SHALL keep the ingress rule added to the security group recorded in the plan. Synthesis SHALL require no AWS credentials in either case.

#### Scenario: Created relational database

- **WHEN** the plan marks the `database` entry `create`
- **THEN** the platform stack defines a single-instance relational database for the recorded engine, in the application subnets, with the instance class, storage, and availability shape recorded in the entry's `parameters`

#### Scenario: Adopted relational database

- **WHEN** the plan marks the `database` entry `adopt`
- **THEN** the platform stack defines no database and adds an ingress rule from the task security group to the recorded security group on the recorded port, unchanged from the behavior before created databases existed

#### Scenario: Created datastore security group is owned here

- **WHEN** a network-reached datastore is created
- **THEN** its security group is defined in this stack and admits the task security group on the engine port, rather than mutating a group belonging to someone else

#### Scenario: Created cache and document database

- **WHEN** the plan marks the `cache` or a document database entry `create`
- **THEN** the platform stack defines it with the node type, engine, and replica or instance count recorded in the entry's `parameters`, using the lower-level construct where no higher-level one exists, and says so in the generated code

#### Scenario: Created API-reached resources

- **WHEN** the plan marks a table, bucket, queue, or topic entry `create`
- **THEN** the platform stack defines it with the shape recorded for it — a table with the recorded key schema and queried indexes, a bucket with encryption and no public access, a queue with a dead-letter queue

#### Scenario: Task role scoped to created resources

- **WHEN** an API-reached datastore is created
- **THEN** the task role grants exactly the recorded IAM actions on that created resource's ARN, and no wildcard resource

#### Scenario: Created database credentials are owned by this stack

- **WHEN** a relational or document database is created
- **THEN** the stack creates its credentials as a generated secret, grants the execution role read access to that secret alone, and publishes the secret's ARN — so no secret ARN has to be supplied by the user and no wildcard grant is written

#### Scenario: Hermetic synth with created datastores

- **WHEN** the generated application is synthesized with no AWS credentials and the plan creates datastores
- **THEN** synthesis succeeds, because every created datastore is defined from recorded parameters and every adopted one is imported from recorded identifiers

#### Scenario: A create decision is never silently dropped

- **WHEN** generation runs against a manifest with a datastore marked `create`
- **THEN** the datastore appears in the synthesized template — generation does not skip the entry and emit an application whose task role, security groups, and environment make no mention of it

#### Scenario: Generation reports an incomplete datastore entry

- **WHEN** generation runs against a manifest whose datastore entry is marked `create` with a shape it cannot construct, or `adopt` with missing identifiers
- **THEN** generation states exactly what is missing rather than emitting an application that omits the datastore

### Requirement: Created datastore attributes and credentials reach the container

A created datastore's physical name and endpoint are deploy-time values. The system SHALL deliver them to the container through the platform stack's SSM contract, injecting each as the environment variable the analysis recorded the application reading, and SHALL inject a created database's credentials from the stack-owned secret's fields. No credential value SHALL appear in any synthesized template.

#### Scenario: Created resource name injected as an environment variable

- **WHEN** a table, bucket, queue, or topic is created and the analysis recorded the environment variable naming it
- **THEN** the service stack sets that variable from the platform-published parameter, so the container can name a resource whose physical id did not exist at synth time

#### Scenario: Created database fields injected as secrets

- **WHEN** a database is created and the plan recorded a mapping from connection variables to secret fields
- **THEN** the task definition injects each variable from the corresponding field of the stack-owned secret, through the execution role

#### Scenario: No credential value in the template

- **WHEN** the service stack is synthesized with a created database
- **THEN** the template contains the secret's location and field names only, and no credential value

#### Scenario: The service stack stays stateless

- **WHEN** the service stack is synthesized with created datastores in the plan
- **THEN** it contains no datastore, no security group, and no secret resource — only the task definition and the service, reading published values

## MODIFIED Requirements

### Requirement: Inter-stack contract through SSM

The platform stack SHALL publish the values the service stack needs as SSM parameters under a manifest-defined path prefix, and the service stack SHALL read them from SSM rather than through CloudFormation exports. The published values SHALL include the physical attributes of every created datastore that the container needs to address it, and the ARN of a created database's credentials secret.

#### Scenario: Platform publishes

- **WHEN** the platform stack deploys
- **THEN** it writes SSM parameters for the cluster, subnets, security groups, ECR repository URI, target group, log group, and role ARNs

#### Scenario: Created datastore attributes published

- **WHEN** the platform stack deploys with created datastores
- **THEN** it also writes a parameter for each created datastore attribute the container needs — endpoint address and port, table name, bucket name, queue URL, topic ARN — and for the ARN of a created database's credentials secret

#### Scenario: Service consumes

- **WHEN** the service stack is synthesized
- **THEN** it resolves those values from SSM and declares no `Fn::ImportValue` dependency on the platform stack

#### Scenario: Independent deployment

- **WHEN** the service stack is deployed in an environment that has never synthesized the platform stack
- **THEN** the deployment succeeds using only the published SSM parameters
