import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { CliError } from './errors';
import { PackageInfo, Target } from './paths';
import {
  INSTALL_RECORD,
  InstallRecord,
  Skill,
  buildInstallRecord,
  readInstallRecord,
} from './skills';
import { VersionStatus, versionStatus } from './version';

/** A skill directory already sitting at the destination. */
export interface ExistingInstall {
  readonly path: string;
  /** Absent when the directory is not one this CLI installed. */
  readonly record?: InstallRecord;
}

export interface PlannedInstall {
  readonly skill: Skill;
  readonly destination: string;
  readonly existing?: ExistingInstall;
}

export interface ListRow {
  readonly skill: Skill;
  readonly installed?: InstallRecord;
  /** A directory is present but was not installed by this package. */
  readonly unmanaged: boolean;
  readonly status?: VersionStatus;
}

export interface PlannedUninstall {
  readonly name: string;
  readonly path: string;
  readonly record: InstallRecord;
}

/** What an update would do with one shipped skill at the target. */
export type UpdateDisposition =
  /** Installed by this CLI: replace it with the packaged copy. */
  | 'refresh'
  /** A directory is there that this CLI did not install: leave it alone. */
  | 'unmanaged'
  /** Not installed: `update` refreshes, it does not add. */
  | 'absent';

export interface UpdateRow {
  readonly skill: Skill;
  readonly destination: string;
  readonly disposition: UpdateDisposition;
  /** The record found at the destination, when there is one this CLI wrote. */
  readonly installed?: InstallRecord;
}

export interface UpdatePlan {
  readonly rows: UpdateRow[];
  /** The rows to be refreshed, as install entries the existing installer accepts. */
  readonly refreshes: PlannedInstall[];
}

function inspectExisting(destination: string): ExistingInstall | undefined {
  if (!existsSync(destination)) return undefined;
  return { path: destination, record: readInstallRecord(destination) };
}

/**
 * Work out what an install would do, before anything is written.
 *
 * Every check that can refuse the run happens here, for every requested skill,
 * so a batch that is going to be refused is refused having written nothing.
 */
export function planInstall(skills: readonly Skill[], target: Target): PlannedInstall[] {
  return skills.map((skill) => {
    const destination = join(target.path, skill.name);
    return { skill, destination, existing: inspectExisting(destination) };
  });
}

/** The planned installs that would overwrite something already there. */
export function conflictsIn(plan: readonly PlannedInstall[]): PlannedInstall[] {
  return plan.filter((entry) => entry.existing !== undefined);
}

const STAGING = /^\.[^/\\]+\.(tmp|old)-\d+$/;

/**
 * Remove staging directories left behind by an interrupted run.
 *
 * A crash between the two renames in installSkill can leave one of these; they
 * are inert, but they accumulate and they look alarming in a skills directory.
 */
export function sweepStaging(targetPath: string): string[] {
  if (!existsSync(targetPath)) return [];
  const swept: string[] = [];
  for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
    if (entry.isDirectory() && STAGING.test(entry.name)) {
      rmSync(join(targetPath, entry.name), { recursive: true, force: true });
      swept.push(entry.name);
    }
  }
  return swept;
}

/**
 * Install one skill: stage it fully, then swap it into place.
 *
 * The staging directory is created inside the destination so the rename that
 * publishes it is same-filesystem and therefore atomic. Nothing incomplete is
 * ever visible at the skill's real path, and an overwrite replaces the whole
 * directory rather than merging into it — so no file from a previous install
 * can survive.
 */
