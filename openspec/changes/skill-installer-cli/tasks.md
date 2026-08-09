## 1. projen conversion

- [x] 1.1 Add `projen` as a development dependency and author `.projenrc.ts` defining a `typescript.TypeScriptProject` with `projenrcTs`, the package name `@matthewbonig/ecs-truly-auto-mode-skill`, the MIT license and author, `minNodeVersion` 20, `defaultReleaseBranch` `main`, and sample code disabled
- [x] 1.2 Reproduce the current `.gitignore` in `.projenrc.ts`, carrying over the CDK build-output rules scoped to `templates/cdk/**` **and the comment explaining why they are not a blanket `*.js` rule**, plus `.env` handling and the `worktrees/`, `.idea/`, `.vscode/` entries
- [x] 1.3 Re-declare the five existing validation scripts as projen tasks (`validate:manifest`, `validate:examples`, `verify:pipelines`, `verify:resume`, `verify:fixtures`) keeping their `scripts/*.mjs` implementations unchanged, and wire them into the test task
- [x] 1.4 Carry over the remaining development dependencies (`ajv`, `ajv-formats`, `yaml`) and the `lint:cfn` and `derive:filter`/`generate:config` entry points as tasks
- [x] 1.5 Run `npx projen`, then diff the generated `package.json` against the previous one field by field and confirm nothing was silently dropped
- [x] 1.6 Confirm the full suite passes unchanged after conversion, before any CLI work begins
- [x] 1.7 Verify regeneration is reproducible: run `npx projen` twice and confirm the second run leaves every generated file byte-identical
- [x] 1.8 Confirm projen's build workflow fails on generated-file drift, by committing a `.projenrc.ts` change without synthing and observing the failure
- [x] 1.9 Decide and record whether projen's dependency-upgrade and pull-request-lint workflows stay enabled

## 2. Package shape

- [x] 2.1 Declare `bin.ecs-truly-auto-mode` pointing at the compiled CLI entry point in `lib/`, and add repository, homepage, and keyword metadata in `.projenrc.ts`
- [x] 2.2 Set npm ignore rules so `skills/`, `templates/`, and `schemas/` ship while `src/`, `test/`, `examples/`, `openspec/`, and `docs/` do not
- [x] 2.3 Create `src/cli.ts` with a `#!/usr/bin/env node` shebang, confirm the shebang survives compilation, and confirm the compiled entry point runs under Node 20
- [x] 2.4 Add `skills/ecs-truly-auto-mode/skill.json` declaring the skill name and its `templates` → `assets/templates` and `schemas` → `assets/schemas` asset copies
- [x] 2.5 Ignore `skills/*/assets/` and `skills/*/.installed.json` in the generated `.gitignore` so a locally materialized skill is never committed

## 3. Skill discovery and packaging

- [x] 3.1 Implement discovery: enumerate directories under the package's `skills/`, treat those containing `SKILL.md` as installable, ignore the rest, and resolve the package root correctly whether run from `lib/` in the repo or from an extracted tarball
- [x] 3.2 Implement asset resolution from `skill.json`, defaulting to no assets when the file is absent, and failing with a clear message when a declared `from` directory does not exist
- [x] 3.3 Implement the install record: write `.installed.json` into the installed skill directory with the skill name, package name, and package version read from the package's own `package.json`, tolerating the `0.0.0` placeholder in a working tree
- [x] 3.4 Add a `skills:materialize` projen task that copies declared assets into `skills/<name>/assets/` for in-repo development

## 4. Skill asset path rewrite

- [x] 4.1 Rewrite `SKILL.md` Phase 3 and Phase 4 to reference `./assets/templates/cdk/` and `./assets/templates/pipeline/github-actions/` instead of the repo-relative paths
- [x] 4.2 Sweep `skills/ecs-truly-auto-mode/references/**` for repo-relative paths — including the manifest JSON Schema reference — and rewrite each to `./assets/...`
- [x] 4.3 Verify by materializing assets locally and resolving every relative path referenced by `SKILL.md` and the reference documents against the skill directory

## 5. CLI argument and target resolution

- [x] 5.1 Parse arguments with `node:util` `parseArgs`: commands `install`, `list`, `uninstall`; flags `--user`, `--project`, `--dir`, `--force`, `--dry-run`, `--help`, `--version`; default to `install` when no command is given
- [x] 5.2 Reject unknown commands and unknown flags with usage output and a non-zero exit, writing nothing
- [x] 5.3 Resolve the install target: `--dir` explicit path, `--user` → `~/.claude/skills`, `--project` → `<cwd>/.claude/skills`; reject more than one target flag with a non-zero exit
- [x] 5.4 Implement the interactive target prompt with `node:readline`, gated on `process.stdin.isTTY`, defaulting to user-global on an empty answer; skip the prompt entirely when not a TTY
- [x] 5.5 Print the resolved destination on every run, including non-interactive ones

## 6. Install command

- [x] 6.1 Resolve requested skill names against discovery — all shipped skills when none are named — and fail with the unknown name plus the available names before writing anything
- [x] 6.2 Implement the pre-write validation pass: check every requested skill for an existing installed directory and, without `--force`, refuse the whole batch naming the blocking skill and reporting installed versus incoming versions (including the same-version case)
- [x] 6.3 Create the destination directory and any missing parents, and sweep stale `.<name>.tmp-*` directories left by an interrupted run
- [x] 6.4 Implement staged copy: write the skill directory and its declared assets into `.<name>.tmp-<pid>` inside the destination, then rename into place; on `--force`, rename the existing directory aside first and remove it only after the new one is in place
- [x] 6.5 Clean up the staging directory on any failure so no partially written skill directory is left behind, and report the failing path and reason with a non-zero exit
- [x] 6.6 Implement `--dry-run`: print the destination and the directories that would be created, replaced, or removed — including the overwrite conflict a real run would report — and write nothing
- [x] 6.7 Print the success report: destination, each installed skill and version, and how to confirm the skill is available in Claude Code

