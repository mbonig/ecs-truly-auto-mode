## Why

Every push to `main` publishes a new version, so an installed skill goes stale quickly — but there is no way to refresh one. `list` reports "installed 0.3.1, outdated" and then leaves the reader to work out that the fix is `npx @matthewbonig/ecs-truly-auto-mode-skill@latest install --force`, a command that also needs the right target flag and the right skill names to avoid clobbering something. Worse, someone who installed the CLI globally gets `ecs-truly-auto-mode install --force` from whatever version is on their PATH, which reinstalls the *same stale skills* and reports success. The one thing a person wants — "give me the current version of everything" — is the one thing the CLI cannot do.

## What Changes

- **Add an `update` command** that brings installed skills up to the latest published version in one step: it acquires the latest package, then replaces each skill it manages at the resolved target with the packaged copy. No `--force` is needed — replacing an installed skill is what update is *for*.
- **The CLI updates itself first.** Before touching any skill, `update` resolves the latest version of its own package from the npm registry and, when the running copy is older, re-executes that version to perform the refresh. A globally installed CLI upgrades the global install (`npm install -g <pkg>@latest`) so the next bare `ecs-truly-auto-mode` invocation is also current; an `npx` run fetches the latest package and hands off to it without changing anything on the PATH.
- **Update only touches what this CLI installed.** A skill directory carrying this package's `.installed.json` is replaced; a directory the CLI did not install is left alone and reported, never silently overwritten. A shipped skill that is not installed at the target is not added — `update` refreshes, `install` adds — and `update <name>` for an uninstalled skill is an error that says to run `install`.
- **`--dry-run` extends to `update`**, reporting the self-update it would perform and the skill directories it would replace, writing nothing.
- **New flags**: `--no-self-update` performs the skill refresh from the running package only, skipping the registry entirely (what a local checkout, an air-gapped machine, or a test run wants), and `--check` reports what is out of date — the CLI itself and each installed skill — and exits without writing.
- **Degrading, not failing, when the registry is unreachable.** A failed version lookup or a failed global upgrade is reported as a warning and the skill refresh still runs from the package in hand, so a network problem cannot leave someone with neither a new CLI nor a repaired skill.
- **A development checkout does not self-update.** The checked-in version is the `0.0.0` placeholder; recognizing it means `npx projen build && node lib/cli.js update` refreshes skills from the working tree instead of quietly pulling a published tarball over the change being tested.
- **README gains an "Updating" section**, and `list` rows that report an outdated skill point at `update`.

Non-goals: a skill registry or remote catalog, updating skills from other packages, pinning or downgrading to a specific version, background or scheduled update checks, and any nag on unrelated commands — `install`, `list`, and `uninstall` continue to make no network calls.

## Capabilities

### New Capabilities

- `cli-self-update`: How the CLI brings itself to the latest published version before acting — how the latest version is resolved, how the running installation mode (global, `npx`, development checkout) is detected and what upgrade each implies, how control is handed to the newer version exactly once, what happens when the registry or the upgrade fails, and how a caller opts out.

### Modified Capabilities

- `skill-installation`: Gains an `update` command — refreshing installed skills to the packaged version without `--force`, restricted to directories this CLI installed, refusing to add skills that are not installed, plus `--check` reporting and `--dry-run` coverage for the new command. The existing `install`, `list`, and `uninstall` requirements are unchanged.

## Impact

- **New code**: a self-update module in `src/` (registry lookup, installation-mode detection, re-execution) and an `update` command path alongside the existing three in `src/cli.ts`. `src/operations.ts` gains an update plan built from the same `listSkills` view that `list` already produces.
- **Modified**: `src/cli.ts` (command list, usage text, flag parsing), `src/operations.ts`, `README.md`, and the `list` output wording.
- **Tests**: `test/cli.test.ts` and `test/units.test.ts` grow cases for update planning, managed-versus-unmanaged handling, and `--check`/`--dry-run` output. The self-update path is exercised with the registry lookup and the re-execution seam injected, so no test reaches the network or installs anything globally.
- **Dependencies**: still zero runtime dependencies. The registry lookup uses the built-in `fetch`, and the global upgrade and hand-off shell out to the `npm`/`npx` already present wherever this CLI runs.
- **Consumer setups**: `update` is the first command that makes a network request and the first that can modify something outside the resolved skills directory — the global npm prefix, and only when the CLI is already installed there. Both are stated in the usage text and suppressed by `--no-self-update`.
- **Failure surface**: a re-execution that hands off to a newer version means the newer version's exit code becomes this run's exit code; a hand-off loop is prevented by passing an internal flag that stops the child from self-updating again.
