# workload-analysis Specification

## Purpose
Derives an evidence-backed profile of a containerized application from its Dockerfile, source, tests, and
configuration — inbound ports and health checks, outbound calls and whether they leave the VPC, hostnames and DNS,
datastores, and the configuration and secrets the container reads. Every inference carries the file and line that
supports it and a confidence level, so a wrong guess is visible and correctable before any infrastructure exists.

## Requirements
### Requirement: Dockerfile analysis

The system SHALL parse the target repository's Dockerfile and record the base image, target architecture, build stages, build arguments, entrypoint/command, exposed ports, and the set of paths copied into the build context.

#### Scenario: Single exposed port

- **WHEN** the Dockerfile contains exactly one `EXPOSE` instruction
- **THEN** that port is recorded as the container port with high confidence and no question is asked about it

#### Scenario: Multiple exposed ports

- **WHEN** the Dockerfile contains more than one `EXPOSE` instruction
- **THEN** all ports are recorded and the user is asked which port receives inbound traffic from the load balancer

#### Scenario: No exposed port

- **WHEN** the Dockerfile contains no `EXPOSE` instruction
- **THEN** the system infers candidate ports from listener calls and port-related environment variable defaults in the source, and asks the user to confirm

#### Scenario: Architecture inference

- **WHEN** the base image or a `--platform` flag identifies a CPU architecture
- **THEN** that architecture is recorded for the Fargate runtime platform, and when no architecture is identifiable the user is asked

### Requirement: Build validation

The system SHALL attempt to build the container image from the Dockerfile and its context before generating any infrastructure, and SHALL NOT proceed to generation when the build fails.

#### Scenario: Build succeeds

- **WHEN** the image builds successfully
- **THEN** the build is recorded as validated and analysis continues

#### Scenario: Build fails

- **WHEN** the image build fails
- **THEN** the system reports the build error to the user and stops without generating infrastructure or modifying the Dockerfile

### Requirement: Inbound surface analysis

The system SHALL scan application source and tests to identify the HTTP framework in use, the port the application listens on, registered routes, and any endpoint suitable for a load balancer health check.

#### Scenario: Health check endpoint found

- **WHEN** the source registers a route matching a health-check convention and tests assert a 2xx response from it
- **THEN** that path is recorded as the health check path with high confidence

#### Scenario: No health check endpoint

- **WHEN** no health-check route can be identified
- **THEN** the system offers the user the choice of a TCP health check or supplying a path, and records the choice

#### Scenario: Listener port disagrees with Dockerfile

- **WHEN** the port the application binds to differs from the port declared by `EXPOSE`
- **THEN** the conflict is recorded as a finding and the user is asked to resolve it before generation

### Requirement: Outbound and external call analysis

The system SHALL classify the application's outbound network calls as either resolvable within the VPC or requiring egress to the public internet, and SHALL record the evidence supporting each classification.

#### Scenario: No external calls detected

- **WHEN** every outbound call resolves to an AWS service endpoint or a VPC-internal host
- **THEN** the workload is classified as requiring no public egress and the evidence is recorded

#### Scenario: External call detected

- **WHEN** a call to a public third-party endpoint is found
- **THEN** the workload is classified as requiring public egress, and the specific file, line, and endpoint that forced the classification are recorded

#### Scenario: AWS service usage recorded for endpoints

- **WHEN** the scan identifies which AWS services the application calls
- **THEN** the set of services is recorded so that VPC interface endpoints can be provisioned for exactly those services

### Requirement: Hostname and DNS analysis

The system SHALL scan the repository for hardcoded hostnames, service-discovery names, and candidate public domain names for the service.

#### Scenario: Candidate domain found

- **WHEN** a domain name is found in configuration, documentation, or environment defaults
- **THEN** it is recorded as a candidate public hostname for the service and presented to the user for confirmation

#### Scenario: Internal hostname found

- **WHEN** a hostname is found that does not resolve publicly and appears to reference a sibling service
- **THEN** it is recorded as a service-discovery candidate and the user is asked whether that dependency exists in the target VPC

### Requirement: Datastore analysis

The system SHALL identify datastores the application uses — including RDS/Aurora, DynamoDB, ElastiCache, and S3 — from SDK usage, ORM and migration configuration, connection strings, and environment variable naming.

#### Scenario: Relational database detected

- **WHEN** an ORM configuration, migration directory, or database driver dependency is found
- **THEN** the datastore is recorded with its engine, the evidence supporting it, and a note that it requires network connectivity and credentials

#### Scenario: AWS-native datastore detected

- **WHEN** the application calls an AWS data service through an SDK
- **THEN** the datastore is recorded together with the IAM actions the task role will require

#### Scenario: No datastore detected

- **WHEN** no datastore evidence is found
- **THEN** the system records that the workload appears stateless and asks the user to confirm

### Requirement: Configuration and secret analysis

The system SHALL enumerate the environment variables the container reads, and SHALL classify each as non-sensitive configuration or as a secret that must be injected from Secrets Manager or SSM Parameter Store.

#### Scenario: Secret-like variable identified

- **WHEN** a variable's name or usage indicates a credential, token, or key
- **THEN** it is classified as a secret and the user is asked to supply the Secrets Manager ARN or SSM parameter name

#### Scenario: Secret values are never read

- **WHEN** the repository contains a file holding a secret value
- **THEN** the system records only the variable name and never reads, stores, or reports the value

### Requirement: Evidence and confidence on every finding

Every finding the analysis produces SHALL record the file path and line supporting it and a confidence level, and findings below high confidence SHALL be surfaced to the user as questions rather than resolved by a default.

#### Scenario: Low-confidence finding

- **WHEN** a finding is recorded below high confidence
- **THEN** it appears in the plan as an explicit question with its supporting evidence rather than as a silent default

#### Scenario: Findings are reviewable

- **WHEN** the analysis phase completes
- **THEN** every finding is written to the manifest with its evidence and confidence level