export function installSkill(
  entry: PlannedInstall,
  pkg: PackageInfo,
  target: Target,
  now: Date = new Date(),
): void {
  const staging = join(target.path, `.${entry.skill.name}.tmp-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });

  try {
    cpSync(entry.skill.dir, staging, { recursive: true });
    for (const asset of entry.skill.assets) {
      cpSync(join(pkg.root, asset.from), join(staging, asset.to), { recursive: true });
    }
    writeFileSync(
      join(staging, INSTALL_RECORD),
      `${JSON.stringify(buildInstallRecord(entry.skill, pkg, now), null, 2)}\n`,
    );
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  // Park anything already there rather than deleting it, so a failure to
  // publish the new directory can put the old one back.
  let parked: string | undefined;
  if (existsSync(entry.destination)) {
    parked = join(target.path, `.${entry.skill.name}.old-${process.pid}`);
    rmSync(parked, { recursive: true, force: true });
    renameSync(entry.destination, parked);
  }

  try {
    renameSync(staging, entry.destination);
  } catch (error) {
    if (parked) renameSync(parked, entry.destination);
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  if (parked) rmSync(parked, { recursive: true, force: true });
}

export function ensureTargetExists(target: Target): void {
  mkdirSync(target.path, { recursive: true });
}

/**
 * Report each shipped skill against what is installed at the target.
 *
 * Reads only: it must not create the destination directory, since asking what
 * is installed should not change what is installed.
 */
export function listSkills(
  skills: readonly Skill[],
  target: Target,
  pkg: PackageInfo,
): ListRow[] {
  return skills.map((skill) => {
    const existing = inspectExisting(join(target.path, skill.name));

    if (!existing) return { skill, unmanaged: false };
    if (!existing.record) return { skill, unmanaged: true };

    return {
      skill,
      installed: existing.record,
      unmanaged: false,
      status: versionStatus(existing.record.version, pkg.version),
    };
  });
}

/**
 * Work out what an update would do, before anything is written.
 *
 * The classification is the whole of the command's safety: only a directory
 * carrying this package's install record may be replaced. A directory this CLI
 * did not install is never written to — not even with --force, since `update`
 * is run on a schedule and from scripts, where a silent overwrite of someone's
 * hand-edited skill is a loss with no warning attached.
 *
 * When skills were named explicitly, anything that cannot be refreshed refuses
 * the run; when they were not, it is reported and skipped so the skills that
 * can be refreshed still are.
 */
export function planUpdate(
  skills: readonly Skill[],
  target: Target,
  pkg: PackageInfo,
  namedExplicitly: boolean,
): UpdatePlan {
  const rows = skills.map((skill): UpdateRow => {
    const destination = join(target.path, skill.name);
    const existing = inspectExisting(destination);

    if (!existing) return { skill, destination, disposition: 'absent' };
    if (!existing.record || existing.record.package !== pkg.name) {
      return { skill, destination, disposition: 'unmanaged' };
    }

    return { skill, destination, disposition: 'refresh', installed: existing.record };
  });

  if (namedExplicitly) {
    for (const row of rows) {
      if (row.disposition === 'absent') {
        throw new CliError(
          `"${row.skill.name}" is not installed at ${target.path}`,
          'Run `install` to add it. `update` only refreshes skills that are already installed.',
        );
      }
      if (row.disposition === 'unmanaged') {
        throw new CliError(
          `refusing to update ${row.destination}`,
          `It has no ${INSTALL_RECORD} from ${pkg.name}, so it was not installed by this CLI. Use \`install --force\` if you mean to replace it.`,
        );
      }
    }
  }

  const refreshes = rows
    .filter((row) => row.disposition === 'refresh')
    .map((row) => ({ skill: row.skill, destination: row.destination }));

  return { rows, refreshes };
}

export function planUninstall(
  names: readonly string[],
  target: Target,
  pkg: PackageInfo,
): PlannedUninstall[] {
  return names.map((name) => {
    const path = join(target.path, name);

    if (!existsSync(path)) {
      throw new CliError(`"${name}" is not installed at ${target.path}`);
    }

    const record = readInstallRecord(path);
    if (!record || record.package !== pkg.name) {
      throw new CliError(
        `refusing to remove ${path}`,
        `It has no ${INSTALL_RECORD} from ${pkg.name}, so it was not installed by this CLI. Remove it by hand if you are sure.`,
      );
    }

    return { name, path, record };
  });
}

export function uninstallSkill(entry: PlannedUninstall): void {
  rmSync(entry.path, { recursive: true, force: true });
}
