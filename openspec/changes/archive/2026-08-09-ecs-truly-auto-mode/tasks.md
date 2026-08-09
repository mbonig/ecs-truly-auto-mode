## 1. Project scaffolding

- [x] 1.1 Create the repository layout: `skills/ecs-truly-auto-mode/` for the skill package, `templates/` for the CDK and pipeline source the generator emits, and `examples/` for fixture applications
- [x] 1.2 Write the root `README.md` describing what the skill does, its four phases, and how to install it into a Claude Code project
- [x] 1.3 Add repository tooling: `.gitignore`, license, and a `package.json` for the scripts used to validate the emitted templates

## 2. Manifest schema

- [x] 2.1 Define the manifest schema covering schema version, target account/region, analysis findings with evidence and confidence, create-or-adopt decisions with identifiers, the pipeline target, and the generated-file record used for overwrite detection
- [x] 2.2 Write `references/manifest-schema.md` documenting every field, its allowed values, and which generation output it controls
- [x] 2.3 Add a JSON Schema for the manifest and a validation script so hand-edited manifests can be checked
- [x] 2.4 Write a fully-populated example manifest covering both a created-VPC case and an adopted-VPC case

## 3. Analysis references

- [x] 3.1 Write `references/analysis/dockerfile.md`: parsing rules for ports, architecture, stages, build args, entrypoint, and build-context paths, including the port-conflict and no-EXPOSE cases
- [x] 3.2 Write `references/analysis/ecosystems.md`: per-ecosystem signals for Node, Python, Go, Java, and Ruby covering listener calls, route registration, health-check conventions, ORM/migration config locations, AWS SDK import names, and env var conventions
- [x] 3.3 Write `references/analysis/egress.md`: the procedure for classifying calls as VPC-internal or public, the AWS-service-to-VPC-endpoint mapping, and the rule for which finding forces NAT
- [x] 3.4 Write `references/analysis/datastores.md`: detection signals per datastore and the IAM actions each implies for the task role
- [x] 3.5 Write `references/analysis/secrets.md`: classification rules for config versus secret, and the prohibition on reading secret values
- [x] 3.6 Define the finding record format — inferred value, file, line, confidence — and the rule that anything below high confidence becomes a question

## 4. Planning references

- [x] 4.1 Write `references/planning/resource-catalog.md`: every resource the plan can contain, what triggers its inclusion, and what identifier is required to adopt it
- [x] 4.2 Write `references/planning/plan-presentation.md`: the plan's format, its ordering by consequence, and the requirement to state the egress classification and its evidence as a headline item
- [x] 4.3 Write `references/planning/adopt-validation.md`: how to verify each adopted identifier against AWS when credentials are available, and what to do when validation fails or credentials are absent
- [x] 4.4 Write the incremental re-planning procedure: diffing re-analysis against the manifest, presenting old-versus-new with evidence, and asking only about what changed

## 5. Platform stack template

- [x] 5.1 Write the platform stack CDK source with created networking, subnet configuration driven by the egress classification, and no NAT gateway on the isolated path
- [x] 5.2 Add the adopted-networking path using `fromVpcAttributes` and equivalents, sourced from manifest values with no environment lookups
- [x] 5.3 Add VPC interface endpoints provisioned from the analysis's AWS-service list
- [x] 5.4 Add the cluster, ECR repository with a lifecycle policy, log group, and security groups
- [x] 5.5 Add load balancing, the target group, and the certificate and DNS record paths for created and adopted cases
- [x] 5.6 Add the task and execution roles, with task-role permissions generated from the detected datastores
- [x] 5.7 Publish every value the service stack needs as SSM parameters under the manifest's path prefix
- [x] 5.8 Verify `cdk synth` succeeds with no AWS credentials for both the created and adopted variants

## 6. Service stack template

- [x] 6.1 Write the service stack CDK source containing only the task definition and ECS service, with the image tag as a CloudFormation parameter
- [x] 6.2 Resolve all platform values from SSM and confirm the synthesized template declares no `Fn::ImportValue`
- [x] 6.3 Wire the health check from the analysis result, supporting both the HTTP-path and TCP cases
- [x] 6.4 Inject secrets by reference through the execution role and assert no secret value appears in the synthesized template
- [x] 6.5 Set the Fargate runtime platform from the analyzed architecture
- [x] 6.6 Verify the synthesized service stack contains no networking, cluster, registry, load balancer, or IAM role resources

