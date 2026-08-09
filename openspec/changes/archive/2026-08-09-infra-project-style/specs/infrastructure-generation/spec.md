## ADDED Requirements

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

The stacks and the CloudFormation they synthesize SHALL be identical under both project styles. Only the scaffolding around them and the location of the sources may differ.

#### Scenario: Same stack sources

- **WHEN** infrastructure is generated under either style
- **THEN** the platform stack, service stack, configuration types, generated configuration values, and deploy-permissions sources are identical

#### Scenario: Same synthesized template

- **WHEN** the same manifest is generated under `plain` and under `projen` and both are synthesized
- **THEN** the resulting CloudFormation templates are equivalent

#### Scenario: Entry points kept in step

- **WHEN** the repository's checks run
- **THEN** they fail if the plain entry point and its projen twin differ by anything other than import paths, or if the CDK version the projen template pins differs from the `aws-cdk-lib` floor the plain template pins

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

## MODIFIED Requirements

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
