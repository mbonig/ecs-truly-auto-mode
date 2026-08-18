## MODIFIED Requirements

### Requirement: Platform stack

The system SHALL generate a platform stack containing the resources that change rarely: networking, the ECS cluster, the ECR repository, load balancing, security groups, log groups, certificates and DNS records, and the task and execution roles. When the recorded pipeline target is `github-actions`, the platform stack SHALL also contain the GitHub OIDC-trusted deploy role, wired from the task role, execution role, cluster, and repository already in scope in the stack. When a public hostname is recorded, the platform stack SHALL either create a DNS-validated ACM certificate or import one by ARN according to the plan's `certificate` decision, and SHALL import the hosted zone once and share it between the certificate's validation and the alias record. The GitHub OIDC-trusted deploy role SHALL trust an existing OpenID Connect provider when the plan records one as adopted, and SHALL create a provider only when the plan records that the account has none.

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

#### Scenario: Created certificate

- **WHEN** a public hostname is recorded and the plan marks the certificate as created
- **THEN** the platform stack defines an ACM certificate for the recorded hostname, validated by DNS against the adopted hosted zone, and attaches it to the HTTPS listener — so no certificate has to exist before the stack is first deployed

#### Scenario: Adopted certificate

- **WHEN** a public hostname is recorded and the plan marks the certificate as adopted
- **THEN** the platform stack imports the certificate by the recorded ARN, defines no certificate resource, and attaches the imported certificate to the HTTPS listener

#### Scenario: Hosted zone imported once

- **WHEN** the platform stack both creates a certificate and creates the alias record
- **THEN** it imports the hosted zone from the recorded identifiers exactly once and shares that construct between the certificate's DNS validation and the alias record

#### Scenario: Certificate creation does not require credentials at synth

- **WHEN** the generated application is synthesized with no AWS credentials and the plan marks the certificate as created
- **THEN** synthesis succeeds, because the hosted zone is imported from recorded attributes rather than looked up in the environment

#### Scenario: Adopted GitHub OIDC provider

- **WHEN** the pipeline target is `github-actions` and the plan marks the OIDC provider as adopted
- **THEN** the platform stack defines no `AWS::IAM::OIDCProvider`, and the deploy role's trust policy names the recorded provider ARN — so a first deploy into an account that already has a GitHub OIDC provider does not fail with `EntityAlreadyExists`

#### Scenario: Created GitHub OIDC provider

- **WHEN** the pipeline target is `github-actions` and the plan marks the OIDC provider as created
- **THEN** the platform stack defines a GitHub OpenID Connect provider for `token.actions.githubusercontent.com` with the `sts.amazonaws.com` client ID, and the deploy role's trust policy names it

#### Scenario: OIDC provider decision reaches the stack

- **WHEN** the manifest records an OIDC provider decision and the generated application is synthesized
- **THEN** the decision is carried from the manifest through the generated pipeline configuration to the platform stack's GitHub OIDC role, under both project styles and through both entry points
