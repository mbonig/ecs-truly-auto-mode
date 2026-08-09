## Context

See proposal.md — Why. Three constraints shape the approach.

The first is that this repository is not currently shaped like an npm package. `package.json` is `private: true` with no `bin` and no `files`; it exists to run validation scripts. Making it publishable is part of the change, not a given.

The second is the actual defect being fixed. `skills/ecs-truly-auto-mode/SKILL.md:113` says "Sources are in `templates/cdk/`" and line 133 points at `templates/pipeline/github-actions/`. Both are repo-relative. `references/manifest-schema.md` plays the same role for `schemas/manifest.schema.json`. A skill copied into `~/.claude/skills/` has none of these, so the documented install produces a skill that stops working at Phase 3 — after the user has already spent an interactive planning session on it. The installer is only worth writing if it also fixes the layout it installs.

The third is projen. The repository is being converted to a projen-managed `typescript.TypeScriptProject`, which takes ownership of `package.json`, `tsconfig.json`, `.gitignore`, `.npmignore`, and `.github/workflows/`, and brings its own release component. That is not a detail bolted onto the CLI work — it decides the CLI's language, whether there is a build step, how tests are written, and how releases version themselves. Where projen has an opinion, this design follows it; the places it does not are called out below.

Everything the CLI does runs on the user's machine with whatever Node they have. Node >= 20 is already the declared engine, which makes `node:util` `parseArgs` and `fs.cpSync` available without adding a dependency.

## Goals / Non-Goals

**Goals:**

- One command, no clone: `npx @matthewbonig/ecs-truly-auto-mode-skill install`.
- What gets installed works standalone — the install is verified by resolving the installed skill's own references, not by inspecting the source tree.
- Adding a second skill to `skills/` requires no installer change.
- Never surprise someone: no silent overwrite, no writing outside the destination, no touching Claude Code settings.
- No *runtime* dependencies. The install path stays auditable and immune to a transitive-dependency problem in a tool people run with `npx` — a constraint that survives the projen conversion, which adds development dependencies only.
- Configuration that is generated and verified rather than hand-maintained, so a setting cannot drift from what was reviewed.

**Non-Goals:**

- A general-purpose skill installer for arbitrary repositories or a remote catalog. This CLI installs the skills in its own package.
- Migrating an existing hand-copied install. `install --force` overwrites; nothing is merged.
- Registering skills with Claude Code beyond placing the directory. Claude Code discovers skills from the directory; the CLI does not edit configuration.
- Converting `templates/cdk/` — which has its own `package.json` — into a projen subproject. It is source the skill emits, not a build target of this repository.

## Decisions

### 1. Assets are copied into the installed skill at install time, from a per-skill declaration

Each skill directory gains a small `skill.json` declaring the asset directories it needs from the package root:

```json
{
  "name": "ecs-truly-auto-mode",
  "assets": [
    { "from": "templates", "to": "assets/templates" },
    { "from": "schemas",   "to": "assets/schemas" }
  ]
}
```

The installer copies the skill directory, then each declared asset directory into the installed skill. `SKILL.md` is rewritten to reference `./assets/templates/cdk/` and `./assets/schemas/manifest.schema.json`.

*Why a declaration rather than hardcoding:* it is what makes "a new skill needs no installer change" true. The installer reads `skill.json`; it does not know what a template is.

*Why copy at install time rather than committing `skills/*/assets/`:* `templates/` is live source — the test suite synthesizes CloudFormation from it, the ignore rules are scoped to `templates/cdk/**`, and the in-flight `ecs-truly-auto-mode` change's tasks are written against those paths. Committing a second copy under the skill creates two sources of truth that will drift, and moving the originals ripples through the scripts, the ignore rules, the README, and another change's task list for no behavioral gain.

*The cost:* inside this repository, `skills/ecs-truly-auto-mode/assets/` does not exist, so the skill's own paths do not resolve during in-repo development. Mitigated by a `skills:materialize` projen task, which performs the same copy locally into a gitignored `assets/` — and, more importantly, by decision 4, which verifies resolution against a real install rather than against the source tree.

