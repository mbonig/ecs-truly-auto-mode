#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { CliError } from './errors';
import {
  PlannedInstall,
  UpdateRow,
  conflictsIn,
  ensureTargetExists,
  installSkill,
  listSkills,
  planInstall,
  planUninstall,
  planUpdate,
  sweepStaging,
  uninstallSkill,
} from './operations';
import {
  PackageInfo,
  Target,
  explicitTarget,
  projectTarget,
  readPackageInfo,
  userTarget,
} from './paths';
import { promptForTarget } from './prompt';
import {
  CommandLine,
  DEVELOPMENT_VERSION,
  LatestVersion,
  Runner,
  formatCommand,
  resolveLatest,
  selfUpdate,
} from './selfupdate';
import { Skill, discoverSkills, findSkill } from './skills';
import { versionStatus } from './version';

const COMMANDS = ['install', 'list', 'uninstall', 'update'] as const;
type Command = (typeof COMMANDS)[number];

const PACKAGE = '@matthewbonig/ecs-truly-auto-mode-skill';

const USAGE = `ecs-truly-auto-mode — install Claude Code skills

Usage:
  npx ${PACKAGE} [install] [skill...]   install skills (all of them if none named)
  npx ${PACKAGE} list                   show shipped skills and what is installed
  npx ${PACKAGE} uninstall <skill...>   remove installed skills
  npx ${PACKAGE} update [skill...]      update this CLI, then refresh installed skills

Installed globally, the command is: ecs-truly-auto-mode

Where to install:
  --user            ~/.claude/skills (the default)
  --project         ./.claude/skills
  --dir <path>      an explicit directory

Options:
  --force           replace a skill that is already installed (install only)
  --dry-run         report what would happen and write nothing
  --help            show this message
  --version         show the version of this package

Options for update:
  --check           report what is out of date and write nothing
  --no-self-update  refresh skills from this package only, with no network call

update is the only command that makes a network request, and the only one that
can write outside the skills directory — it upgrades its own globally installed
package. --no-self-update turns both off. It never replaces a skill directory
it did not install.`;

interface Options {
  readonly command: Command;
  readonly names: string[];
  readonly user: boolean;
  readonly project: boolean;
  readonly dir?: string;
  readonly force: boolean;
  readonly dryRun: boolean;
  readonly check: boolean;
  readonly noSelfUpdate: boolean;
}

function parse(argv: string[]): Options {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        'user': { type: 'boolean', default: false },
        'project': { type: 'boolean', default: false },
        'dir': { type: 'string' },
        'force': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        'check': { type: 'boolean', default: false },
        'no-self-update': { type: 'boolean', default: false },
        'help': { type: 'boolean', default: false },
        'version': { type: 'boolean', default: false },
      },
    });
  } catch (error) {
    throw new CliError((error as Error).message, USAGE);
  }

  const { values, positionals } = parsed;

  if (values.help) throw new HelpRequested();
  if (values.version) throw new VersionRequested();

  // The first positional is a command only if it is one; otherwise every
  // positional is a skill name and the command defaults to install.
  const [first, ...rest] = positionals;
  const isCommand = COMMANDS.includes(first as Command);
  const command: Command = isCommand ? (first as Command) : 'install';
  const names = isCommand ? rest : positionals;

  if (!isCommand && first !== undefined && first.startsWith('-')) {
    throw new CliError(`unknown option: ${first}`, USAGE);
  }

  // The two update flags reach the network and the global npm prefix. Accepting
  // them silently elsewhere would suggest the other commands do something with
  // them, and they must not.
  if (command !== 'update') {
    const misplaced = [values.check && '--check', values['no-self-update'] && '--no-self-update'].filter(Boolean);
    if (misplaced.length > 0) {
      throw new CliError(`${misplaced.join(' and ')} only applies to update`, USAGE);
    }
  }

  return {
    command,
    names,
    user: values.user as boolean,
    project: values.project as boolean,
    dir: values.dir as string | undefined,
    force: values.force as boolean,
    dryRun: values['dry-run'] as boolean,
    check: values.check as boolean,
    noSelfUpdate: values['no-self-update'] as boolean,
  };
}

class HelpRequested extends Error {}
class VersionRequested extends Error {}

