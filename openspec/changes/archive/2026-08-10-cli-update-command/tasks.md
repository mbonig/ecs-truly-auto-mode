## 1. Update planning

- [x] 1.1 Add an update classification to `src/operations.ts`: for each shipped skill at the resolved target, decide `refresh` (an `.installed.json` whose `package` matches this package), `unmanaged` (a directory with no such record), or `absent`, reusing the inspection `listSkills` already performs rather than adding a second traversal
- [x] 1.2 Implement `planUpdate(skills, target, pkg, names)`: filter to the named skills when names are given, all shipped skills otherwise, and return the classified rows plus the `PlannedInstall` entries for the `refresh` rows
- [x] 1.3 Make an explicitly named skill that is `unmanaged` or `absent` a `CliError` — naming a directory this CLI did not install, or a skill that is not installed, refuses the run and writes nothing
- [x] 1.4 Make the unnamed case non-fatal: `unmanaged` and `absent` rows are reported and skipped while `refresh` rows still proceed, and a plan with no `refresh` rows reports "nothing to update" and exits zero
- [x] 1.5 Unit-test the classification in `test/units.test.ts` against fabricated destinations: matching record, foreign package name, corrupt record, missing record, absent directory

## 2. Self-update module

- [x] 2.1 Create `src/selfupdate.ts` exposing the three seams from design decision 7 — resolve the latest version, classify the installation mode, build the argv for an upgrade or hand-off — with all I/O behind an injected runner interface (`fetchJson`, `run`) so nothing in the module performs I/O itself
- [x] 2.2 Implement latest-version resolution: `GET <registry>/<package>/latest` with `Accept: application/vnd.npm.install-v1+json` and `AbortSignal.timeout(5000)`, registry base from `npm_config_registry` defaulting to `https://registry.npmjs.org`, returning a result that distinguishes "resolved to X" from "could not check, because Y"
- [x] 2.3 Implement installation-mode detection from the package root: `development` when the version is the `0.0.0` placeholder or `.projenrc.ts` sits at the root; `global` when the root is under `npm prefix -g`; `npx` when the root path contains an `_npx` segment; `dependency` otherwise
- [x] 2.4 Treat a failed, slow, or missing `npm prefix -g` as "not global" rather than an error, so detection degrades to the hand-off path
- [x] 2.5 Implement the per-mode action: `development` → none; `global` → `npm install -g <pkg>@latest` then re-exec the same bin; `npx`/`dependency` → `npx -y <pkg>@<latest>`; every non-development action re-executes with `--dir <resolved target>` and `--no-self-update` appended, plus `--dry-run` when it was passed
- [x] 2.6 Implement the global-upgrade fallback: an upgrade that fails (including `EACCES` on the global prefix) warns with the prefix and reason, then falls back to the `npx` hand-off without a global install, and states that the globally installed CLI is still the old version
- [x] 2.7 Skip upgrade and hand-off entirely when the running version is not older than the latest, using the existing `compareVersions`, and report "already current"
- [x] 2.8 Unit-test the module with a recording fake runner: each mode's argv, the already-current short-circuit, the lookup-failure result, the global-upgrade fallback, and that `--no-self-update` is always present in the hand-off argv

## 3. Update command

- [x] 3.1 Add `update` to `COMMANDS` in `src/cli.ts`, with `--check` and `--no-self-update` in `parseArgs`, and reject both new flags on `install`, `list`, and `uninstall`
- [x] 3.2 Wire the real runner in `cli.ts` — `fetch` for the lookup, `spawnSync` with inherited stdio for the upgrade and hand-off — keeping `src/selfupdate.ts` free of direct I/O
- [x] 3.3 Implement the update flow: resolve the target, run self-update unless `--no-self-update`, and on a successful hand-off exit with the child's exit code without performing the refresh in the parent
- [x] 3.4 Print one parent line naming the version being handed off to, and let the child produce the skill results, so the destination banner and the per-skill report are printed exactly once
- [x] 3.5 Implement the refresh: build the plan, call the existing `installSkill` for each `refresh` entry with no `--force` check, and report each skill with its new version, each skipped directory with its reason, and the destination
- [x] 3.6 Implement `update --check`: report the running version against the latest, then each shipped skill's installed state and version comparison; perform no upgrade, no hand-off, and no write — including not creating the destination directory — and exit zero even when things are out of date
- [x] 3.7 Make `--check --no-self-update` skip the lookup and say which comparison it made, so it is never mistaken for a registry check
- [x] 3.8 Implement `update --dry-run`: print the detected installation mode, the version it would move to, the upgrade or hand-off command line, the directories that would be replaced, and each skipped directory with its reason — writing nothing and spawning nothing
- [x] 3.9 Report a development checkout plainly: no lookup, no upgrade, skills refreshed from the working tree
- [x] 3.10 Update `USAGE` in `src/cli.ts` to document `update`, `--check`, and `--no-self-update`, and to state that `update` is the only command that makes a network request and the only one that can write outside the destination
- [x] 3.11 Change the `list` outdated row to point at `update`

