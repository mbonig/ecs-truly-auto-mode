## ADDED Requirements

### Requirement: CDK application output

The system SHALL generate an AWS CDK TypeScript application in the target repository that realizes the approved resource plan, with a pinned CDK version and a synth that requires no AWS credentials.

#### Scenario: Application scaffolded

- **WHEN** generation runs against an approved manifest
- **THEN** a CDK app is written with an entry point, `cdk.json`, a `package.json` pinning the CDK version, and TypeScript configuration

#### Scenario: Hermetic synth

- **WHEN** `cdk synth` is run on the generated application without AWS credentials
- **THEN** both stacks synthesize successfully, because adopted resources are imported from manifest attributes rather than environment lookups

### Requirement: Platform stack

The system SHALL generate a platform stack containing the resources that change rarely: networking, the ECS cluster, the ECR repository, load balancing, security groups, log groups, certificates and DNS records, and the task and execution roles.

#### Scenario: Created networking

- **WHEN** the plan marks the VPC as created
- **THEN** the platform stack defines a VPC whose subnet configuration matches the egress classification from the analysis

#### Scenario: Adopted networking

- **WHEN** the plan marks the VPC as adopted
- **THEN** the platform stack imports it using the identifiers and availability zones recorded in the manifest, and creates no VPC

#### Scenario: No public egress required

- **WHEN** the analysis classified the workload as requiring no public egress
- **THEN** the platform stack places the service in isolated subnets, provisions no NAT gateway, and provisions VPC interface endpoints for exactly the AWS services the analysis identified

#### Scenario: Public egress required

- **WHEN** the analysis classified the workload as requiring public egress
- **THEN** the platform stack places the service in private subnets with NAT

#### Scenario: Task role permissions

- **WHEN** the analysis identified AWS data services the application calls
- **THEN** the task role grants exactly the actions those services require on the resources in the plan

### Requirement: Service stack

The system SHALL generate a service stack containing only the task definition and the ECS service, taking the container image tag as a CloudFormation parameter.

#### Scenario: Image tag parameterized

- **WHEN** the service stack is synthesized
- **THEN** it declares an image tag parameter and the task definition references the ECR repository at that tag

#### Scenario: Stack scope is limited

- **WHEN** the service stack is synthesized
- **THEN** it contains no networking, cluster, registry, load balancer, or IAM role resources

#### Scenario: Health check wired

- **WHEN** the analysis produced a health check path
- **THEN** the target group health check uses that path, and uses a TCP check when the user chose one instead

#### Scenario: Secrets injected by reference

- **WHEN** the plan includes secrets
- **THEN** the task definition injects them through the task execution role from Secrets Manager or SSM, and no secret value appears in the template

### Requirement: Inter-stack contract through SSM

The platform stack SHALL publish the values the service stack needs as SSM parameters under a manifest-defined path prefix, and the service stack SHALL read them from SSM rather than through CloudFormation exports.

#### Scenario: Platform publishes

- **WHEN** the platform stack deploys
- **THEN** it writes SSM parameters for the cluster, subnets, security groups, ECR repository URI, target group, log group, and role ARNs

#### Scenario: Service consumes

- **WHEN** the service stack is synthesized
- **THEN** it resolves those values from SSM and declares no `Fn::ImportValue` dependency on the platform stack

#### Scenario: Independent deployment

- **WHEN** the service stack is deployed in an environment that has never synthesized the platform stack
- **THEN** the deployment succeeds using only the published SSM parameters

### Requirement: Generated file ownership

Generated files SHALL be marked as generated and SHALL NOT be overwritten without user confirmation when they have been modified since generation.

#### Scenario: File header

- **WHEN** the system writes a file it owns
- **THEN** the file carries a header identifying it as generated and naming the manifest section that controls it

#### Scenario: User-modified file

- **WHEN** regeneration would overwrite a file whose content differs from what was last generated
- **THEN** the system shows the difference and asks the user before writing

#### Scenario: Application source untouched

- **WHEN** generation runs
- **THEN** no application source file and no Dockerfile is modified