*Alternative considered:* have the skill locate templates by searching upward for a repo root. Rejected — it reintroduces exactly the environment dependence that the generated CDK deliberately avoids (`design.md` decision 4 of the `ecs-truly-auto-mode` change), and it fails first in the user-global install, which is the default.

### 2. Installs are staged and renamed into place

The installer writes into a temporary directory inside the destination (`.<name>.tmp-<pid>`), then renames it onto the final path. With `--force`, the existing directory is renamed aside first and removed only after the new one is in place.

*Why:* it is the only way to honor both "a failed install leaves no half-written skill" and "`--force` leaves no file from the previous install" without a partial-state window. A same-filesystem rename is atomic, and staging inside the destination guarantees same-filesystem.

*Trade-off:* momentarily needs double the skill's disk space, and a crash between rename steps can leave a `.tmp-*` directory behind. The installer sweeps stale `.tmp-*` directories it finds at the destination on the next run.

### 3. Multi-skill installs are validated fully before anything is written

Argument parsing, skill resolution, target resolution, and the existing-install check all run for every requested skill before the first byte is copied.

*Why:* the alternative — install until you hit a conflict — leaves a half-applied batch that the user then has to reason about. The spec's "no skill is installed" outcome for a blocked batch falls straight out of validating first.

*Trade-off:* a failure in the copy phase itself can still leave earlier skills of the batch installed. That is genuinely different from a predictable conflict, and the CLI reports which skills were installed before the failure rather than pretending it was atomic.

### 4. Packaging is verified by installing, not by comparing file lists

The packaging check compiles, runs `npm pack`, extracts the tarball into a temporary directory, runs **the packed CLI** from it with `--dir <tmp>`, then walks the installed `SKILL.md` and every file under `references/` for relative path references and asserts each one resolves inside the installed skill.

*Why:* an ignore list and an asset declaration are two places to forget something, and a static list comparison only catches what someone thought to enumerate. Asserting that the installed artifact's own references resolve is the property that actually matters, and it catches an ignore-rule omission, a bad `skill.json`, and a stale path in `SKILL.md` with one check.

*Why the packed CLI specifically:* once the CLI is compiled (decision 9), running the working tree's sources would verify something that is not what ships. The check must exercise `lib/`, from inside the tarball, or it verifies the wrong artifact — which is exactly the class of bug the whole check exists to catch.

*Trade-off:* slower than a file-list assertion and depends on `npm pack` in the test environment. Acceptable — it runs alongside a suite that already builds Docker images and synthesizes CloudFormation.

### 5. Interactivity is opt-out by detection, not by flag

The prompt is shown only when `process.stdin.isTTY` is true. Otherwise the default target applies and the resolved destination is printed.

*Why:* `npx <pkg> install` piped through a script or run in CI must not hang waiting on a prompt no one can see, and requiring a `--yes` flag to avoid that puts the burden on the caller who is least likely to know.

*Trade-off:* a non-TTY caller who wanted project-local gets user-global. Mitigated by printing the resolved destination on every run, and by `--project` being the explicit answer.

### 6. Version comparison stays deliberately shallow

Versions are compared field-by-field on the numeric dot-separated prefix. Strictly older is reported as *outdated*; anything else that is unequal is reported as *differs*.

*Why:* a semver dependency is not worth carrying for a status column in `list`. The install decision never depends on this comparison — an existing install is refused regardless of version unless `--force` is passed (per the installation spec), so a mis-ranked prerelease costs a slightly wrong word in one line of output and nothing else.

### 7. The install record is written by the installer, not authored by hand

Each installed skill directory gets an `.installed.json` recording the skill name, the package version, and the package name. `list` reads it for the installed version, and `uninstall` refuses to remove a directory that lacks one.

*Why:* it keeps the packaged version single-sourced from `package.json` — nothing to bump twice — and it gives `uninstall` a way to distinguish a skill this CLI placed from a same-named directory the user wrote themselves. Deleting the latter would be the worst thing this tool could do.