## 7. Pipeline templates

- [x] 7.1 Write `references/pipeline/contract.md` defining the shared step sequence both targets implement: path-filtered trigger, build, push with SHA tag, SSM preflight, deploy service stack
- [x] 7.2 Write the SSM preflight script that asserts every required parameter exists and fails naming the missing one
- [x] 7.3 Write the GitHub Actions workflow template with OIDC role assumption, a derived path filter, and no stored AWS access key
- [x] 7.4 Write the CodePipeline/CodeBuild template — pipeline, build project, artifact bucket, source connection — as platform stack additions
- [x] 7.5 Write the least-privilege deploy role policy scoped to the ECR repository, the service stack, and the manifest's SSM path prefix
- [x] 7.6 Implement path-filter derivation from the build context, dependency manifests, lockfiles, and service stack source
- [x] 7.7 Verify both targets produce the same image tag and the same service stack change for a given commit

## 8. Skill package

- [x] 8.1 Write `SKILL.md` with the trigger description, the four-phase flow, and the decision points, deferring detail to `references/`
- [x] 8.2 Implement the analysis phase instructions, including build validation and the stop-on-build-failure rule
- [x] 8.3 Implement the planning phase instructions, including plan presentation, adopt-or-create collection, and the gate that blocks generation until the plan is complete and approved
- [x] 8.4 Implement the generation phase instructions, including generated-file headers and the diff-before-overwrite check
- [x] 8.5 Implement the pipeline phase instructions and target selection
- [x] 8.6 Implement resume detection: read the manifest, determine the phase to resume at, and handle an unrecognized schema version by stopping
- [x] 8.7 Implement the escalation rules — batched questions ordered by consequence, confident findings stated as defaults, conflicts presented with evidence
- [x] 8.8 Implement the completion handoff: generated files, platform stack deploy command, how the pipeline deploys the service stack, and adopted resource dependencies

## 9. Fixture applications

- [x] 9.1 Build a minimal Node/Express fixture: single `EXPOSE`, `/health` route with a test, no external calls, no datastore
- [x] 9.2 Build a Python/FastAPI fixture with an RDS connection via an ORM and a secret-bearing env var
- [x] 9.3 Build a Go fixture with a public third-party API call, to exercise the NAT-required path
- [x] 9.4 Build an ambiguous fixture: multiple `EXPOSE` ports, a listener port that disagrees with the Dockerfile, and no health route, to exercise escalation
- [x] 9.5 Build a fixture with a failing Dockerfile build, to exercise the stop-on-build-failure rule

## 10. Validation

- [x] 10.1 Run the skill end to end against each fixture and record the resulting manifests as expected output
- [x] 10.2 Verify the isolated-subnet fixture synthesizes with no NAT gateway and with endpoints for exactly the services it uses
- [x] 10.3 Verify the ambiguous fixture produces questions rather than defaults for each conflicting finding
- [x] 10.4 Verify resume: interrupt after plan approval, re-invoke, and confirm it resumes at generation without re-asking
- [x] 10.5 Verify incremental re-run: change a fixture's port, re-invoke, and confirm the old-versus-new diff and a targeted regeneration
- [x] 10.6 Verify overwrite protection: hand-edit a generated file, re-invoke, and confirm the diff prompt
- [x] 10.7 Run `cfn-lint` over every synthesized template from every fixture
- [x] 10.8 Deploy one fixture's platform and service stacks to a real account, run the pipeline, and confirm the service serves traffic and rolls forward on a second commit

## 11. Documentation

- [x] 11.1 Write a getting-started guide walking through one fixture from invocation to a running service
- [x] 11.2 Document the two-stack model, why SSM couples them, and how to deploy each
- [x] 11.3 Document how to adopt existing resources, including the identifiers required for each
- [x] 11.4 Document how to edit generated CDK safely and how the overwrite check behaves
- [x] 11.5 Document the known limits from the design's non-goals and risks — missed external calls, missed datastores, and manifest drift
