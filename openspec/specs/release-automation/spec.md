# release-automation Specification

## Purpose

Defines how a commit landing on `main` becomes a published npm version — what must pass before anything is published, how the released version is determined and recorded, and what the published artifact is attested to have come from.

## Requirements

### Requirement: Release triggers on main

The system SHALL run the release workflow on every push to `main`, and SHALL NOT release from other branches or from pull requests.

#### Scenario: Commit lands on main

- **WHEN** a commit is pushed to `main`
- **THEN** the release workflow runs

#### Scenario: Other branches do not release

- **WHEN** a commit is pushed to a branch other than `main`, or a pull request is opened
- **THEN** no package is published

#### Scenario: Releases do not overlap

- **WHEN** a second push to `main` arrives while a release is in progress
- **THEN** the second release does not run concurrently with the first

### Requirement: Verification gates the publish

The system SHALL run the repository's full test suite, including the packaging verification and the generated-file drift check, before publishing, and SHALL abort without publishing if any of it fails.

#### Scenario: Tests pass

- **WHEN** the test suite and packaging verification succeed
- **THEN** the release proceeds to publish

#### Scenario: Tests fail

- **WHEN** any part of the test suite fails
- **THEN** nothing is published, no tag is pushed, and the workflow run fails

#### Scenario: Dependencies are installed reproducibly

- **WHEN** the workflow installs dependencies
- **THEN** it installs from the committed lockfile and fails if the lockfile and manifest disagree

### Requirement: The released version is derived, not committed

The system SHALL determine each release's version from the repository's release history rather than from a version committed to `main`, SHALL apply that version only to the artifact being built and published, and SHALL leave the version recorded on `main` unchanged by the release.

#### Scenario: Version advances between releases

- **WHEN** a release runs after a previously published version
- **THEN** the version it publishes is greater than the previously published one

#### Scenario: No bump commit on main

- **WHEN** a release completes
- **THEN** `main` has no new commit from the release, and the version recorded in the checked-in manifest is unchanged

#### Scenario: The release is recorded

- **WHEN** a release completes
- **THEN** a tag identifying the released version exists in the repository

#### Scenario: A release cannot start another release

- **WHEN** a release completes
- **THEN** nothing it pushed causes a further release to run

### Requirement: Nothing is released when there is nothing to release

The system SHALL skip publication when the current commit is already the most recently released one, and SHALL report the skip as a success rather than a failure.

#### Scenario: Re-running on an already-released commit

- **WHEN** the release workflow runs on a commit that has already been released
- **THEN** no publish is attempted and the run does not fail

#### Scenario: A version is never republished

- **WHEN** a release would produce a version that already exists on the registry
- **THEN** it is not published

### Requirement: Publication is authenticated and attested

The system SHALL authenticate to the registry using a repository secret rather than an interactive login, SHALL publish with a provenance attestation linking the published artifact to the workflow run and commit that produced it, and SHALL NOT expose the credential in workflow output.

#### Scenario: Published with provenance

- **WHEN** a release publishes
- **THEN** the published version carries a provenance attestation naming the source repository, commit, and workflow run

#### Scenario: Credential absent

- **WHEN** the registry credential secret is not configured
- **THEN** the publish fails with a message naming the missing secret

#### Scenario: Credential is not printed

- **WHEN** the workflow logs are read
- **THEN** the registry credential does not appear in them

### Requirement: The published artifact is the verified one

The system SHALL publish the artifact produced by the verified build, with no step between verification and publication that alters package contents beyond applying the release version.

#### Scenario: Contents match what was verified

- **WHEN** a release publishes
- **THEN** the published tarball's file list matches the one the packaging verification installed from, apart from the version recorded in the manifest

#### Scenario: Installable from the registry

- **WHEN** the published version is installed from the registry and its CLI is run
- **THEN** the skills it ships install successfully, resolving every path they reference