*Wrinkle from projen:* in a projen repository the checked-in version is `0.0.0` and the real one is written into the package only during the release build (decision 12). So a CLI run from a working tree records `0.0.0`, and `list` shows `0.0.0` against an installed real version — which the shallow comparison in decision 6 will label *outdated* in the wrong direction. This is accepted rather than worked around: it is visible only to someone running the CLI from a clone, the number shown is literally what the working tree says, and inventing a synthetic dev version would make the install record disagree with the package it came from.

### 8. Package identity

Published as `@matthewbonig/ecs-truly-auto-mode-skill` (verified unclaimed; the `@matthewbonig` scope already exists and is owned by the author, so publish rights come with the account rather than needing a new namespace claimed).

The `bin` is deliberately *not* the package name: it is the short, unscoped `ecs-truly-auto-mode`. `npx @matthewbonig/ecs-truly-auto-mode-skill install` resolves to it regardless of the name — with a single `bin`, npx runs it whatever it is called — and a global install puts a memorable command on the PATH rather than a scoped mouthful.

`npmAccess` is public, which for a scoped package is load-bearing rather than cosmetic: npm defaults `@scope/*` to restricted, so without it the publish either fails outright or, worse, succeeds privately. It is also what makes provenance available by default (decision 13).

### 9. TypeScript, compiled — which reverses "no build step"

The project is a `typescript.TypeScriptProject`. The CLI is written in TypeScript under `src/`, compiled to `lib/`, and `bin` points at the compiled entry point. A shebang at the top of the TypeScript source is preserved by the compiler, so the emitted file is directly executable.

*Why:* the alternative — a projen project holding uncompiled JavaScript — spends the conversion's cost and declines its main benefit, and it makes this repository's `src/` different in kind from every other projen repository someone might have. Types also carry real weight in the one place this CLI is genuinely dangerous: the resolved destination path and the staged-rename sequence around `--force`.

*What it reverses:* an earlier draft of this design argued there should be no build step, so that nothing sits between what the tests verified and what is published. That concern does not disappear — it is answered instead by decision 4 running the packaging check against the packed, compiled artifact rather than against `src/`. The property being protected was never "no compiler"; it was "verify the thing that ships."

*Cost:* a compile step in the local loop, and a `lib/` that must be excluded from the published package's source but included as its entry point. Both are projen defaults, not hand-managed.

### 10. CommonJS output, and the `.mjs` scripts stay as they are

The compiled CLI is CommonJS — projen's default — and the root package drops `"type": "module"`. The existing `scripts/*.mjs` validation entry points are untouched; the `.mjs` extension makes them ES modules regardless of what the package declares.

*Why:* ESM output under projen's TypeScript setup means `NodeNext` resolution, explicit file extensions on every relative import, and a jest configuration that fights the default. That is a real, recurring tax, and it buys nothing here — the package's entire public surface is a `bin`, not an importable module. Nobody `import`s this package.

*Trade-off:* the CLI cannot use top-level `await` or ESM-only dependencies. It has no dependencies (a goal), and its entry point is a `main()` call, so neither constraint binds. Revisit only if the CLI ever gains an importable API.

### 11. Tests follow projen's grain: jest, not `node:test`

Tests are jest, projen's default for a TypeScript project, replacing the earlier plan to use the built-in `node:test` runner.

*Why:* projen wires jest into the build task, the coverage report, and the CI workflow. Choosing `node:test` means disabling that and rebuilding each piece by hand — cost paid in the config, for a suite that mostly spawns a CLI as a subprocess and asserts on stdout, stderr, and exit code. That style is identical under either runner.

*Consequence:* jest and `ts-jest` join the development dependencies. The "zero dependencies" rule is a *runtime* rule, and this does not touch it — nothing in `lib/` imports jest.

### 12. projen's release component owns versioning; the version is a tag, not a commit

Release is projen's `Release` component with a continuous trigger on `main`, `releaseToNpm` enabled. Each release computes the next version from git history, writes it into the artifact being built, publishes, tags, and creates a GitHub release. Crucially, projen then **unbumps** — the version in the repository's `package.json` stays `0.0.0` and no commit is pushed to `main`.