## 4. Tests

- [x] 4.1 Extend `test/harness.ts` so a fake package can be built with a chosen version and with skills pre-installed at a destination, including one carrying a foreign `.installed.json` and one with none
- [x] 4.2 Cover the refresh through the compiled CLI with `--no-self-update`: an outdated skill is replaced, its recorded version becomes the packaged version, a file from the previous install that the new version does not ship is gone, and the same-version case is still refreshed
- [x] 4.3 Cover selection: `update` with no names refreshes every installed skill; `update <name>` refreshes only that one and leaves the others byte-identical
- [x] 4.4 Cover the managed/unmanaged line: an unmanaged directory is skipped and reported while other skills still update; naming it explicitly exits non-zero and modifies nothing; `--force` does not change either outcome
- [x] 4.5 Cover the not-installed cases: a shipped-but-absent skill is not added and is reported; naming an absent skill exits non-zero and writes nothing; a target with nothing installed reports "nothing to update" and exits zero
- [x] 4.6 Cover `--check` and `--dry-run` end to end with a local HTTP registry stub addressed through `npm_config_registry`, asserting the reported versions, and that neither creates the destination directory nor modifies any skill
- [x] 4.7 Cover the offline path: point `npm_config_registry` at a closed port and assert the CLI warns that the version could not be checked, refreshes from the running package, does not claim to be up to date, and exits zero
- [x] 4.8 Assert no test spawns `npm install -g` — the upgrade and hand-off argv are asserted only through the injected runner in the unit tests
- [x] 4.9 Assert scope of effects for `update`: no Claude Code settings file is touched, and skills at the destination belonging to other packages are unchanged
- [x] 4.10 Cover a failing refresh: a destination made non-writable partway exits non-zero and leaves no partial skill directory and no `.tmp-*`/`.old-*` leftovers on the next run

## 5. Documentation

- [x] 5.1 Add an "Updating" section to `README.md` documenting `update`, `--check`, `--no-self-update`, `--dry-run`, and the destination flags it shares with `install`
- [x] 5.2 Lead that section with the one-time bootstrap for anyone on a CLI that predates this change: `npx @matthewbonig/ecs-truly-auto-mode-skill@latest install --force`
- [x] 5.3 State plainly what `update` does per installation mode — global upgrades the global install, `npx` upgrades nothing on the PATH, a project dependency is left to the project's package manager
- [x] 5.4 State that `update` is the only command that reaches the network and the only one that can write outside the skills directory, and that it never replaces a directory it did not install
- [x] 5.5 Note that updating replaces the whole skill directory, so hand edits inside an installed skill do not survive

## 6. Verification

- [x] 6.1 Run the full suite plus `npx projen` and confirm no generated-file drift
- [x] 6.2 Verify by hand from a global install in a throwaway prefix: install an older version, run `update`, and confirm both the global package and the installed skill end up at the latest version (verified against a local stub registry serving 1.0.0 and 2.0.0 — no published version carries `update` yet, so the public registry cannot answer this until this change ships)
- [x] 6.3 Verify by hand from a clean npx cache: an older CLI outside the global prefix hands off through `npx`, refreshes the skill to the latest version, and leaves nothing on the PATH
- [x] 6.4 Verify from this working tree that `update` reports a development checkout, makes no network request, and refreshes from the tree
