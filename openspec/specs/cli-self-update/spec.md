# cli-self-update Specification

## Purpose
TBD - created by archiving change cli-update-command. Update Purpose after archive.
## Requirements
### Requirement: Latest version resolution

The system SHALL resolve the latest published version of its own package from the npm registry before performing an update, using a single unauthenticated request with a bounded timeout, honoring a configured registry when one is set. The lookup SHALL be performed only by the `update` command.

#### Scenario: Latest version is read from the registry

- **WHEN** `update` runs and the registry is reachable
- **THEN** the latest published version of the package is retrieved and reported alongside the running version

#### Scenario: Configured registry is honored

- **WHEN** a registry is configured in the environment
- **THEN** the version lookup is made against that registry rather than the public default

#### Scenario: No lookup on other commands

- **WHEN** `install`, `list`, or `uninstall` is run
- **THEN** no network request is made

#### Scenario: Lookup is bounded

- **WHEN** the registry does not respond
- **THEN** the lookup is abandoned after a bounded wait rather than blocking indefinitely

### Requirement: Installation mode detection

The system SHALL determine how the running copy of the CLI was installed — a development checkout, a global install, an `npx` execution, or a project dependency — and SHALL choose the self-update action from that determination. A development checkout SHALL NOT self-update.

#### Scenario: Development checkout

- **WHEN** `update` runs from a working tree of this repository
- **THEN** no registry upgrade is attempted, the CLI reports that it is running from a development checkout, and skills are refreshed from that working tree

#### Scenario: Global install

- **WHEN** `update` runs from a copy installed under the npm global prefix and a newer version is published
- **THEN** the global package is upgraded to the latest version

#### Scenario: npx execution

- **WHEN** `update` runs from an `npx` execution and a newer version is published
- **THEN** the latest package is fetched and used for the refresh, and no globally installed copy is modified

#### Scenario: Project dependency

- **WHEN** `update` runs from a copy installed as a dependency of a project and a newer version is published
- **THEN** the project's `package.json` and lockfile are not modified, the latest package is fetched for the refresh, and the CLI reports that the project's own copy was left unchanged

### Requirement: Handing off to the newer version

The system SHALL perform the skill refresh using the version it upgraded to, not the version that was running, by re-executing the newer CLI with the already-resolved destination and with self-update disabled. The re-executed run's exit code SHALL become the exit code of the command.

#### Scenario: Refresh runs from the new version

- **WHEN** a self-update succeeds
- **THEN** the skills written to the destination come from the newly acquired package and the version recorded for each installed skill is the new version

#### Scenario: Destination is carried across

- **WHEN** the destination was resolved by flag or by prompt before the hand-off
- **THEN** the re-executed run uses that same destination without prompting

#### Scenario: No repeated self-update

- **WHEN** the newer version is re-executed
- **THEN** it does not attempt a further version lookup or upgrade

#### Scenario: Failure of the newer version is reported

- **WHEN** the re-executed run fails
- **THEN** the command exits non-zero with that run's exit code

### Requirement: Already current

The system SHALL NOT upgrade or re-execute when the running version is not older than the latest published version, and SHALL proceed directly to the skill refresh.

#### Scenario: Running the latest version

- **WHEN** `update` runs and the running version equals the latest published version
- **THEN** no upgrade and no re-execution occur, and the CLI reports that it is already current before refreshing skills

#### Scenario: Running ahead of the registry

- **WHEN** the running version is newer than the latest published version
- **THEN** no upgrade is attempted and the skill refresh proceeds from the running package

### Requirement: Self-update failure is not fatal

The system SHALL treat a failed version lookup or a failed upgrade as a warning rather than an error, reporting what was skipped and why, and SHALL continue with the skill refresh using the package that is already present. A failed global upgrade SHALL fall back to acquiring the latest package without modifying the global install.

#### Scenario: Registry unreachable

- **WHEN** the version lookup fails
- **THEN** the CLI warns that the version could not be checked, refreshes skills from the running package, and exits zero if that refresh succeeds

#### Scenario: Global upgrade is not permitted

- **WHEN** upgrading the global install fails because the global prefix is not writable
- **THEN** the CLI reports the prefix and the failure, acquires the latest package without a global install, refreshes skills from it, and states that the globally installed CLI is still the older version

#### Scenario: Warning is distinguishable from being current

- **WHEN** a lookup or upgrade is skipped after a failure
- **THEN** the output states that the check or upgrade did not happen, and does not report the CLI as up to date

### Requirement: Opting out of self-update

The system SHALL provide `--no-self-update`, which suppresses the version lookup, any upgrade, and any re-execution, and performs the skill refresh from the running package only.

#### Scenario: Refresh from the running package

- **WHEN** `update --no-self-update` is run
- **THEN** no network request is made, no upgrade is attempted, and installed skills are replaced with the copies the running package ships

### Requirement: Self-update is reported before it happens

The system SHALL, under `--dry-run`, report the installation mode it detected, the version it would move to, and the command it would run to do so, and SHALL make no network-driven change, no upgrade, and no re-execution.

#### Scenario: Dry-run self-update

- **WHEN** `update --dry-run` is run and a newer version is published
- **THEN** the detected mode, the target version, and the upgrade or hand-off command are printed, and neither the global install nor any skill directory is modified