async function resolveTarget(options: Options): Promise<Target> {
  const chosen = [options.user && 'user', options.project && 'project', options.dir && 'dir'].filter(
    Boolean,
  );

  if (chosen.length > 1) {
    throw new CliError(
      `--${chosen.join(' and --')} cannot be combined; pick one destination`,
      USAGE,
    );
  }

  if (options.dir) return explicitTarget(options.dir);
  if (options.project) return projectTarget();
  if (options.user) return userTarget();

  // Only ask when there is someone there to answer. A run piped through a
  // script or executed in CI must not block on a prompt no one can see.
  if (!process.stdin.isTTY) return userTarget();

  return promptForTarget();
}

function requireSkills(options: Options, available: Skill[]): Skill[] {
  if (options.names.length === 0) return [...available];

  const unknown = options.names.filter((name) => !findSkill(available, name));
  if (unknown.length > 0) {
    throw new CliError(
      `unknown skill${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`,
      `Available: ${available.map((s) => s.name).join(', ') || '(none)'}`,
    );
  }

  return options.names.map((name) => findSkill(available, name)!);
}

function describeConflict(entry: PlannedInstall, pkg: PackageInfo): string {
  const installed = entry.existing?.record?.version;
  if (!installed) {
    return `  ${entry.skill.name} — a directory is already at ${entry.destination}, not installed by this CLI`;
  }
  const relation = installed === pkg.version ? ' (the same version)' : '';
  return `  ${entry.skill.name} — installed ${installed}, incoming ${pkg.version}${relation}`;
}

function runInstall(options: Options, target: Target, pkg: PackageInfo, skills: Skill[]): void {
  const selected = requireSkills(options, skills);
  const plan = planInstall(selected, target);
  const conflicts = conflictsIn(plan);

  if (conflicts.length > 0 && !options.force) {
    throw new CliError(
      `already installed at ${target.path}:\n${conflicts
        .map((entry) => describeConflict(entry, pkg))
        .join('\n')}`,
      'Pass --force to replace. Nothing has been written.',
    );
  }

  if (options.dryRun) {
    console.log('Dry run — nothing will be written.\n');
    for (const entry of plan) {
      console.log(`  ${entry.existing ? 'replace' : 'create '}  ${entry.destination}`);
      for (const asset of entry.skill.assets) {
        console.log(`            + ${asset.to}`);
      }
    }
    return;
  }

  ensureTargetExists(target);
  sweepStaging(target.path);

  const installed: string[] = [];
  try {
    for (const entry of plan) {
      installSkill(entry, pkg, target);
      installed.push(entry.skill.name);
    }
  } catch (error) {
    // A conflict is predictable and refuses the whole batch; a copy failure is
    // not, so say plainly what did land rather than implying it was atomic.
    const done = installed.length > 0 ? `\nInstalled before the failure: ${installed.join(', ')}` : '';
    throw new CliError(`install failed: ${(error as Error).message}${done}`);
  }

  console.log(`Installed into ${target.path}\n`);
  for (const name of installed) {
    console.log(`  ${name}  ${pkg.version}`);
  }
  console.log(
    '\nStart Claude Code and run /help — the skill is available once it appears there.\n' +
      'Nothing from this CLI is needed again for the skill to work.',
  );
}

function runList(target: Target, pkg: PackageInfo, skills: Skill[]): void {
  const rows = listSkills(skills, target, pkg);

  if (rows.length === 0) {
    console.log('This package ships no skills.');
    return;
  }

  for (const row of rows) {
    if (row.unmanaged) {
      console.log(`  ${row.skill.name}  ${pkg.version}  — a directory is present that this CLI did not install`);
    } else if (!row.installed) {
      console.log(`  ${row.skill.name}  ${pkg.version}  — not installed`);
    } else if (row.status === 'same') {
      console.log(`  ${row.skill.name}  ${pkg.version}  — installed, up to date`);
    } else if (row.status === 'outdated') {
      console.log(
        `  ${row.skill.name}  ${pkg.version}  — installed ${row.installed.version}, outdated; run \`update\``,
      );
    } else {
      console.log(
        `  ${row.skill.name}  ${pkg.version}  — installed ${row.installed.version}, differs`,
      );
    }
  }
}