*Why this replaces the earlier bump-commit design:* an earlier draft had the workflow run `npm version patch`, push the bump commit and tag to `main`, then publish — which required a `[skip ci]` marker, an actor guard, and a concurrency group purely to stop a release from triggering another release, and it landed an unreviewed commit on `main` on every merge. projen's model removes the entire failure class by never pushing to `main`. The loop guard is not made more robust; it is made unnecessary.

*It also fixes the ordering problem the earlier draft could only choose a side of.* That draft bumped before publishing so that a failed publish left the repository ahead of the registry rather than stuck. With the version living in a tag, a failed publish leaves nothing to reconcile — the next run computes the same next version and tries again.

*What is given up:* the version is no longer readable from the checked-in `package.json`, which is what produces the `0.0.0` wrinkle in decision 7. Bump size is derived from commit history rather than fixed at patch, so a conventionally-formatted `feat:` commit produces a minor release. That is a difference from "patch on every commit" as originally asked for, and it is the direction worth having: the trigger is still every merge to `main`, only the size of the increment is inferred.

*Alternative considered:* disabling projen's release component and keeping the hand-written workflow. Rejected — it means maintaining a workflow in a repository whose whole point is that workflows are generated, and re-earning by hand the loop-safety projen gets structurally.

### 13. Provenance and credentials are declared, not hand-wired

`npmAccess` is public, which turns provenance on by default; `npmTokenSecret` already defaults to `NPM_TOKEN`, matching the secret being provided. projen generates the `id-token: write` permission and the publish invocation.

*Why an automation token specifically:* projen's publisher runs non-interactively, and a classic npm token with 2FA enabled fails there with a confusing error. This is a setup prerequisite, not a code concern, so it is documented rather than handled.

*Why provenance:* it ties the tarball on npm to the commit and workflow run that built it, which matters more than usual for a package whose entire purpose is to write files into someone's home directory. Under projen it costs one option.

*Noted for later:* projen also supports npm trusted publishing (OIDC, no long-lived token), which would remove the secret entirely. Not adopted here because it requires configuration on the npm side first, and the token is already available.

### 14. Existing validation scripts become projen tasks, not npm scripts

`validate:manifest`, `validate:examples`, `verify:pipelines`, `verify:resume`, and `verify:fixtures` keep their `scripts/*.mjs` implementations and are re-declared as projen tasks, with the packaging check added and all of them wired into the test task.

*Why:* `package.json` becomes generated, so a hand-written `scripts` block would be erased on the next synth. Declaring them as tasks in `.projenrc.ts` is the same list in the place that now owns it, and it keeps the `.mjs` implementations — which have nothing to do with the CLI and no reason to be rewritten — exactly as they are.

### 15. The ignore rules move with their reasoning intact

The current `.gitignore` carries a comment explaining why the CDK build-output rules are scoped to `templates/cdk/**` rather than a blanket `*.js`: a blanket rule also swallows fixture application source, which is JavaScript by design. That rule and that explanation move into `.projenrc.ts`.

*Why it is worth a decision:* it is precisely the kind of hard-won detail that a config migration drops, and dropping it does not fail any test — it silently untracks the fixture applications that the example-validation suite depends on. The comment is the guard against someone "simplifying" it back.

## Risks / Trade-offs

