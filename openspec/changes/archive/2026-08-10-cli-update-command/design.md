## Context

See proposal.md — Why. The CLI already installs, lists, and uninstalls skills; `update` is the fourth command, and almost all of the hard part is over before any skill is touched.

Four facts about the existing code and repository shape the design.

**The skill's version is the package's version.** `buildInstallRecord` writes `pkg.version` into `.installed.json`, and `pkg.version` is read from the package's own `package.json`. There is no per-skill version. So "the installed skill is out of date" and "the CLI that installed it is out of date" are the same statement, and updating skills without first updating the package is a no-op that reports success — the failure mode this change exists to remove.

**The checked-in version is `0.0.0`.** Releases are continuous: `.projenrc.ts` sets `ReleaseTrigger.continuous()` and unbumps after publishing, so the real version exists only in the tag and the published tarball. A working tree therefore always looks infinitely out of date, and anything that compares versions has to recognize that.

**The CLI has zero runtime dependencies and writes only inside the resolved skills directory.** The `skill-installation` spec states the second as a requirement ("Scope of filesystem effects"). `update` is the first command that needs to break both spirits — a network call, and a write to the global npm prefix — so where it does, it has to be narrow, announced, and switchable off.

**`installSkill` already replaces atomically.** Staging plus rename, with the old directory parked and removed only after the new one is published. Update needs no new write path; it needs a new *decision* about which directories may be written.

The one genuinely new machine is self-update: work out what the latest version is, work out how this copy of the CLI got here, and get the newest code running with the least surprise.

## Goals / Non-Goals

**Goals:**

- One command that leaves the user with the current CLI and the current skills: `ecs-truly-auto-mode update`.
- Never overwrite a directory this CLI did not install, even under `update`, whose whole job is overwriting.
- Never fail closed on a network problem. A user who cannot reach npm still gets their skills refreshed from the package in hand.
- Self-update is observable and refusable: `--check` shows what would change, `--dry-run` writes nothing, `--no-self-update` skips the network entirely.
- A development checkout refreshes from the working tree, never from the registry.
- Still zero runtime dependencies; the registry lookup uses built-in `fetch`.

**Non-Goals:**

- Pinning, downgrading, or installing a named version. `update` means latest.
- Update checks or nags on any other command. `install`, `list`, and `uninstall` stay offline.
- Managing skills installed by some other package, or repairing a hand-copied skill directory.
- Upgrading a copy installed as a project dependency *in place* — that belongs to the project's package manager, not to this CLI.

## Decisions

### 1. Self-update runs first, and hands off to the new version rather than reloading code

`update` resolves the latest published version, upgrades or fetches it, and then **re-executes the newer CLI as a child process**, forwarding the resolved target and `--no-self-update`. The child does the actual skill refresh; its exit code becomes the parent's.

*Why hand off instead of continuing in-process:* the running process has already loaded the old `lib/*.js` and, more importantly, its `pkg.root` points at the old package directory — that is where `discoverSkills` reads `SKILL.md`, `skill.json`, `templates/`, and `schemas/` from. Even after a successful `npm install -g`, continuing in-process would copy the *old* skill payload while reporting the new version. Re-execution is the only way the version reported and the bytes copied are the same thing.

*Why `--no-self-update` on the child rather than an internal hidden flag:* it is the exact behavior wanted (do the refresh, do not go back to the network), it is already a documented flag, and it makes the hand-off inspectable in `ps` and in `--dry-run` output. It also makes an accidental hand-off loop structurally impossible rather than merely unlikely.

*Why the target is passed as `--dir <path>`:* the parent has already resolved the destination — possibly by prompting. The child gets a non-TTY stdin; without an explicit target it would silently fall back to user-global and refresh the wrong directory.

*Alternative considered:* have the parent download the tarball itself, extract it, and copy skills from it — no child process. Rejected: it reimplements `npm pack`/extract, gains nothing over letting npm do it, and would not upgrade a global install, which is the case most likely to go stale unnoticed.

### 2. Installation mode is detected from the package root path, and each mode has one upgrade

`findPackageRoot()` already computes the absolute directory the running CLI was loaded from. That path classifies the run:

