# infrastructure-generation Specification

## Purpose
Emits a CDK TypeScript application realizing the approved resource plan as two stacks — a platform stack that
changes rarely and a service stack that changes on every deploy — coupled through SSM Parameter Store rather than
CloudFormation exports. The project's shape is a recorded, user-selected choice between a plain CDK app and a
projen AwsCdkTypeScriptApp, and synthesis must succeed with no AWS credentials.
## Requirements
### Requirement: CDK application output

The system SHALL generate an AWS CDK TypeScript application in the target repository that realizes the approved resource plan, in the project style recorded in the manifest, with a pinned CDK version and a synth that requires no AWS credentials.

#### Scenario: Application scaffolded

- **WHEN** generation runs against an approved manifest recording the `plain` style
- **THEN** a CDK app is written with an entry point under `bin/`, stack sources under `lib/`, `cdk.json`, a `package.json` pinning the CDK version, and TypeScript configuration

#### Scenario: Projen application scaffolded

- **WHEN** generation runs against an approved manifest recording the `projen` style
- **THEN** a CDK app is written with `.projenrc.ts` declaring an `AwsCdkTypeScriptApp` at the recorded CDK version, the entry point and stack sources under `src/`, and the remaining project files derived by projen

#### Scenario: Hermetic synth

- **WHEN** `cdk synth` is run on the generated application without AWS credentials
- **THEN** both stacks synthesize successfully, because adopted resources are imported from manifest attributes rather than environment lookups

#### Scenario: Generation is verified per style

- **WHEN** generation completes
- **THEN** the `plain` style is verified with an install, a type-check and a synth of both stacks, the `projen` style is verified with a projen synth and build, and both are verified with no AWS credentials present

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

### Requirement: Generated file ownership

Generated files SHALL be marked as generated and SHALL NOT be overwritten without user confirmation when they have been modified since generation. Files derived by projen SHALL NOT be written or tracked by the system at all.

#### Scenario: File header

- **WHEN** the system writes a file it owns
- **THEN** the file carries a header identifying it as generated and naming the manifest section that controls it

#### Scenario: User-modified file

- **WHEN** regeneration would overwrite a file whose content differs from what was last generated
- **THEN** the system shows the difference and asks the user before writing

#### Scenario: Ownership under the projen style

- **WHEN** the recorded style is `projen`
- **THEN** the system owns and tracks `.projenrc.ts`, the sources under `src/`, and the preflight script, and owns and tracks none of `package.json`, `tsconfig.json`, `cdk.json`, `.gitignore`, `.projen/` or the lockfile

#### Scenario: A projen run is not mistaken for a user edit

- **WHEN** the user runs projen, changing files projen derives, and then re-runs the skill
- **THEN** no overwrite prompt is raised for those files, because the system never recorded a hash for them

#### Scenario: Application source untouched

- **WHEN** generation runs
- **THEN** no application source file and no Dockerfile is modified

### Requirement: Infrastructure project style

The system SHALL support two shapes for the generated CDK application — `plain`, a hand-maintained project, and `projen`, a project derived from an `awscdk.AwsCdkTypeScriptApp` declared in `.projenrc.ts` — SHALL ask the user which to generate, and SHALL record the answer in the manifest.

#### Scenario: Style is asked, not inferred

- **WHEN** the planning phase collects generation choices
- **THEN** the user is asked for the project style, batched with the pipeline-target question, and the answer is not derived from projen configuration found elsewhere in the repository

#### Scenario: Default when the user expresses no preference

- **WHEN** the user does not choose a style
- **THEN** `plain` is generated

#### Scenario: Choice recorded

- **WHEN** the user chooses a style
- **THEN** the manifest records it, and generation reads the style from the manifest rather than from the state of the working tree

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

### Requirement: Projen project generation

When the recorded style is `projen`, the system SHALL bootstrap the project with projen, write `.projenrc.ts` from the skill's template, place the stack sources under `src/`, and let projen derive the remaining project files.

#### Scenario: Bootstrap then overwrite

- **WHEN** the projen style is generated
- **THEN** the project is bootstrapped with `projen new awscdk-app-ts` pinned to the recorded CDK version, and `.projenrc.ts` is overwritten from the template afterwards, because the bootstrap writes its own

#### Scenario: Expected bootstrap exit code

- **WHEN** the bootstrap command exits non-zero because it linted an empty source directory
- **THEN** generation continues, because the project files were written, and the command is not retried with different options and no sample code is added

#### Scenario: Derived files come from projen

- **WHEN** generation completes under the projen style
- **THEN** `package.json`, `tsconfig.json`, `cdk.json`, `.gitignore`, `.projen/` and the lockfile exist and were produced by projen, not written by the skill

#### Scenario: Bootstrap leftovers removed

- **WHEN** the bootstrap leaves an empty workflow directory under the infrastructure project
- **THEN** it is removed, because GitHub reads workflows only at the repository root and an empty one reads like a live pipeline

#### Scenario: Committed lockfile for the pipeline

- **WHEN** the projen style is generated
- **THEN** the project uses npm and a lockfile is committed, so the pipeline's `npm ci` has something to install from

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