function runUninstall(options: Options, target: Target, pkg: PackageInfo): void {
  if (options.names.length === 0) {
    throw new CliError('uninstall needs at least one skill name', USAGE);
  }

  const plan = planUninstall(options.names, target, pkg);

  if (options.dryRun) {
    console.log('Dry run — nothing will be removed.\n');
    for (const entry of plan) console.log(`  remove  ${entry.path}`);
    return;
  }

  for (const entry of plan) uninstallSkill(entry);

  console.log(`Removed from ${target.path}\n`);
  for (const entry of plan) console.log(`  ${entry.name}  ${entry.record.version}`);
}

/** The real side effects, kept in one place so `selfupdate.ts` has none. */
const RUNNER: Runner = {
  async fetchJson(url, headers, timeoutMs) {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`${url} responded ${response.status} ${response.statusText}`);
    return response.json();
  },

  run(line, capture) {
    const result = spawnSync(line.command, [...line.args], {
      encoding: 'utf8',
      // A captured run is asking npm a question; anything else is doing work the
      // user should watch happen.
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });

    if (result.error) return { status: -1, error: result.error.message };
    return {
      status: result.status ?? -1,
      stdout: result.stdout ?? undefined,
      error: (result.status ?? -1) === 0 ? undefined : (result.stderr || undefined),
    };
  },

  exists: (path) => existsSync(path),
};

function describeSkipped(row: UpdateRow): string {
  return row.disposition === 'unmanaged'
    ? `  ${row.skill.name}  — left alone; a directory is at ${row.destination} that this CLI did not install`
    : `  ${row.skill.name}  — not installed; run \`install\` to add it`;
}

/**
 * Report how each shipped skill compares, without writing anything.
 *
 * The comparison is against the version an update would actually bring — the
 * latest published one when it is known, and the packaged one when it is not.
 * Which of the two was used is printed, so a run that could not reach the
 * registry is never read as "you are up to date".
 */
async function runCheck(options: Options, target: Target, pkg: PackageInfo, skills: Skill[]): Promise<void> {
  let latest: LatestVersion | undefined;

  if (options.noSelfUpdate) {
    console.log(`CLI  ${pkg.version}  — not checked for a newer version (--no-self-update)`);
  } else if (pkg.version === DEVELOPMENT_VERSION) {
    // Ranking a working tree against the registry would report it as infinitely
    // out of date, which is true of the placeholder and of nothing else.
    console.log(`CLI  ${pkg.version}  — a development checkout, not compared against the registry`);
  } else {
    latest = await resolveLatest(pkg, RUNNER);
    if (!latest.ok) {
      console.error(`warning: could not check for a newer version: ${latest.reason}`);
      console.log(`CLI  ${pkg.version}  — latest unknown`);
    } else if (versionStatus(pkg.version, latest.version) === 'outdated') {
      console.log(`CLI  ${pkg.version}  — latest ${latest.version}, outdated; run \`update\``);
    } else {
      console.log(`CLI  ${pkg.version}  — latest ${latest.version}, up to date`);
    }
  }

  const reference = latest?.ok ? latest.version : pkg.version;
  console.log(`\nSkills, compared against ${reference}:\n`);

  for (const row of planUpdate(skills, target, pkg, false).rows) {
    if (row.disposition === 'absent') {
      console.log(`  ${row.skill.name}  — not installed`);
    } else if (row.disposition === 'unmanaged') {
      console.log(`  ${row.skill.name}  — a directory is present that this CLI did not install`);
    } else {
      const installed = row.installed!.version;
      const status = versionStatus(installed, reference);
      const label = status === 'same' ? 'up to date' : status === 'outdated' ? 'outdated' : 'differs';
      console.log(`  ${row.skill.name}  — installed ${installed}, ${label}`);
    }
  }
}

function reportPlannedSelfUpdate(mode: string, pkg: PackageInfo, latest: string, commands: CommandLine[]): void {
  console.log(`Self-update: running ${pkg.version}, latest ${latest} (installed as: ${mode})`);
  for (const line of commands) console.log(`  would run  ${formatCommand(line)}`);
  console.log('');
}

/**
 * Refresh installed skills, after bringing the CLI itself up to date.
 *
 * Returns the exit code: when a newer version was handed control, its exit code
 * is this run's, and the refresh below never happens in this process.
 */
