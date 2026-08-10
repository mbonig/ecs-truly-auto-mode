import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { PACKAGE_NAME, preinstall, tempDir } from './harness';
import { CliError } from '../src/errors';
import { UpdateDisposition, planUpdate } from '../src/operations';
import { PackageInfo, Target } from '../src/paths';
import { interpretTargetAnswer, targetQuestion } from '../src/prompt';
import {
  CommandLine,
  RunOutcome,
  Runner,
  detectMode,
  registryBase,
  resolveLatest,
  selfUpdate,
} from '../src/selfupdate';
import { Skill } from '../src/skills';
import { compareVersions, versionStatus } from '../src/version';

describe('version comparison', () => {
  it('orders by numeric field', () => {
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
  });

  it('ignores anything after a prerelease or build marker', () => {
    expect(compareVersions('1.2.3-rc.1', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.3+build', '1.2.3')).toBe(0);
  });

  it('treats missing fields as zero', () => {
    expect(compareVersions('1', '1.0.0')).toBe(0);
    expect(compareVersions('1.1', '1.0.9')).toBe(1);
  });

  it('labels an older install outdated and an unequal one as differing', () => {
    expect(versionStatus('1.0.0', '2.0.0')).toBe('outdated');
    expect(versionStatus('2.0.0', '2.0.0')).toBe('same');
    expect(versionStatus('3.0.0', '2.0.0')).toBe('differs');
    // Equal numerically but not identical: reported as differing rather than
    // ranked, which is the honest answer from a comparison this shallow.
    expect(versionStatus('1.2.3-rc.1', '1.2.3')).toBe('differs');
  });
});

describe('the interactive target prompt', () => {
  it('offers both destinations and marks the default', () => {
    const question = targetQuestion();

    expect(question).toContain(join(homedir(), '.claude', 'skills'));
    expect(question).toContain(join(process.cwd(), '.claude', 'skills'));
    expect(question).toContain('[default]');
  });

  it('takes the user-global default when the answer is empty', () => {
    expect(interpretTargetAnswer('').path).toBe(join(homedir(), '.claude', 'skills'));
    expect(interpretTargetAnswer('  ').path).toBe(join(homedir(), '.claude', 'skills'));
    expect(interpretTargetAnswer('1').path).toBe(join(homedir(), '.claude', 'skills'));
  });

  it('takes the project-local option when the answer is 2', () => {
    expect(interpretTargetAnswer('2').path).toBe(join(process.cwd(), '.claude', 'skills'));
    expect(interpretTargetAnswer(' 2 \n').path).toBe(join(process.cwd(), '.claude', 'skills'));
  });

  it('treats an unrecognized answer as the default rather than an error', () => {
    expect(interpretTargetAnswer('yes').path).toBe(join(homedir(), '.claude', 'skills'));
  });
});

const PACKAGE: PackageInfo = { root: '/pkg', name: PACKAGE_NAME, version: '1.2.3' };

function skill(name: string): Skill {
  return { name, dir: join('/pkg', 'skills', name), assets: [] };
}

describe('update planning', () => {
  const target: Target = { kind: 'dir', path: '' };

  function classify(dir: string, names: string[]): Record<string, UpdateDisposition> {
    const skills = names.map(skill);
    const plan = planUpdate(skills, { ...target, path: dir }, PACKAGE, false);
    return Object.fromEntries(plan.rows.map((row) => [row.skill.name, row.disposition]));
  }

  it('classifies each destination by the record it carries', () => {
    const dir = tempDir();
    preinstall(dir, 'managed', { version: '1.0.0' });
    preinstall(dir, 'foreign', { package: 'some-other-package' });
    preinstall(dir, 'corrupt', { record: 'corrupt' });
    preinstall(dir, 'plain', { record: 'none' });

    expect(classify(dir, ['managed', 'foreign', 'corrupt', 'plain', 'missing'])).toEqual({
      managed: 'refresh',
      // A record from another package, an unreadable record, and no record at
      // all are the same answer: this CLI did not install it, so it is not
      // this CLI's to replace.
      foreign: 'unmanaged',
      corrupt: 'unmanaged',
      plain: 'unmanaged',
      missing: 'absent',
    });
  });

  it('plans a refresh only for the skills it may replace', () => {
    const dir = tempDir();
    preinstall(dir, 'managed');
    preinstall(dir, 'plain', { record: 'none' });

    const plan = planUpdate([skill('managed'), skill('plain')], { ...target, path: dir }, PACKAGE, false);

    expect(plan.refreshes.map((entry) => entry.skill.name)).toEqual(['managed']);
    expect(plan.refreshes[0].destination).toBe(join(dir, 'managed'));
  });

  it('reports the installed record for a skill it will refresh', () => {
    const dir = tempDir();
    preinstall(dir, 'managed', { version: '0.9.0' });

    const [row] = planUpdate([skill('managed')], { ...target, path: dir }, PACKAGE, false).rows;

    expect(row.installed?.version).toBe('0.9.0');
  });

  it('refuses a named skill that is not installed', () => {
    const dir = tempDir();

    expect(() => planUpdate([skill('missing')], { ...target, path: dir }, PACKAGE, true))
      .toThrow(CliError);
    expect(() => planUpdate([skill('missing')], { ...target, path: dir }, PACKAGE, true))
      .toThrow(/not installed/);
  });

  it('refuses a named directory it did not install', () => {
    const dir = tempDir();
    preinstall(dir, 'plain', { record: 'none' });

    expect(() => planUpdate([skill('plain')], { ...target, path: dir }, PACKAGE, true))
      .toThrow(/refusing to update/);
  });

  it('skips rather than refuses when nothing was named', () => {
    const dir = tempDir();
    preinstall(dir, 'plain', { record: 'none' });
    preinstall(dir, 'managed');

    const plan = planUpdate([skill('plain'), skill('managed')], { ...target, path: dir }, PACKAGE, false);

    expect(plan.refreshes.map((entry) => entry.skill.name)).toEqual(['managed']);
  });
});

interface Recording {
  readonly runner: Runner;
  readonly commands: CommandLine[];
  readonly fetched: string[];
}

interface FakeWorld {
  /** The document the registry returns, or an error to throw instead. */
  readonly latest?: string;
  readonly lookupError?: string;
  /** Exit codes keyed by the first argument of the command. */
  readonly statuses?: Record<string, number>;
  readonly prefix?: string;
  readonly exists?: boolean;
}

function recordingRunner(world: FakeWorld = {}): Recording {
  const commands: CommandLine[] = [];
  const fetched: string[] = [];

  const runner: Runner = {
    async fetchJson(url) {
      fetched.push(url);
      if (world.lookupError) throw new Error(world.lookupError);
      return { version: world.latest };
    },
    run(line, capture): RunOutcome {
      commands.push(line);
      if (capture && line.args[0] === 'prefix') {
        return world.prefix
          ? { status: 0, stdout: `${world.prefix}\n` }
          : { status: 1, error: 'no prefix' };
      }
      const status = world.statuses?.[line.args[0]] ?? 0;
      return status === 0 ? { status } : { status, error: `exited ${status}` };
    },
    exists: () => world.exists ?? false,
  };

  return { runner, commands, fetched };
}

const GLOBAL_ROOT = join(sep, 'usr', 'local', 'lib', 'node_modules', 'ecs-truly-auto-mode-skill');
const NPX_ROOT = join(sep, 'home', 'someone', '.npm', '_npx', 'abc123', 'node_modules', 'pkg');

describe('installation mode detection', () => {
  it('reads the version placeholder as a development checkout', () => {
    const { runner } = recordingRunner();
    expect(detectMode({ ...PACKAGE, version: '0.0.0' }, runner)).toBe('development');
  });

  it('reads a .projenrc.ts at the root as a development checkout', () => {
    const { runner } = recordingRunner({ exists: true });
    expect(detectMode(PACKAGE, runner)).toBe('development');
  });

  it('recognizes a package under the npm global prefix', () => {
    const { runner } = recordingRunner({ prefix: join(sep, 'usr', 'local') });
    expect(detectMode({ ...PACKAGE, root: GLOBAL_ROOT }, runner)).toBe('global');
  });

  it('recognizes an npx cache path', () => {
    const { runner } = recordingRunner({ prefix: join(sep, 'usr', 'local') });
    expect(detectMode({ ...PACKAGE, root: NPX_ROOT }, runner)).toBe('npx');
  });

  it('falls back to dependency when npm cannot say where the global prefix is', () => {
    const { runner } = recordingRunner();
    // No prefix, no _npx segment: the catch-all, whose action writes nothing
    // outside the skills directory.
    expect(detectMode(PACKAGE, runner)).toBe('dependency');
  });
});

describe('latest version resolution', () => {
  it('asks the configured registry', async () => {
    const { runner, fetched } = recordingRunner({ latest: '2.0.0' });

    const result = await resolveLatest(PACKAGE, runner, { npm_config_registry: 'https://registry.example/' });

    expect(result).toEqual({ ok: true, version: '2.0.0' });
    expect(fetched).toEqual([`https://registry.example/${PACKAGE_NAME}/latest`]);
  });

  it('defaults to the public registry', () => {
    expect(registryBase({})).toBe('https://registry.npmjs.org');
  });

  it('reports a reason rather than throwing when the lookup fails', async () => {
    const { runner } = recordingRunner({ lookupError: 'getaddrinfo ENOTFOUND' });

    const result = await resolveLatest(PACKAGE, runner, {});

    expect(result).toEqual({ ok: false, reason: 'getaddrinfo ENOTFOUND' });
  });

  it('treats a document with no version as a failed lookup', async () => {
    const { runner } = recordingRunner({ latest: undefined });

    expect(await resolveLatest(PACKAGE, runner, {})).toMatchObject({ ok: false });
  });
});

describe('self-update', () => {
  const SELF = ['/usr/bin/node', '/usr/local/bin/ecs-truly-auto-mode'];
  const request = (pkg: PackageInfo, runner: Runner, dryRun = false) => ({
    pkg,
    targetPath: '/target/skills',
    dryRun,
    runner,
    self: SELF,
  });

  it('does nothing at all from a development checkout', async () => {
    const { runner, commands, fetched } = recordingRunner({ latest: '9.9.9' });

    const outcome = await selfUpdate(request({ ...PACKAGE, version: '0.0.0' }, runner));

    expect(outcome.kind).toBe('development');
    expect(fetched).toEqual([]);
    expect(commands).toEqual([]);
  });

  it('upgrades a global install and then re-runs itself', async () => {
    const { runner, commands } = recordingRunner({ latest: '2.0.0', prefix: join(sep, 'usr', 'local') });

    const outcome = await selfUpdate(request({ ...PACKAGE, root: GLOBAL_ROOT }, runner));

    expect(outcome).toMatchObject({ kind: 'handed-off', latest: '2.0.0', status: 0 });
    expect(commands.slice(1)).toEqual([
      { command: expect.stringMatching(/^npm/), args: ['install', '-g', `${PACKAGE_NAME}@2.0.0`] },
      {
        command: SELF[0],
        args: [SELF[1], 'update', '--dir', '/target/skills', '--no-self-update'],
      },
    ]);
  });

  it('falls back to a one-off run when the global upgrade is refused', async () => {
    const { runner, commands } = recordingRunner({
      latest: '2.0.0',
      prefix: join(sep, 'usr', 'local'),
      statuses: { install: 243 },
    });

    const outcome = await selfUpdate(request({ ...PACKAGE, root: GLOBAL_ROOT }, runner));

    expect(outcome.kind).toBe('handed-off');
    expect(outcome.notes.join('\n')).toContain(join(sep, 'usr', 'local'));
    expect(outcome.notes.join('\n')).toContain('still 1.2.3');
    expect(commands[commands.length - 1]).toEqual({
      command: expect.stringMatching(/^npx/),
      args: ['-y', `${PACKAGE_NAME}@2.0.0`, 'update', '--dir', '/target/skills', '--no-self-update'],
    });
  });

  it('hands off through npx from an npx run', async () => {
    const { runner, commands } = recordingRunner({ latest: '2.0.0' });

    const outcome = await selfUpdate(request({ ...PACKAGE, root: NPX_ROOT }, runner));

    expect(outcome.kind).toBe('handed-off');
    expect(commands.filter((line) => line.args[0] === 'install')).toEqual([]);
    expect(commands[commands.length - 1].args).toEqual([
      '-y', `${PACKAGE_NAME}@2.0.0`, 'update', '--dir', '/target/skills', '--no-self-update',
    ]);
  });

  it('always disables self-update in the version it hands off to', async () => {
    for (const root of [GLOBAL_ROOT, NPX_ROOT, '/somewhere/else']) {
      const { runner, commands } = recordingRunner({ latest: '2.0.0', prefix: join(sep, 'usr', 'local') });

      await selfUpdate(request({ ...PACKAGE, root }, runner));

      // Without this the child would look the version up again and hand off
      // once more, forever.
      expect(commands[commands.length - 1].args).toContain('--no-self-update');
    }
  });

  it('carries --dry-run into the command it would run, and runs nothing', async () => {
    const { runner, commands } = recordingRunner({ latest: '2.0.0' });

    const outcome = await selfUpdate(request({ ...PACKAGE, root: NPX_ROOT }, runner));

    expect(outcome.kind).toBe('handed-off');
    expect(commands.length).toBeGreaterThan(0);

    const dry = recordingRunner({ latest: '2.0.0' });
    const planned = await selfUpdate(request({ ...PACKAGE, root: NPX_ROOT }, dry.runner, true));

    expect(planned).toMatchObject({ kind: 'planned', mode: 'npx', latest: '2.0.0' });
    // `npm prefix -g` is a question, not a change; nothing that alters anything
    // is run under --dry-run.
    expect(dry.commands.filter((line) => line.args[0] !== 'prefix')).toEqual([]);
    expect(planned.kind === 'planned' && planned.commands[0].args).toContain('--dry-run');
  });

  it('does nothing when the running version is not older', async () => {
    for (const version of ['2.0.0', '3.0.0']) {
      const { runner, commands } = recordingRunner({ latest: '2.0.0' });

      const outcome = await selfUpdate(request({ ...PACKAGE, root: NPX_ROOT, version }, runner));

      expect(outcome).toMatchObject({ kind: 'current', version: '2.0.0' });
      expect(commands.filter((line) => line.args[0] !== 'prefix')).toEqual([]);
    }
  });

  it('reports an unreachable registry without spawning anything', async () => {
    const { runner, commands } = recordingRunner({ lookupError: 'connect ECONNREFUSED' });

    const outcome = await selfUpdate(request({ ...PACKAGE, root: NPX_ROOT }, runner));

    expect(outcome).toMatchObject({ kind: 'unchecked', reason: 'connect ECONNREFUSED' });
    expect(commands.filter((line) => line.args[0] !== 'prefix')).toEqual([]);
  });

  it('reports a hand-off that could not run at all', async () => {
    const { runner } = recordingRunner({ latest: '2.0.0', statuses: { '-y': -1 } });

    const outcome = await selfUpdate(request({ ...PACKAGE, root: NPX_ROOT }, runner));

    expect(outcome).toMatchObject({ kind: 'failed' });
  });

  it('passes the exit code of the newer version back', async () => {
    const { runner } = recordingRunner({ latest: '2.0.0', statuses: { '-y': 7 } });

    const outcome = await selfUpdate(request({ ...PACKAGE, root: NPX_ROOT }, runner));

    expect(outcome).toMatchObject({ kind: 'handed-off', status: 7 });
  });
});
