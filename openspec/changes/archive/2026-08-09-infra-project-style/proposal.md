## Why

The skill emits exactly one shape of CDK app: a hand-maintained project whose `package.json`, `tsconfig.json` and `cdk.json` are ordinary files. Teams that already standardize on projen get handed a project that is off-convention the moment it lands — they either keep an odd one out or convert it by hand, and a hand conversion of generated code is exactly the edit that makes the next re-run stop and ask about a divergent file. The choice belongs to the user, and it is cheap to offer because it changes only the scaffolding around the stacks, never the stacks themselves.

## What Changes

- Add a user-selected **infrastructure project style** with two values:
  - `plain` — today's output, a hand-maintained CDK app. **The default**, so existing behavior is unchanged for anyone who does not choose otherwise.
  - `projen` — an `infra/.projenrc.ts` declaring an `awscdk.AwsCdkTypeScriptApp`, with `package.json`, `tsconfig.json`, `cdk.json`, `.gitignore`, `.projen/` and the lockfile derived by projen from it.
- Ask for the style in Phase 2, **batched with the pipeline-target question** — neither depends on the analysis, so asking them separately spends two rounds on one decision point. The style is never inferred from a projen file elsewhere in the repository.
- Record the choice in the manifest as an optional `infra` object (`style`, and `cdkVersion` when projen). **An absent `infra` means `plain`**, so manifests written before this change keep describing the app they describe and a resume never silently converts a repository.
- Under `projen`, the stack sources move from `bin/`+`lib/` to `src/`, and `bin/app.ts` gains a sibling `src/main.ts` that differs only in import paths. Everything else — the stacks, the SSM contract, the synthesized CloudFormation — is identical across styles, and that equivalence is the property the change is required to preserve.
- Narrow generated-file ownership under `projen`: the skill owns `.projenrc.ts`, `src/`, and `scripts/ssm-preflight.sh`, and never writes or hash-tracks the files projen derives. Hashing one would make every `npx projen` the user runs look like a user edit and stall the next generation on a diff nobody made.
- Verify per style — `npm ci && npx tsc --noEmit && npx cdk synth '**'` for `plain`, `npx projen && npx projen build` for `projen` — both still with no AWS credentials.
- Adjust the two derived pipeline values that depend on layout: the service-stack path in the trigger filter, and `infra/.projenrc.ts` joining the filter because it pins the CDK version the stack is synthesized with. The deployment contract itself does not change, and **the pipeline never runs projen** under either style.
- Add the projen template to the repository (`templates/cdk-projen/`), a reference document covering the style decision, and repository checks that hold the two styles equivalent.

Not breaking: no existing manifest, generated repository, or pipeline changes behavior.

## Capabilities

### New Capabilities

None — this extends the existing generation flow rather than adding a capability.

### Modified Capabilities

- `infrastructure-generation`: The generated project's shape becomes a recorded, user-selected choice; adds the projen scaffolding path and its verification command; narrows generated-file ownership to exclude projen-derived files.
- `skill-orchestration`: The manifest gains an optional `infra` section, with an absent value defined to mean `plain` so resume on an existing repository is unchanged.
- `resource-planning`: The presented plan states the generated project's shape alongside the pipeline target, so the user approves it rather than discovering it.
- `pipeline-generation`: The path filter's service-stack entry follows the chosen layout, and gains `.projenrc.ts` under projen; the pipeline is stated to never run projen.

## Impact

- **Skill content**: `SKILL.md` (Phase 2 question, Phase 3 layout and verification, ownership rule, completion instructions), a new `references/generation/iac-style.md`, and edits to `references/manifest-schema.md`, `references/pipeline/contract.md`, `references/planning/plan-presentation.md`, `references/planning/replanning.md`.
- **Templates**: new `templates/cdk-projen/.projenrc.ts` and `templates/cdk-projen/src/main.ts`; `templates/cdk/` is unchanged and remains the source of the stacks for both styles.
- **Schema and checks**: `schemas/manifest.schema.json` gains `infra`; `scripts/derive-path-filter.mjs` takes the service-stack path from the style rather than assuming `infra/lib/service-stack.ts`; a check that `bin/app.ts` and `src/main.ts` stay in step joins `npm test`; an example manifest covering the projen style.
- **Docs**: `docs/getting-started.md` and `docs/editing-generated-code.md` describe both layouts and who owns which files.
- **Consumer repositories**: choosing `projen` adds projen as a devDependency of the generated `infra/` project only. Nothing about the application, the Dockerfile, or the deployed CloudFormation changes.
- **Prerequisite for `projen` only**: network access at generation time for `npx projen@latest new`.
- **Out of scope**: converting an already-generated `plain` app to `projen` in place, any style beyond these two, and the skill repository's own build tooling.