| Mode | Detected by | Upgrade |
| --- | --- | --- |
| development | `pkg.version === '0.0.0'`, or `.projenrc.ts` present at the root | none — refresh from the working tree, say so |
| global | root is under the npm global prefix (`npm prefix -g`) | `npm install -g <pkg>@latest`, then re-exec the same bin |
| npx | a `_npx` segment in the root path | `npx -y <pkg>@latest update …` |
| dependency | anything else under a `node_modules` directory | no in-place upgrade; hand off via `npx -y <pkg>@latest`, and say the project's own copy was not changed |

*Why the version placeholder is the primary development signal:* it is the one thing that is unambiguously true of a working tree and false of every published tarball, it costs no filesystem probing, and it is already load-bearing for `list`. The `.projenrc.ts` check is a second signal for the case where someone has locally bumped the version while testing.

*Why `npm prefix -g` rather than deriving the prefix from `process.execPath`:* version managers (nvm, volta, and the `~/.npm-global` prefix this repository's author uses) put the global prefix somewhere unrelated to the Node binary. Asking npm is the only answer that is right on all of them. It costs one subprocess, and only on `update`.

*Why `dependency` mode does not run `npm install <pkg>@latest` in the project:* that edits someone's `package.json` and lockfile as a side effect of asking for the latest skills. The npx hand-off gets the same skills with no repository change, and the message says plainly which copy was and was not updated.

*Trade-off:* four modes is four code paths to test. Each collapses to "produce an argv" — the detection returns a mode, the mode maps to a command, and the tests assert the command, so the seam is one function returning a string array.

### 3. The registry lookup is a single unauthenticated GET, with a timeout, and its failure is never fatal

`GET <registry>/<package>/latest`, `Accept: application/vnd.npm.install-v1+json` (the abbreviated document — kilobytes instead of megabytes for a package with many versions), `AbortSignal.timeout(5000)`. The registry base honors `npm_config_registry` when set, defaulting to `https://registry.npmjs.org`. Any failure — DNS, timeout, non-200, unparsable body, missing `version` field — produces a warning and the run continues with the package in hand.

*Why not `npm view <pkg> version`:* it is a subprocess and 1–3 seconds of npm startup to fetch one string that `fetch` returns in one round trip. npm is still shelled out to for the *upgrade*, where it is doing real work.

*Why failure warns instead of exits:* the person running `update` most often has a stale or broken skill. Refusing to refresh it because npm was unreachable turns a degraded outcome into no outcome. The warning names what was skipped, so a `--check` that says "could not reach the registry" is never mistaken for "you are up to date".

### 4. What update may replace is decided by the install record, not by the directory's existence

For each shipped skill, `update` inspects the destination and classifies it:

- **refresh** — `.installed.json` present, its `package` equal to this package's name. Replaced with the packaged copy, no `--force` needed.
- **unmanaged** — the directory exists but has no matching record. Skipped, reported, never written. `--force` does not override this; the escape hatch is `install --force`, which is where an explicit destructive act belongs.
- **absent** — not installed. Skipped and reported as "not installed — run `install` to add it".

This is the same classification `listSkills` already computes; `planUpdate` is a filter over it plus a decision column, not a second traversal.

*Why unmanaged directories are never replaced even by an explicit `update <name>`:* the existing spec makes the identical promise for `uninstall`, and a person whose hand-edited skill was silently replaced by an update loses work with no warning. Naming it explicitly is an error that says what to run instead.

*Why not-installed skills are not added:* `update` is run on a schedule, in a shell history, by a script. If it added every skill the package ships, adding a second skill to this package would silently install it on every machine that ever ran `update`. `install` adds; `update` refreshes.

*Consequence worth stating:* `update` on a target where nothing is installed does nothing and exits **zero**, reporting that there is nothing to update. It is not an error to be already correct.

### 5. `--check` is the read-only projection of the same plan, and does not need the network to be useful

`--check` prints the running version against the latest published version, then each shipped skill's state at the target. It performs the registry lookup but no upgrade, no hand-off, and no write. With `--no-self-update` it skips the lookup and reports only the installed-versus-packaged comparison — which is what `list` already gives — so the two flags together are legal but redundant, and the output says which comparison it made.

*Why `--check` and not `update --dry-run`:* they answer different questions. `--dry-run` describes the actions this run would take, including the hand-off command line, and is the rehearsal for a real update. `--check` is a status question with an answer that fits on a few lines and is meant to be readable in a script. Both exist; neither writes.

*Why the exit code stays zero when things are out of date:* a non-zero exit means the command failed, and `--check` succeeded — it answered. A caller who wants "fail if stale" can grep the output. Overloading the exit code would make `update --check` unusable in a shell with `set -e`, which is exactly where someone would put it.

### 6. Skill refresh reuses `installSkill` untouched

The update path builds `PlannedInstall` entries for the skills classified as *refresh* and calls the existing `installSkill`, which stages, parks the old directory, renames, and removes. No new write path, no new failure mode, and the "no file from a previous install survives" guarantee is inherited rather than reimplemented.

*Trade-off:* `installSkill` replaces the whole directory, so anything a user added inside an installed skill directory is destroyed by an update. That is already true of `install --force` and is the correct behavior for a directory whose contents are a package artifact — but it is the reason decision 4 draws the managed/unmanaged line so strictly.

### 7. The self-update seam is injected, so no test touches the network or the global prefix

Self-update is one module exposing three functions: resolve the latest version, classify the installation, and produce the argv for an upgrade or hand-off. The command layer receives a "runner" — the thing that actually performs a `fetch` and spawns a process — with a real implementation in `cli.ts` and a recording fake in tests. Tests assert on the argv produced and the branch taken.

*Why this matters more than usual here:* the untestable version of this feature would run `npm install -g` in CI. The seam is not a nicety; it is the only way this feature is testable at all.

## Risks / Trade-offs

- **A global upgrade fails on a root-owned npm prefix (`EACCES`)** → caught and reported as a warning naming the prefix, then the run falls back to the npx hand-off, which needs no elevated permission and still refreshes skills from the latest package. The user is told their global CLI is still the old version and how to fix it.
- **The hand-off child produces a second banner and a second set of output** → the parent prints one line naming the version it is handing off to and streams the child's output through; the child is the only one that reports the skill results. Duplicate "Target:" lines are avoided because the parent does not run the refresh at all.
- **A published version that is broken gets pulled in by `update`** → the same exposure `npx <pkg>@latest install` already has. `--check` shows the version before anything happens, and `--no-self-update` refreshes from the known-good local copy. Pinning is a non-goal, so there is no rollback command; `npm install -g <pkg>@<version>` remains the manual answer.
- **Detection misfires and a mode is misclassified** — for example an unusual npx cache layout with no `_npx` segment → falls into `dependency`, whose action is the npx hand-off, which is the safe direction: it never writes outside the skills directory and never edits a project. Only `global` mutates anything on the machine, and its detection is an exact prefix match against `npm prefix -g`.
- **`npm prefix -g` is slow or absent** → treated as "not global"; the run degrades to the hand-off path with a warning. `update` never depends on npm being present for the *skill* work, only for the upgrade.
- **The child re-execution masks the parent's intent on interrupt** — a `Ctrl-C` during hand-off kills the parent while npm may be mid-write in its own cache → npm's cache is self-repairing and no skill directory has been touched yet, since the refresh happens in the child after the download. The window where an interrupt matters is inside `installSkill`, which is already staged-and-renamed.
- **`update` becomes the first command that phones home**, which someone will reasonably object to on a tool that writes into their home directory → it happens only on `update`, only to resolve one version string, and `--no-self-update` removes it. No telemetry, no identifiers, no calls from any other command.

## Migration Plan

No data or format migration: `.installed.json` is unchanged, and an old record is readable by the new CLI.

The one ordering constraint is that `update` cannot bootstrap itself. Someone whose installed CLI predates this change has no `update` command, so the first upgrade is still `npx @matthewbonig/ecs-truly-auto-mode-skill@latest install --force` (or `npm install -g …@latest`). The README's new "Updating" section leads with that one-time line before documenting `update`.

Rollback is `npm install -g <pkg>@<previous>` followed by `install --force`; nothing in this change alters the installed layout, so an older CLI continues to manage skills a newer one installed.

## Open Questions

- Should `update` accept `--user`/`--project` implicitly refreshing *both* when skills are installed in each? Current answer: no — one resolved target per run, same as every other command. If this proves annoying it is additive later.
- Should `list` perform the registry lookup when the user is already online, so its "outdated" is measured against the registry rather than the packaged version? Current answer: no, `list` stays offline; `--check` is the online question.
