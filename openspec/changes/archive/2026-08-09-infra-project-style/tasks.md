## 1. Manifest and schema

- [x] 1.1 Add the optional `infra` object to `schemas/manifest.schema.json`: `style` as an enum of `plain` and `projen`, `cdkVersion` as an exact version string required when `style` is `projen`, no additional properties, and the object itself not required
- [x] 1.2 Document `infra` in `skills/ecs-truly-auto-mode/references/manifest-schema.md`: both fields, the rule that an absent `infra` means `plain`, why the field is optional rather than a `schemaVersion` bump, and the rule that projen-derived files never appear in `generated`
- [x] 1.3 Add an example manifest under `examples/manifests/` recording the projen style, with a `generated` list containing `.projenrc.ts`, the `src/` sources and the preflight script, and none of projen's outputs
- [x] 1.4 Confirm `npm run validate:examples` passes for the new fixture and for the two existing manifests that carry no `infra` section

## 2. Projen template

- [x] 2.1 Add `templates/cdk-projen/.projenrc.ts`: an `awscdk.AwsCdkTypeScriptApp` with `APP_NAME`, `CDK_VERSION` and `DEFAULT_BRANCH` placeholders, `projenrcTs`, npm as the package manager, `appEntrypoint: 'main.ts'`, `sampleCode`, `github`, `jest`, `eslint` and `licensed` off, and the same CDK context flags `templates/cdk/cdk.json` sets — each non-obvious option carrying the reason it is set
- [x] 2.2 Add the `deploy:platform` task to the template, mirroring the plain template's script, with the note that projen's own `deploy` task would also deploy the service stack the pipeline owns
- [x] 2.3 Add `templates/cdk-projen/src/main.ts` as the twin of `templates/cdk/bin/app.ts`, differing only in import paths, with a header pointing at its twin
- [x] 2.4 Add the generated-file header to both new template files, naming the manifest sections that control them

## 3. Skill instructions

- [x] 3.1 Write `skills/ecs-truly-auto-mode/references/generation/iac-style.md`: the two styles and what each means, the exact question text, the rule against inferring the style from the repository, the side-by-side layout, the five-step projen generation procedure including the expected non-zero exit from `projen new`, the per-style verification commands, the file-ownership split, what a re-run does, and the two derived pipeline values that change
- [x] 3.2 Update `SKILL.md` Phase 2 to batch the style question with the pipeline-target question, pointing at `iac-style.md`
- [x] 3.3 Update `SKILL.md` Phase 3 to show both layouts, name `templates/cdk-projen/` as the projen source, and give the per-style verification commands
- [x] 3.4 Update the generated-file-ownership rule in `SKILL.md` to exclude projen's outputs, with the reason a recorded hash would stall the next run on a diff nobody made
- [x] 3.5 Update `SKILL.md` Phase 4 for the projen service-stack path and the `.projenrc.ts` filter entry
- [x] 3.6 Update the `SKILL.md` completion section with the per-style platform-stack deploy command, including why `deploy:platform` is used rather than projen's `deploy`
- [x] 3.7 Update `references/planning/plan-presentation.md` with the generated-project section of the plan, stating pipeline target and project style
- [x] 3.8 Update `references/pipeline/contract.md`: the pipeline never runs projen, and the path filter's service-stack and `.projenrc.ts` entries
- [x] 3.9 Update `references/planning/replanning.md` for the recorded style — not re-asked on resume, and a configuration-only change needing no projen run

## 4. Repository checks

- [x] 4.1 Parameterize `scripts/derive-path-filter.mjs` on the project style: take the service-stack path from the style instead of hardcoding `infra/lib/service-stack.ts`, and add `infra/.projenrc.ts` to the filter under projen
- [x] 4.2 Add a script that verifies the two entry points stay in step — `templates/cdk/bin/app.ts` and `templates/cdk-projen/src/main.ts` identical modulo import paths and header text — and that the template's `CDK_VERSION` placeholder documentation matches the `aws-cdk-lib` floor in `templates/cdk/package.json` with the caret stripped
- [x] 4.3 Wire the new script into `npm test` alongside the existing verification scripts
- [x] 4.4 Extend `scripts/verify-resume.mjs` (or the resume fixtures) with a manifest that has no `infra` section, asserting it resolves to `plain` rather than failing

## 5. Documentation

- [x] 5.1 Update `docs/getting-started.md` with both layouts side by side, the style question, and the per-style deploy command
- [x] 5.2 Update `docs/editing-generated-code.md` with the projen ownership split: edit `.projenrc.ts` and re-run projen rather than editing what projen derives, and note that projen's outputs are never hash-tracked
- [x] 5.3 Update `README.md` to mention the choice of generated project shape
- [x] 5.4 Record the offline-generation limitation in `docs/known-limits.md`: choosing projen requires network access at generation time, and converting an existing plain app in place is out of scope

## 6. End-to-end verification

- [x] 6.1 Generate the projen style against an example application and confirm the five-step procedure works as written, including the expected `projen new` exit code and the leftover-directory cleanup
- [x] 6.2 Confirm `npx projen && npx projen build` succeeds with no AWS credentials present, and that the warnings match the false positives already documented for the plain style
- [x] 6.3 Generate the plain style against the same example and diff the two synthesized templates, confirming they are equivalent
- [x] 6.4 Confirm the derived path filter for the projen run names `infra/src/service-stack.ts` and `infra/.projenrc.ts`, and names neither platform stack path
- [x] 6.5 Run `npx projen` in the generated project, then re-run the skill, and confirm no overwrite prompt is raised for any file projen derives
