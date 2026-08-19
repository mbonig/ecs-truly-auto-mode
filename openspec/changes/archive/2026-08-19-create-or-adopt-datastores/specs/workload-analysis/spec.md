## MODIFIED Requirements

### Requirement: Datastore analysis

The system SHALL identify datastores the application uses — including RDS/Aurora, DynamoDB, DocumentDB, ElastiCache, S3, SQS, and SNS — from SDK usage, ORM and migration configuration, connection strings, and environment variable naming.

For each identified datastore the system SHALL additionally record what a resource the system *creates* would need beyond what an adopted one needs: the key schema and queried indexes of a table, the engine of a relational database, the environment variables the application reads in order to reach the datastore, and whether those variables carry discrete connection fields or a single assembled connection URL. A datastore the system cannot name SHALL be recorded as kind `other`.

#### Scenario: Relational database detected

- **WHEN** an ORM configuration, migration directory, or database driver dependency is found
- **THEN** the datastore is recorded with its engine, the evidence supporting it, and a note that it requires network connectivity and credentials

#### Scenario: AWS-native datastore detected

- **WHEN** the application calls an AWS data service through an SDK
- **THEN** the datastore is recorded together with the IAM actions the task role will require

#### Scenario: No datastore detected

- **WHEN** no datastore evidence is found
- **THEN** the system records that the workload appears stateless and asks the user to confirm

#### Scenario: Queue, topic, and document database are recordable kinds

- **WHEN** the application is found to use SQS, SNS, or DocumentDB
- **THEN** the datastore is recorded under that kind, because a kind the schema rejects cannot be recorded at all and the datastore would be dropped from the plan silently

#### Scenario: Connection variable style recorded

- **WHEN** a network-reached datastore is identified
- **THEN** the system records the environment variables the application reads to reach it and whether they carry discrete fields such as host and port, or a single assembled URL such as `DATABASE_URL`, because the two cannot be satisfied by the same credential source

#### Scenario: Table key schema recorded

- **WHEN** a DynamoDB table is identified and the code names the key attributes it reads and writes
- **THEN** the partition key, any sort key, their types, and any index the code queries are recorded as findings with their evidence and confidence

#### Scenario: Table key schema not derivable

- **WHEN** a DynamoDB table is identified but the key attributes cannot be determined from the code
- **THEN** the key schema is recorded below high confidence, so it becomes a question rather than a default — a table's key schema cannot be changed after the table exists

#### Scenario: Datastore detected with no name to look up

- **WHEN** a datastore is identified from a driver dependency or an environment variable name but no table name, bucket name, or host appears anywhere in the repository
- **THEN** the system records that no identifying name was found, so planning knows there is nothing to look up in the account and asks instead

#### Scenario: Datastore attributes carry evidence

- **WHEN** any of these additional attributes is recorded
- **THEN** it carries the file and line supporting it and a confidence level, exactly as every other finding does
