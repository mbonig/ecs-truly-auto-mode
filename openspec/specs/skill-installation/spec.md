# skill-installation Specification

## Purpose

Defines the command-line behavior a person gets when installing these skills into their Claude Code setup — how the destination is chosen, what is written, what happens when something is already there, and what each outcome reports.

## Requirements

### Requirement: Invocation without installation

The system SHALL expose an executable entry point that runs directly from the package registry without a prior global install, and SHALL provide `install`, `list`, and `uninstall` commands.

#### Scenario: Runs via npx

- **WHEN** a user runs the package through `npx` with no prior install
- **THEN** the CLI executes and performs the requested command

#### Scenario: Default command

- **WHEN** the CLI is invoked with no command
- **THEN** it behaves as `install`

#### Scenario: Unknown command

- **WHEN** an unrecognized command is given
- **THEN** the CLI prints usage listing the available commands and exits non-zero without writing any file

#### Scenario: Help

- **WHEN** `--help` is passed, with or without a command
- **THEN** usage is printed and the CLI exits zero without writing any file

### Requirement: Install target resolution

The system SHALL resolve exactly one destination directory for an install: user-global `~/.claude/skills`, project-local `<cwd>/.claude/skills`, or an explicit path. `--user`, `--project`, and `--dir <path>` SHALL select the destination without prompting. When none is given and the session is interactive, the system SHALL prompt, offering user-global as the default. When none is given and the session is not interactive, the system SHALL use user-global without prompting.

#### Scenario: Interactive default

- **WHEN** `install` is run interactively with no target flag and the prompt is accepted without a choice
- **THEN** the skill is installed under `~/.claude/skills`

#### Scenario: Interactive project choice

- **WHEN** the user selects the project-local option at the prompt
- **THEN** the skill is installed under `<cwd>/.claude/skills`

#### Scenario: Non-interactive install

- **WHEN** `install` is run with no target flag and stdin is not a TTY
- **THEN** no prompt is shown, the skill is installed under `~/.claude/skills`, and the resolved destination is printed

#### Scenario: Explicit directory

- **WHEN** `--dir <path>` is passed
- **THEN** skills are installed under that path and neither `~/.claude/skills` nor `<cwd>/.claude/skills` is written to

#### Scenario: Conflicting target flags

- **WHEN** more than one of `--user`, `--project`, and `--dir` is passed
- **THEN** the CLI reports the conflict and exits non-zero without writing any file

#### Scenario: Destination created if absent

- **WHEN** the resolved destination directory does not exist
- **THEN** it is created, including missing parent directories

### Requirement: Skill selection

The system SHALL install the skills named as arguments, and SHALL install every skill the package ships when no skill is named.

#### Scenario: Named skill

- **WHEN** `install ecs-truly-auto-mode` is run
- **THEN** only that skill is installed

#### Scenario: No skill named

- **WHEN** `install` is run with no skill argument
- **THEN** every skill the package ships is installed

#### Scenario: Unknown skill named

- **WHEN** a named skill does not exist in the package
- **THEN** the CLI reports the unknown name alongside the available names and exits non-zero, and no skill is installed

### Requirement: Overwrite protection

The system SHALL refuse to overwrite an existing installed skill directory unless `--force` is passed. When it refuses, it SHALL report the installed version and the incoming version and exit non-zero. With `--force`, it SHALL replace the installed skill directory so that no file from the previous install survives.

#### Scenario: Existing install without force

- **WHEN** `install` targets a destination where that skill directory already exists and `--force` is not passed
- **THEN** the CLI reports the installed and incoming versions, states that `--force` is required, exits non-zero, and leaves the existing directory unmodified

#### Scenario: Existing install with force

- **WHEN** the same install is re-run with `--force`
- **THEN** the installed skill directory is replaced and contains no file left over from the previous install

#### Scenario: Same version is still refused

- **WHEN** the installed version equals the incoming version and `--force` is not passed
- **THEN** the install is still refused, and the message states the versions are the same

#### Scenario: Partial batch

- **WHEN** an unforced multi-skill install finds one skill already present and others absent
- **THEN** no skill is installed, and the CLI reports which one blocked the install

### Requirement: Dry run

The system SHALL support `--dry-run` on `install` and `uninstall`, printing the destination and the directories that would be created, replaced, or removed, and writing nothing.

#### Scenario: Dry-run install

- **WHEN** `install --dry-run` is run against an empty destination
- **THEN** the intended destination and skill directories are printed, and the filesystem is unchanged

#### Scenario: Dry run reports the overwrite conflict

- **WHEN** `install --dry-run` is run where the skill is already installed and `--force` is not passed
- **THEN** the same conflict that a real run would report is printed, and the filesystem is unchanged

### Requirement: Listing

The system SHALL provide a `list` command that reports every skill the package ships with its packaged version, and for each, whether it is installed at the resolved target and at what version.

#### Scenario: Nothing installed

- **WHEN** `list` is run against a target with no skills installed
- **THEN** each shipped skill is shown with its packaged version and marked not installed

#### Scenario: Installed at an older version

- **WHEN** a skill is installed at a version older than the packaged one
- **THEN** `list` shows both versions and marks the skill as outdated

#### Scenario: Listing writes nothing

- **WHEN** `list` is run
- **THEN** no file or directory is created, including the destination directory itself

### Requirement: Uninstalling

The system SHALL provide an `uninstall` command that removes named installed skill directories from the resolved target, and SHALL require at least one skill name.

#### Scenario: Removes the skill

- **WHEN** `uninstall <name>` is run for an installed skill
- **THEN** that skill's directory is removed from the target and other installed skills are untouched

#### Scenario: Not installed

- **WHEN** `uninstall <name>` names a skill that is not installed at the target
- **THEN** the CLI reports that it was not installed and exits non-zero, and no directory is removed

#### Scenario: No name given

- **WHEN** `uninstall` is run with no skill name
- **THEN** the CLI reports that a name is required and exits non-zero, and nothing is removed

#### Scenario: Refuses a directory it did not install

- **WHEN** the named directory exists at the target but carries no record identifying it as an installed skill of this package
- **THEN** the CLI refuses to remove it, says why, and exits non-zero

### Requirement: Scope of filesystem effects

The system SHALL write only inside the resolved destination directory, and SHALL NOT read, modify, or create Claude Code configuration files, other skills, or any path outside that directory.

#### Scenario: Settings untouched

- **WHEN** any command is run
- **THEN** no Claude Code settings file is created or modified

#### Scenario: Neighboring skills untouched

- **WHEN** a skill is installed into a directory that already contains unrelated skills
- **THEN** those skills' directories are unchanged

### Requirement: Outcome reporting and exit codes

The system SHALL exit zero only when the requested command completed, SHALL exit non-zero for every refusal or failure, and SHALL report on success the resolved destination, each skill installed with its version, and how to confirm the skill is available in Claude Code.

#### Scenario: Successful install

- **WHEN** an install completes
- **THEN** the CLI prints the destination, each installed skill and version, and next steps, and exits zero

#### Scenario: Failure is not silent

- **WHEN** a copy fails partway through — for example the destination is not writable
- **THEN** the CLI reports the failing path and the reason, and exits non-zero

#### Scenario: Failed install leaves no half-written skill

- **WHEN** an install fails partway through writing a skill directory
- **THEN** no partially written skill directory is left at the destination