- **Rewriting `SKILL.md`'s asset paths breaks anyone who hand-copied the skill and works around the missing templates** → It is called out as **BREAKING** in the proposal and belongs in the release notes. The population is small (the repo has one commit and is unpublished) and the paths it breaks did not resolve after a documented install anyway.
- **`~/.claude/skills` may not be where a given user's Claude Code looks** → The CLI prints the resolved destination on every run, `--dir` accepts any path, and the completion message says how to confirm the skill is visible. The CLI does not try to discover the directory from Claude Code configuration; guessing wrong there is worse than being explicit.
- **In-repo development diverges from what gets installed, because `assets/` only exists after a copy** → The `skills:materialize` task for local use, and the packaging check (decision 4) exercises the installed layout on every test run, so divergence fails the suite rather than reaching a user.
- **The skill's reference documents may grow new repo-relative paths over time** → The same check walks `references/` too, so a new bad path fails the suite when it is introduced rather than when someone installs it.
- **Publishing is a new capability for this repository** → First publish is manual and deliberate; `npm pack` output is inspected as part of the change rather than trusted.
- **`npx` caches by version, so a user who runs it twice may get a stale copy** → Normal npm behavior, not something to work around. The completion message reports the version installed, so a stale run is visible in its own output.
- **The projen conversion silently drops something the current configuration does** → The largest risk in this change, and the least likely to fail loudly: the ignore rules (decision 15), the `engines` floor, and the five validation scripts each do real work that no test names directly. The conversion is verified by running the full suite before and after and diffing the generated `package.json` against the current one field by field, rather than by assuming projen's defaults match.
- **npm provenance requires a public repository** → If this repository is private, the publish fails. The first automated release is watched rather than assumed, and the fallback is turning provenance off — one option, no structural change.
- **Every merge to `main` publishes, including documentation-only ones** → Accepted per decision 12; it is what "release on commit to main" means. If the churn becomes a problem, projen can restrict which commits are releasable without touching anything else here.
- **Bump size comes from commit messages, so an unconventional message still releases but may size the bump oddly** → Cosmetic while the package is pre-1.0. Worth revisiting alongside a changelog, not before.
- **A leaked or over-scoped `NPM_TOKEN` publishes arbitrary code as this package** → It is an automation token scoped to publish, stored as a repository secret, never echoed, and used only in the release job. Provenance makes an out-of-band publish visibly different from a workflow one, and trusted publishing (decision 13) removes the token entirely if this becomes a concern.
- **A contributor edits a generated file and loses the change** → Unavoidable with generated configuration and the reason the drift check exists: CI fails rather than the edit silently vanishing at the next synth. Documented in the README's development section.

## Migration Plan

The order matters: projen first, because it owns the files every later step edits.

1. **Convert to projen.** Add `.projenrc.ts` reproducing the current `package.json`, `engines`, ignore rules, and the five validation scripts as tasks; synth; and confirm the existing suite passes unchanged. Nothing about the CLI is involved yet, so a failure here is unambiguously a conversion failure.
2. **Build the CLI** on that foundation — `src/`, the `skill.json` declarations, the `SKILL.md` path rewrite, and the packaging check — with the package still unpublished. Everything is verifiable locally via `npm pack` plus an install into a temp directory.
3. **Configure the repository**: add the `NPM_TOKEN` automation-token secret, and confirm the repository is public so provenance will work.
4. **Publish the first version by hand**, inspecting `npm pack --dry-run` output first. Claiming the name and establishing the baseline is not a good first exercise for an untested release pipeline.
5. **Enable the release component.** The next commit to `main` publishes automatically — watch that run end to end and confirm the tag, the GitHub release, the provenance attestation, and that `main` has no new commit from it.
6. **Update the README** install section to lead with `npx ecs-truly-auto-mode install`, keeping the manual copy documented as a fallback with the corrected asset step, and document `npx projen` for contributors.

Rollback: `npm deprecate` the published version with a message pointing at the manual copy; the repository itself needs no revert, since nothing in this change alters the skill's four phases. A user with a bad install removes it with `uninstall`, or by deleting the skill directory. To stop releases entirely, disable the workflow — published versions are never unpublished as a routine response, since anything already depending on them breaks. Rolling back the projen conversion itself means reverting `.projenrc.ts` and restoring the previous `package.json`, `tsconfig.json`, and ignore files from git; because step 1 lands on its own, that revert is a single commit.

## Open Questions

- Should `list` report the install status at both the user-global and project-local targets in one run, rather than only at the resolved one? Useful when a skill is installed in both places and the two versions differ. Purely additive to `list`'s output; deferrable without affecting the CLI's structure.
- Whether to ship a `--json` output mode for `list` and `install`. Nothing needs it yet, and adding it later does not change any decision here.
- Whether to adopt projen's dependency-upgrade and pull-request-lint workflows, or disable them. They come along with the project type and are easy to turn off later; the choice affects repository noise, not the CLI, the packaging, or the release path.