async function runUpdate(options: Options, target: Target, pkg: PackageInfo, skills: Skill[]): Promise<number> {
  if (options.check) {
    console.log(`Target: ${target.path}\n`);
    await runCheck(options, target, pkg, skills);
    return 0;
  }

  if (options.force) {
    console.log('note: --force has no effect on update, which never replaces a directory it did not install.\n');
  }

  if (!options.noSelfUpdate) {
    const outcome = await selfUpdate({
      pkg,
      targetPath: target.path,
      dryRun: options.dryRun,
      runner: RUNNER,
      self: [process.execPath, process.argv[1]],
      announce: (message) => console.log(message),
    });

    for (const note of outcome.notes) console.error(`warning: ${note}`);

    switch (outcome.kind) {
      case 'handed-off':
        // The newer version has already done the work and printed the result.
        return outcome.status;
      case 'development':
        console.log(
          `Running from a development checkout (version ${DEVELOPMENT_VERSION}); not checking for a newer version.\n` +
            'Skills will be refreshed from this working tree.\n',
        );
        break;
      case 'current':
        console.log(`This CLI is already at the latest version, ${outcome.version}.\n`);
        break;
      case 'unchecked':
        console.error(`warning: could not check for a newer version: ${outcome.reason}`);
        console.log('Refreshing skills from this package instead.\n');
        break;
      case 'failed':
        console.error(`warning: could not run the newer version: ${outcome.reason}`);
        console.log('Refreshing skills from this package instead.\n');
        break;
      case 'planned':
        reportPlannedSelfUpdate(outcome.mode, pkg, outcome.latest, outcome.commands);
        break;
    }
  }

  // Reached only by the process that does the refresh itself, so the banner is
  // printed once no matter how many versions of this CLI were involved.
  console.log(`Target: ${target.path}\n`);

  const selected = requireSkills(options, skills);
  const plan = planUpdate(selected, target, pkg, options.names.length > 0);
  const skipped = plan.rows.filter((row) => row.disposition !== 'refresh');

  if (options.dryRun) {
    console.log('Dry run — nothing will be written.\n');
    for (const entry of plan.refreshes) console.log(`  replace  ${entry.destination}`);
    for (const row of skipped) console.log(describeSkipped(row));
    return 0;
  }

  if (plan.refreshes.length === 0) {
    console.log(`Nothing to update at ${target.path}.\n`);
    for (const row of skipped) console.log(describeSkipped(row));
    return 0;
  }

  sweepStaging(target.path);

  const updated: string[] = [];
  try {
    for (const entry of plan.refreshes) {
      installSkill(entry, pkg, target);
      updated.push(entry.skill.name);
    }
  } catch (error) {
    const done = updated.length > 0 ? `\nUpdated before the failure: ${updated.join(', ')}` : '';
    throw new CliError(`update failed: ${(error as Error).message}${done}`);
  }

  console.log(`Updated in ${target.path}\n`);
  for (const name of updated) console.log(`  ${name}  ${pkg.version}`);
  for (const row of skipped) console.log(describeSkipped(row));

  return 0;
}

async function main(argv: string[]): Promise<number> {
  const pkg = readPackageInfo();

  let options: Options;
  try {
    options = parse(argv);
  } catch (error) {
    if (error instanceof HelpRequested) {
      console.log(USAGE);
      return 0;
    }
    if (error instanceof VersionRequested) {
      console.log(pkg.version);
      return 0;
    }
    throw error;
  }

  const skills = discoverSkills(pkg);
  const target = await resolveTarget(options);

  // Printed on every run, interactive or not: the destination is the one thing
  // a caller most needs to be sure of, especially when it was never chosen.
  //
  // update prints it itself, and only when it is the process doing the work —
  // a run that hands off to a newer version would otherwise print the banner
  // twice, once from each process.
  if (options.command !== 'update') console.log(`Target: ${target.path}\n`);

  switch (options.command) {
    case 'install':
      runInstall(options, target, pkg, skills);
      break;
    case 'list':
      runList(target, pkg, skills);
      break;
    case 'uninstall':
      runUninstall(options, target, pkg);
      break;
    case 'update':
      return runUpdate(options, target, pkg, skills);
  }

  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    if (error instanceof CliError) {
      console.error(`error: ${error.message}`);
      if (error.detail) console.error(`\n${error.detail}`);
      process.exit(1);
    }
    console.error(error);
    process.exit(1);
  });