## 7. List and uninstall commands

- [x] 7.1 Implement `list`: every shipped skill with its packaged version, plus installed status and version read from `.installed.json` at the resolved target, without creating the destination directory
- [x] 7.2 Implement the shallow version comparison and its `outdated` / `differs` / up-to-date labels
- [x] 7.3 Implement `uninstall`: require at least one skill name, remove the named installed directories, and leave other installed skills untouched
- [x] 7.4 Make `uninstall` exit non-zero when a named skill is not installed, and refuse — with an explanation — to remove a directory that has no `.installed.json` for this package
- [x] 7.5 Support `--dry-run` on `uninstall`

## 8. Tests

- [x] 8.1 Set up the jest suite to invoke the compiled CLI as a subprocess against a temporary destination, asserting on stdout, stderr, and exit code
- [x] 8.2 Cover target resolution: interactive default, interactive project choice, non-TTY default with no prompt, `--dir`, and conflicting target flags
- [x] 8.3 Cover skill selection: named skill, all skills, unknown name, and the unknown-name case writing nothing
- [x] 8.4 Cover overwrite protection: refusal without `--force`, the same-version refusal, replacement with `--force` leaving no stale file, and the blocked multi-skill batch installing nothing
- [x] 8.5 Cover `--dry-run` for install and uninstall, asserting the filesystem is unchanged in both the clean and conflicting cases
- [x] 8.6 Cover `list` output for not-installed, up-to-date, and outdated states, and assert `list` creates no directory
- [x] 8.7 Cover `uninstall`: success, not-installed, missing name, and the refusal to remove a directory without an install record
- [x] 8.8 Cover failure handling: a non-writable destination exits non-zero and leaves no partial skill directory
- [x] 8.9 Assert scope of effects: no Claude Code settings file is created or modified, and neighboring skill directories at the destination are unchanged
- [x] 8.10 Add a fixture second skill so discovery, multi-skill install, and "a new skill needs no installer change" are exercised

## 9. Packaging verification

- [x] 9.1 Write the packaging check script: compile, `npm pack`, extract the tarball to a temp directory, run **the packed CLI** from it with `--dir <tmp>`, and assert the install succeeds
- [x] 9.2 Extend the check to walk the installed `SKILL.md` and every file under the installed `references/` for relative path references and assert each resolves inside the installed skill directory, failing with the offending file, line, and path
- [x] 9.3 Assert the packed artifact excludes `src/`, `test/`, `examples/`, `openspec/`, and `docs/`, and includes `lib/`, `skills/`, `templates/`, and `schemas/`
- [x] 9.4 Wire the packaging check into the projen test task

## 10. Documentation

- [x] 10.1 Rewrite the README install section to lead with `npx ecs-truly-auto-mode install`, documenting `--user`, `--project`, `--dir`, `--force`, `--dry-run`, `list`, and `uninstall`
- [x] 10.2 Keep the manual copy documented as a fallback, corrected to include the asset step
- [x] 10.3 Add a development section covering `npx projen`, that generated files are not to be hand-edited, and that CI fails on drift
- [x] 10.4 Update the repository layout table for `src/`, `.projenrc.ts`, and the note that `templates/` and `schemas/` ship inside an installed skill as `assets/`
- [x] 10.5 Document the release process: merging to `main` releases, the version comes from git tags rather than `package.json`, and nothing is bumped by hand
- [x] 10.6 Note the **BREAKING** `SKILL.md` asset-path change for anyone who copied the skill by hand, and that `package.json` is now generated
- [x] 10.7 Document the repository prerequisites — the `NPM_TOKEN` automation token secret, and that the repository must be public for provenance

## 11. First publish

- [ ] 11.1 Add the `NPM_TOKEN` repository secret as an npm **automation** token, and confirm the repository is public
- [x] 11.2 Inspect `npm pack --dry-run` output by hand against the ignore rules
- [ ] 11.3 Publish the first version manually to claim the name and establish the baseline the automation increments from
- [ ] 11.4 Verify the published package end to end: `npx @matthewbonig/ecs-truly-auto-mode-skill install --dir <tmp>` from a clean npx cache, then confirm the installed skill's referenced paths all resolve

## 12. Release automation

- [x] 12.1 Enable projen's release component in `.projenrc.ts`: `releaseToNpm`, a continuous trigger on `main`, public npm access, and the default `NPM_TOKEN` secret; synth and review the generated release workflow
- [x] 12.2 Confirm provenance is enabled for the public package and that the generated workflow requests an OIDC token
- [x] 12.3 Confirm the generated release runs the full test suite — including the packaging check and the drift check — before the publish step
- [ ] 12.4 Verify on the first automated release: the version is published, the tag and GitHub release exist, the published version carries a provenance attestation, and **no commit was pushed to `main`**
- [ ] 12.5 Verify the no-op path: re-running the release on an already-released commit publishes nothing and does not fail
- [ ] 12.6 Verify the negative path by landing a commit that fails the suite: nothing is published, no tag is pushed, and the run fails
