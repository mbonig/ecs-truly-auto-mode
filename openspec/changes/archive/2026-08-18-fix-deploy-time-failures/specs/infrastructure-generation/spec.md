## MODIFIED Requirements

### Requirement: Service stack

The system SHALL generate a service stack containing only the task definition and the ECS service, taking the container image tag as a CloudFormation parameter. The ECS service SHALL be given a deterministic name matching the application name, so that other generated resources can address it by name rather than by a CloudFormation-generated physical ID.

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

#### Scenario: Deterministic service name

- **WHEN** the service stack is synthesized
- **THEN** the `ecs.FargateService` is declared with `serviceName` set to the application name, rather than left to the CloudFormation-generated default, so that the deploy permissions' `EcsService` IAM statement and the pipeline's "wait for steady state" step address a service that actually exists under that name

### Requirement: Platform stack

The system SHALL generate a platform stack containing the resources that change rarely: networking, the ECS cluster, the ECR repository, load balancing, security groups, log groups, certificates and DNS records, and the task and execution roles. When the recorded pipeline target is `github-actions`, the platform stack SHALL also contain the GitHub OIDC-trusted deploy role, wired from the task role, execution role, cluster, and repository already in scope in the stack.

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

#### Scenario: GitHub OIDC role included for the github-actions target

- **WHEN** the platform stack is generated with the recorded pipeline target `github-actions`
- **THEN** the stack instantiates the GitHub OIDC-trusted deploy role using the task role, execution role, cluster, and repository already constructed in the same stack, without requiring them to be exposed as public stack properties

#### Scenario: No GitHub OIDC role for the codepipeline target

- **WHEN** the platform stack is generated with the recorded pipeline target `codepipeline`
- **THEN** the stack instantiates no GitHub OIDC role, because CodePipeline authenticates through a CodeStar connection rather than GitHub OIDC

### Requirement: Equivalence across project styles

The stacks and the CloudFormation they synthesize SHALL be identical under both project styles for a given, fixed pipeline target. Only the scaffolding around them and the location of the sources may differ between `plain` and `projen`. This equivalence does not extend across pipeline targets: a `github-actions`-target platform stack and a `codepipeline`-target platform stack for the same application are expected to differ by the presence of the GitHub OIDC role.

#### Scenario: Same stack sources

- **WHEN** infrastructure is generated under either style for the same recorded pipeline target
- **THEN** the platform stack, service stack, configuration types, generated configuration values, and deploy-permissions sources are identical

#### Scenario: Same synthesized template

- **WHEN** the same manifest is generated under `plain` and under `projen` and both are synthesized
- **THEN** the resulting CloudFormation templates are equivalent

#### Scenario: Entry points kept in step

- **WHEN** the repository's checks run
- **THEN** they fail if the plain entry point and its projen twin differ by anything other than import paths, or if the CDK version the projen template pins differs from the `aws-cdk-lib` floor the plain template pins

#### Scenario: Equivalence is scoped to a fixed pipeline target

- **WHEN** the same manifest is generated once with `pipeline.target: github-actions` and once with `pipeline.target: codepipeline`
- **THEN** the platform stacks are expected to differ by the presence of the GitHub OIDC role, and this difference does not violate the equivalence-across-styles requirement
