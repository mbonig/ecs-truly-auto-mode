## ADDED Requirements

### Requirement: Updating installed skills

The system SHALL provide an `update` command that replaces each installed skill at the resolved target with the copy the package ships, without requiring `--force`. It SHALL update the skills named as arguments, and every installed skill when none is named. Replacing an installed skill SHALL leave no file from the previous install, and a skill directory SHALL never be left partially written.

#### Scenario: Outdated skill is refreshed

- **WHEN** `update` is run against a target where a skill installed by this CLI is at an older version
- **THEN** that skill directory is replaced with the packaged copy, its recorded version becomes the packaged version, and the CLI exits zero

#### Scenario: No force required

- **WHEN** `update` is run and a skill is already installed
- **THEN** the install is not refused and `--force` is not required

#### Scenario: Same version is still refreshed

- **WHEN** the installed version equals the packaged version
- **THEN** the skill directory is replaced anyway and reported as up to date

#### Scenario: Named skill only

- **WHEN** `update <name>` is run and several skills are installed
- **THEN** only that skill's directory is replaced and the others are untouched

#### Scenario: Nothing left over from the previous install

- **WHEN** an update replaces an installed skill whose previous version contained a file the new version does not ship
- **THEN** that file is not present after the update

#### Scenario: Failed update leaves the old skill intact

- **WHEN** an update fails partway through writing a skill directory
- **THEN** no partially written skill directory is left at the destination and the CLI exits non-zero

### Requirement: Update acts only on directories this CLI installed

The system SHALL replace only skill directories carrying an install record from this package. A directory that exists at the target without such a record SHALL be reported and left unmodified, and `--force` SHALL NOT override this. A shipped skill that is not installed at the target SHALL NOT be added by `update`.

#### Scenario: Unmanaged directory is skipped

- **WHEN** `update` runs where a skill directory exists but carries no install record from this package
- **THEN** that directory is unmodified, the CLI reports that it was not installed by this CLI, and other skills still update

#### Scenario: Unmanaged directory named explicitly

- **WHEN** `update <name>` names a directory that exists but carries no install record from this package
- **THEN** the CLI refuses, says the directory was not installed by this CLI, exits non-zero, and modifies nothing

#### Scenario: Not-installed skill is not added

- **WHEN** `update` runs at a target where a shipped skill is not installed
- **THEN** that skill is not installed, and the CLI reports that it is not installed and that `install` adds it

#### Scenario: Named skill that is not installed

- **WHEN** `update <name>` names a skill that is not installed at the target
- **THEN** the CLI reports that it is not installed and to run `install`, exits non-zero, and writes nothing

#### Scenario: Nothing to update is not an error

- **WHEN** `update` runs at a target where no skill from this package is installed
- **THEN** the CLI reports that there is nothing to update, writes nothing, and exits zero

### Requirement: Update status check

The system SHALL provide `--check` on `update`, reporting the running version against the latest published version and, for each shipped skill, whether it is installed at the resolved target and how its version compares. `--check` SHALL write nothing, SHALL NOT upgrade or re-execute, and SHALL exit zero when it has reported successfully, including when things are out of date.

#### Scenario: Reports what is out of date

- **WHEN** `update --check` is run with an outdated CLI and an outdated installed skill
- **THEN** both the CLI version comparison and each skill's state are printed, nothing is written, and the CLI exits zero

#### Scenario: Check writes nothing

- **WHEN** `update --check` is run
- **THEN** no file or directory is created, including the destination directory itself

#### Scenario: Check without the network

- **WHEN** `update --check --no-self-update` is run
- **THEN** no version lookup is made, only the installed-versus-packaged comparison is reported, and the output states which comparison was made

## MODIFIED Requirements

### Requirement: Invocation without installation

The system SHALL expose an executable entry point that runs directly from the package registry without a prior global install, and SHALL provide `install`, `list`, `uninstall`, and `update` commands.

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

#### Scenario: Update is listed in usage

- **WHEN** usage is printed
- **THEN** `update` appears among the commands, with the destination flags it shares with `install` and with `--check` and `--no-self-update`

### Requirement: Dry run

The system SHALL support `--dry-run` on `install`, `uninstall`, and `update`, printing the destination and the directories that would be created, replaced, or removed, and writing nothing.

#### Scenario: Dry-run install

- **WHEN** `install --dry-run` is run against an empty destination
- **THEN** the intended destination and skill directories are printed, and the filesystem is unchanged

#### Scenario: Dry run reports the overwrite conflict

- **WHEN** `install --dry-run` is run where the skill is already installed and `--force` is not passed
- **THEN** the same conflict that a real run would report is printed, and the filesystem is unchanged

#### Scenario: Dry-run update

- **WHEN** `update --dry-run` is run where a skill is installed
- **THEN** the destination and the skill directories that would be replaced are printed, directories that would be skipped are named with the reason, and the filesystem is unchanged

### Requirement: Scope of filesystem effects

The system SHALL write only inside the resolved destination directory, and SHALL NOT read, modify, or create Claude Code configuration files, other skills, or any path outside that directory. The single exception SHALL be `update`, which MAY upgrade this CLI's own package under the npm global prefix when it is running from a global install; that exception SHALL be stated in usage and SHALL be suppressed by `--no-self-update`.

#### Scenario: Settings untouched

- **WHEN** any command is run
- **THEN** no Claude Code settings file is created or modified

#### Scenario: Neighboring skills untouched

- **WHEN** a skill is installed into a directory that already contains unrelated skills
- **THEN** those skills' directories are unchanged

#### Scenario: Update touches nothing else outside the destination

- **WHEN** `update` runs
- **THEN** the only path it modifies outside the resolved destination is this CLI's own globally installed package, and only when self-update is enabled and the CLI is running from a global install

#### Scenario: Neighboring skills untouched by update

- **WHEN** `update` runs at a destination that also contains skills from other packages
- **THEN** those directories are unchanged
