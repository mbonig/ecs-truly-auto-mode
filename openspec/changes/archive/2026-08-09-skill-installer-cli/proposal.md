## Why

Installing the skill today means reading the README and running `cp -r skills/ecs-truly-auto-mode /path/to/.claude/skills/` — which requires cloning this repository first, and produces a **broken install**: `SKILL.md` Phase 3 and Phase 4 point at `templates/cdk/` and `templates/pipeline/github-actions/`, paths that only resolve inside this repo and do not travel with the copied directory. Someone who installs the skill the documented way gets a skill that analyzes and plans correctly and then cannot generate anything.

An npm CLI fixes both halves at once: `npx <package> install` becomes the one-line install with no clone, and the package it installs is assembled to be self-contained.

## What Changes

- **Convert the repository to projen.** A `.projenrc.ts` defining a `typescript.TypeScriptProject` becomes the single source of truth for `package.json`, `tsconfig.json`, `.gitignore`, `.npmignore`, and everything under `.github/workflows/`. The existing `scripts/*.mjs` validation entry points survive as projen tasks. Generated files stop being hand-editable — **BREAKING** for any workflow that edits `package.json` directly.
- **Add a publishable npm CLI** to this repository, written in TypeScript and compiled to `lib/`, exposed through a `bin` entry so it runs with `npx` without a global install. Commands:
  - `install [skill...]` — copy one or more skills into a Claude Code skills directory. With no skill named, install all skills the package ships.
  - `list` — show the skills the package ships and, for each, whether it is already installed at the resolved target and at what version.
  - `uninstall <skill...>` — remove a previously installed skill directory.
- **Install target selection**: interactive prompt defaulting to user-global `~/.claude/skills`, with project-local `./.claude/skills` as the alternative. `--user`, `--project`, and `--dir <path>` skip the prompt. When stdin is not a TTY the prompt is not shown and the default applies, so CI and piped invocations are deterministic.
- **Self-contained skill packages**: the CLI installs `templates/` and `schemas/` into the installed skill directory alongside `SKILL.md` and `references/`, so a skill resolves everything it needs from its own directory.
- **`SKILL.md` asset paths become skill-relative** — the Phase 3 and Phase 4 references to `templates/cdk/` and `templates/pipeline/github-actions/` are rewritten to point inside the skill package. **BREAKING** for anyone who copied the skill by hand and relies on the repo-relative paths.
- **Overwrite safety**: an install over an existing skill directory reports the installed version against the incoming one and refuses to proceed without `--force`. `--dry-run` prints the file operations and writes nothing.
- **Repository packaging changes**: `bin`, npm ignore rules, and publish metadata are declared in `.projenrc.ts` rather than hand-written; a packaging check is added to the test task asserting the published tarball contains every file a skill needs.
- **README install section rewritten** around the CLI, with the manual copy retained as a fallback.
- **Automated release on push to `main`**, using projen's release component with a continuous trigger. Each release computes the next version from git history, builds, publishes to npm with a provenance attestation, and pushes a version tag and GitHub release. No version-bump commit is pushed to `main` — the repository's checked-in version stays `0.0.0` and the released version lives in the tag. Authentication is an `NPM_TOKEN` repository secret.

Non-goals: a skill registry or remote catalog, installing skills from other repositories, updating an installed skill in place beyond re-running `install --force`, any change to the four analysis/planning/generation phases themselves, and release notes or changelog generation.

## Capabilities

### New Capabilities

- `skill-packaging`: What a distributable skill package contains and how it is assembled — the skill's own directory as the unit of distribution, the assets it must carry to function standalone, the version it records, and the guarantee that a published package contains everything an installed skill resolves at runtime.
- `skill-installation`: The installer CLI's behavior — resolving an install target (user-global, project-local, explicit path, interactive and non-interactive), copying skills, detecting and refusing unsafe overwrites, dry runs, listing installed versus available skills, uninstalling, and the exit codes and messages each outcome produces.
- `release-automation`: How a commit on `main` becomes a published npm version — what gates the publish, how the version is determined and recorded, what the published artifact is attested to have come from, and how the automation avoids publishing an untested or partially-verified package.
- `repository-configuration`: The repository's configuration being generated from a single checked-in definition rather than hand-maintained — which files are generated, that regenerating them is reproducible, and that a drifted or hand-edited generated file fails CI instead of reaching a release.

### Modified Capabilities

None — `openspec/specs/` has no published specs yet; the capabilities from the `ecs-truly-auto-mode` change are still in flight and unarchived. The `SKILL.md` asset-path rewrite is recorded under Impact rather than as a spec delta.

## Impact

- **New repository content**: `.projenrc.ts`, a `src/` tree with the command implementations and target resolution, `test/` with its fixtures, and the projen-generated workflows under `.github/workflows/`.
- **Modified**: `package.json`, `tsconfig.json`, and `.gitignore` become generated — the existing `.gitignore`'s scoped CDK rules and the rationale comment on them move into `.projenrc.ts`. Also `README.md` (install section), `skills/ecs-truly-auto-mode/SKILL.md` (skill-relative asset paths), and `scripts/`, which gains a packaging verification script while its existing `*.mjs` entry points become projen tasks rather than npm `scripts` entries.
- **Repository settings**: an `NPM_TOKEN` secret (an npm automation token, so 2FA does not block the publish), Actions permitted to write repository contents and request an OIDC token, and a public repository — npm provenance requires one.
- **Version numbering**: the checked-in version becomes `0.0.0` and the released version is derived from git tags at release time. Nothing bumps a version in a pull request, and no bump commit lands on `main`.
- **Contributor workflow**: `npx projen` regenerates configuration and must be re-run after editing `.projenrc.ts`. Edits made directly to a generated file are lost on the next synth and fail CI.
- **Consumer setups**: writes only into the resolved skills directory — `~/.claude/skills/<name>/` or `<cwd>/.claude/skills/<name>/`. It does not touch `settings.json`, other skills, or anything outside that directory.
- **Dependencies**: Node.js >= 20, already the declared engine. `projen` and the TypeScript toolchain become development dependencies. The CLI keeps **zero runtime dependencies** — standard library only, with prompt handling via `node:readline`.
- **Distribution**: publishing to npm becomes a release step for this repository, which it has not had before — the package name, first published version, and npm access are prerequisites for the CLI to be usable via `npx`.
