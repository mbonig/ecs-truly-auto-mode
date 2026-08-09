#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { CliError } from './errors';
import {
  PlannedInstall,
  conflictsIn,
  ensureTargetExists,
  installSkill,
  listSkills,
  planInstall,
  planUninstall,
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
import { Skill, discoverSkills, findSkill } from './skills';

const COMMANDS = ['install', 'list', 'uninstall'] as const;
type Command = (typeof COMMANDS)[number];

const PACKAGE = '@matthewbonig/ecs-truly-auto-mode-skill';

const USAGE = `ecs-truly-auto-mode — install Claude Code skills

Usage:
  npx ${PACKAGE} [install] [skill...]   install skills (all of them if none named)
  npx ${PACKAGE} list                   show shipped skills and what is installed
  npx ${PACKAGE} uninstall <skill...>   remove installed skills

Installed globally, the command is: ecs-truly-auto-mode

Where to install:
  --user            ~/.claude/skills (the default)
  --project         ./.claude/skills
  --dir <path>      an explicit directory

Options:
  --force           replace a skill that is already installed
  --dry-run         report what would happen and write nothing
  --help            show this message
  --version         show the version of this package`;

interface Options {
  readonly command: Command;
  readonly names: string[];
  readonly user: boolean;
  readonly project: boolean;
  readonly dir?: string;
  readonly force: boolean;
  readonly dryRun: boolean;
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

  return {
    command,
    names,
    user: values.user as boolean,
    project: values.project as boolean,
    dir: values.dir as string | undefined,
    force: values.force as boolean,
    dryRun: values['dry-run'] as boolean,
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
        `  ${row.skill.name}  ${pkg.version}  — installed ${row.installed.version}, outdated`,
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
  console.log(`Target: ${target.path}\n`);

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
