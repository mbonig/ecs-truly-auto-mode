import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { makePackage, preinstall, run, runAsync, snapshot, startRegistry, tempDir } from './harness';

const TWO_SKILLS = {
  skills: { 'skill-one': {}, 'skill-two': {} },
};

describe('invocation', () => {
  it('defaults to install when no command is given', () => {
    const pkg = makePackage();
    const target = tempDir();

    const result = run(pkg, ['--dir', target]);

    expect(result.status).toBe(0);
    expect(existsSync(join(target, 'demo-skill', 'SKILL.md'))).toBe(true);
  });

  it('prints usage and exits non-zero on an unknown command', () => {
    const pkg = makePackage();
    const target = tempDir();

    const result = run(pkg, ['frobnicate', '--dir', target]);

    // "frobnicate" is not a command, so it is read as a skill name — and there is
    // no such skill. Either way the run must refuse and write nothing.
    expect(result.status).not.toBe(0);
    expect(snapshot(target)).toEqual([]);
  });

  it('rejects an unknown flag without writing anything', () => {
    const pkg = makePackage();
    const target = tempDir();

    const result = run(pkg, ['install', '--nonsense', '--dir', target]);

    expect(result.status).not.toBe(0);
    expect(result.all).toContain('Usage:');
    expect(snapshot(target)).toEqual([]);
  });

  it('prints help and exits zero', () => {
    const result = run(makePackage(), ['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
  });

  it('prints the package version', () => {
    const result = run(makePackage({ version: '4.5.6' }), ['--version']);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('4.5.6');
  });
});

describe('target resolution', () => {
  it('installs into an explicit --dir', () => {
    const pkg = makePackage();
    const target = tempDir();

    const result = run(pkg, ['install', '--dir', target]);

    expect(result.status).toBe(0);
    expect(existsSync(join(target, 'demo-skill'))).toBe(true);
  });

  it('resolves --project against the working directory', () => {
    const pkg = makePackage();
    const cwd = tempDir();

    const result = run(pkg, ['install', '--project'], cwd);

    expect(result.status).toBe(0);
    expect(existsSync(join(cwd, '.claude', 'skills', 'demo-skill'))).toBe(true);
  });

  it('does not prompt when stdin is not a TTY, and reports where it chose', () => {
    // Deliberately not passing a target flag. With no TTY the default applies,
    // and the run must not block waiting for an answer nobody can give.
    const result = run(makePackage(), ['list']);

    expect(result.status).toBe(0);
    expect(result.all).not.toContain('Choose 1 or 2');
    expect(result.stdout).toContain(join(homedir(), '.claude', 'skills'));
  });

  it('refuses conflicting target flags', () => {
    const target = tempDir();

    const result = run(makePackage(), ['install', '--user', '--project', '--dir', target]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/cannot be combined/);
    expect(snapshot(target)).toEqual([]);
  });

  it('creates the destination including missing parents', () => {
    const pkg = makePackage();
    const target = join(tempDir(), 'deeply', 'nested', 'skills');

    const result = run(pkg, ['install', '--dir', target]);

    expect(result.status).toBe(0);
    expect(existsSync(join(target, 'demo-skill', 'SKILL.md'))).toBe(true);
  });

  it('prints the resolved destination on every run', () => {
    const target = tempDir();

    const result = run(makePackage(), ['install', '--dir', target]);

    expect(result.stdout).toContain(target);
  });
});

describe('skill selection', () => {
  it('installs only the named skill', () => {
    const pkg = makePackage(TWO_SKILLS);
    const target = tempDir();

    run(pkg, ['install', 'skill-one', '--dir', target]);

    expect(existsSync(join(target, 'skill-one'))).toBe(true);
    expect(existsSync(join(target, 'skill-two'))).toBe(false);
  });

  it('installs every shipped skill when none is named', () => {
    const pkg = makePackage(TWO_SKILLS);
    const target = tempDir();

    const result = run(pkg, ['install', '--dir', target]);

    expect(result.status).toBe(0);
    expect(existsSync(join(target, 'skill-one'))).toBe(true);
    expect(existsSync(join(target, 'skill-two'))).toBe(true);
  });

  it('reports an unknown skill alongside the available ones, writing nothing', () => {
    const pkg = makePackage(TWO_SKILLS);
    const target = tempDir();

    const result = run(pkg, ['install', 'skill-one', 'nope', '--dir', target]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('nope');
    expect(result.stderr).toContain('skill-one');
    expect(result.stderr).toContain('skill-two');
    expect(snapshot(target)).toEqual([]);
  });

  it('ignores a directory under skills/ that has no SKILL.md', () => {
    const pkg = makePackage(TWO_SKILLS);
    mkdirSync(join(pkg, 'skills', 'not-a-skill'), { recursive: true });
    writeFileSync(join(pkg, 'skills', 'not-a-skill', 'README.md'), 'nope');
    const target = tempDir();

    const result = run(pkg, ['install', '--dir', target]);

    expect(result.status).toBe(0);
    expect(existsSync(join(target, 'not-a-skill'))).toBe(false);
  });
});

describe('assets', () => {
  it('copies declared assets into the installed skill', () => {
    const pkg = makePackage({
      assetDirs: { templates: { 'stack.ts': 'export const stack = 1;\n' } },
      skills: { 'demo-skill': { assets: [{ from: 'templates', to: 'assets/templates' }] } },
    });
    const target = tempDir();

    run(pkg, ['install', '--dir', target]);

    expect(readFileSync(join(target, 'demo-skill', 'assets', 'templates', 'stack.ts'), 'utf8')).toContain(
      'export const stack',
    );
  });

  it('fails when a declared asset does not exist in the package', () => {
    const pkg = makePackage({
      skills: { 'demo-skill': { assets: [{ from: 'missing-dir', to: 'assets/x' }] } },
    });
    const target = tempDir();

    const result = run(pkg, ['install', '--dir', target]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('missing-dir');
    expect(snapshot(target)).toEqual([]);
  });

  it('refuses an asset target that escapes the skill directory', () => {
    const pkg = makePackage({
      assetDirs: { templates: { 'x.txt': 'x' } },
      skills: { 'demo-skill': { assets: [{ from: 'templates', to: '../escaped' }] } },
    });
    const target = tempDir();

    const result = run(pkg, ['install', '--dir', target]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/escapes/);
    expect(existsSync(join(target, 'escaped'))).toBe(false);
  });
});

describe('overwrite protection', () => {
  it('refuses to overwrite an existing install without --force', () => {
    const pkg = makePackage({ version: '1.0.0' });
    const target = tempDir();
    run(pkg, ['install', '--dir', target]);

    const newer = makePackage({ version: '2.0.0' });
    const result = run(newer, ['install', '--dir', target]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('1.0.0');
    expect(result.stderr).toContain('2.0.0');
    expect(result.stderr).toContain('--force');
  });

  it('still refuses when the versions are the same, and says so', () => {
    const pkg = makePackage({ version: '1.0.0' });
    const target = tempDir();
    run(pkg, ['install', '--dir', target]);

    const result = run(pkg, ['install', '--dir', target]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('the same version');
  });

  it('replaces the install with --force, leaving no file from the previous one', () => {
    const first = makePackage({
      version: '1.0.0',
      skills: { 'demo-skill': { files: { 'stale.md': 'from the old install' } } },
    });
    const target = tempDir();
    run(first, ['install', '--dir', target]);
    expect(existsSync(join(target, 'demo-skill', 'stale.md'))).toBe(true);

    const second = makePackage({ version: '2.0.0' });
    const result = run(second, ['install', '--force', '--dir', target]);

    expect(result.status).toBe(0);
    expect(existsSync(join(target, 'demo-skill', 'stale.md'))).toBe(false);
    expect(existsSync(join(target, 'demo-skill', 'SKILL.md'))).toBe(true);
  });

  it('installs nothing when one skill of a batch is blocked', () => {
    const pkg = makePackage(TWO_SKILLS);
    const target = tempDir();
    run(pkg, ['install', 'skill-one', '--dir', target]);

    const before = snapshot(target);
    const result = run(pkg, ['install', '--dir', target]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('skill-one');
    expect(existsSync(join(target, 'skill-two'))).toBe(false);
    expect(snapshot(target)).toEqual(before);
  });

  it('leaves no staging directory behind after a successful install', () => {
    const pkg = makePackage();
    const target = tempDir();

    run(pkg, ['install', '--dir', target]);

    expect(snapshot(target).filter((p) => p.includes('.tmp-') || p.includes('.old-'))).toEqual([]);
  });
});

describe('dry run', () => {
  it('reports the plan and writes nothing', () => {
    const pkg = makePackage();
    const target = tempDir();

    const result = run(pkg, ['install', '--dry-run', '--dir', target]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Dry run');
    expect(snapshot(target)).toEqual([]);
  });

  it('reports the overwrite conflict a real run would report, and writes nothing', () => {
    const pkg = makePackage({ version: '1.0.0' });
    const target = tempDir();
    run(pkg, ['install', '--dir', target]);
    const before = snapshot(target);

    const result = run(makePackage({ version: '2.0.0' }), ['install', '--dry-run', '--dir', target]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--force');
    expect(snapshot(target)).toEqual(before);
  });

  it('reports an uninstall plan without removing anything', () => {
    const pkg = makePackage();
    const target = tempDir();
    run(pkg, ['install', '--dir', target]);
    const before = snapshot(target);

    const result = run(pkg, ['uninstall', 'demo-skill', '--dry-run', '--dir', target]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Dry run');
    expect(snapshot(target)).toEqual(before);
  });
});

describe('list', () => {
  it('marks a skill that is not installed', () => {
    const result = run(makePackage(), ['list', '--dir', tempDir()]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('not installed');
  });

  it('marks an up-to-date install', () => {
    const pkg = makePackage({ version: '1.0.0' });
    const target = tempDir();
    run(pkg, ['install', '--dir', target]);

    const result = run(pkg, ['list', '--dir', target]);

    expect(result.stdout).toContain('up to date');
  });

  it('marks an outdated install and shows both versions', () => {
    const target = tempDir();
    run(makePackage({ version: '1.0.0' }), ['install', '--dir', target]);

    const result = run(makePackage({ version: '2.0.0' }), ['list', '--dir', target]);

    expect(result.stdout).toContain('outdated');
    expect(result.stdout).toContain('1.0.0');
    expect(result.stdout).toContain('2.0.0');
  });

  it('creates nothing, not even the destination directory', () => {
    const target = join(tempDir(), 'does-not-exist');

    const result = run(makePackage(), ['list', '--dir', target]);

    expect(result.status).toBe(0);
    expect(existsSync(target)).toBe(false);
  });
});

describe('uninstall', () => {
  it('removes the named skill and leaves the others alone', () => {
    const pkg = makePackage(TWO_SKILLS);
    const target = tempDir();
    run(pkg, ['install', '--dir', target]);

    const result = run(pkg, ['uninstall', 'skill-one', '--dir', target]);

    expect(result.status).toBe(0);
    expect(existsSync(join(target, 'skill-one'))).toBe(false);
    expect(existsSync(join(target, 'skill-two', 'SKILL.md'))).toBe(true);
  });

  it('exits non-zero when the skill is not installed', () => {
    const result = run(makePackage(), ['uninstall', 'demo-skill', '--dir', tempDir()]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('not installed');
  });

  it('requires a skill name', () => {
    const pkg = makePackage();
    const target = tempDir();
    run(pkg, ['install', '--dir', target]);

    const result = run(pkg, ['uninstall', '--dir', target]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/at least one skill name/);
    expect(existsSync(join(target, 'demo-skill'))).toBe(true);
  });

  it('refuses to remove a directory it did not install', () => {
    const target = tempDir();
    // A directory the user wrote themselves. Deleting this would be the worst
    // thing this tool could do.
    mkdirSync(join(target, 'demo-skill'), { recursive: true });
    writeFileSync(join(target, 'demo-skill', 'SKILL.md'), '# hand written\n');

    const result = run(makePackage(), ['uninstall', 'demo-skill', '--dir', target]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/refusing to remove/);
    expect(existsSync(join(target, 'demo-skill', 'SKILL.md'))).toBe(true);
  });

  it('refuses when the install record belongs to a different package', () => {
    const target = tempDir();
    run(makePackage({ name: 'some-other-package' }), ['install', '--dir', target]);

    const result = run(makePackage(), ['uninstall', 'demo-skill', '--dir', target]);

    expect(result.status).not.toBe(0);
    expect(existsSync(join(target, 'demo-skill'))).toBe(true);
  });
});

describe('scope of filesystem effects', () => {
  it('does not create or modify any Claude Code settings file', () => {
    const pkg = makePackage();
    const cwd = tempDir();

    run(pkg, ['install', '--project'], cwd);

    expect(existsSync(join(cwd, '.claude', 'settings.json'))).toBe(false);
    expect(existsSync(join(cwd, '.claude', 'settings.local.json'))).toBe(false);
    expect(snapshot(join(cwd, '.claude')).filter((p) => p.endsWith('.json'))).toEqual([
      'skills/demo-skill/.installed.json',
    ]);
  });

  it('leaves neighbouring skills untouched', () => {
    const target = tempDir();
    mkdirSync(join(target, 'someone-elses-skill'), { recursive: true });
    writeFileSync(join(target, 'someone-elses-skill', 'SKILL.md'), '# theirs\n');
    const before = snapshot(join(target, 'someone-elses-skill'));

    run(makePackage(), ['install', '--dir', target]);

    expect(snapshot(join(target, 'someone-elses-skill'))).toEqual(before);
    expect(readFileSync(join(target, 'someone-elses-skill', 'SKILL.md'), 'utf8')).toBe('# theirs\n');
  });
});

describe('failure handling', () => {
  const rootless = process.getuid?.() !== 0 ? it : it.skip;

  rootless('exits non-zero on an unwritable destination and leaves no partial skill', () => {
    const pkg = makePackage();
    const parent = tempDir();
    const target = join(parent, 'skills');
    mkdirSync(target);
    chmodSync(target, 0o500);

    try {
      const result = run(pkg, ['install', '--dir', target]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).not.toBe('');
      expect(snapshot(target)).toEqual([]);
    } finally {
      chmodSync(target, 0o700);
    }
  });
});

describe('the install record', () => {
  it('records the skill, package, and version', () => {
    const pkg = makePackage({ version: '3.1.4' });
    const target = tempDir();

    run(pkg, ['install', '--dir', target]);

    const record = JSON.parse(readFileSync(join(target, 'demo-skill', '.installed.json'), 'utf8'));
    expect(record.skill).toBe('demo-skill');
    expect(record.package).toBe('@matthewbonig/ecs-truly-auto-mode-skill');
    expect(record.version).toBe('3.1.4');
  });

  it('tolerates the 0.0.0 placeholder a working tree carries', () => {
    const pkg = makePackage({ version: '0.0.0' });
    const target = tempDir();

    const result = run(pkg, ['install', '--dir', target]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('0.0.0');
  });
});

describe('update', () => {
  const OFFLINE = { npm_config_registry: 'http://127.0.0.1:1' };

  it('replaces an outdated skill without --force', () => {
    const pkg = makePackage({ version: '2.0.0' });
    const target = tempDir();
    preinstall(target, 'demo-skill', { version: '1.0.0', files: { 'stale.md': 'gone soon\n' } });

    const result = run(pkg, ['update', '--no-self-update', '--dir', target]);

    expect(result.status).toBe(0);
    const record = JSON.parse(readFileSync(join(target, 'demo-skill', '.installed.json'), 'utf8'));
    expect(record.version).toBe('2.0.0');
    // The whole directory is replaced, so a file the new version does not ship
    // cannot survive the update.
    expect(existsSync(join(target, 'demo-skill', 'stale.md'))).toBe(false);
    expect(readFileSync(join(target, 'demo-skill', 'SKILL.md'), 'utf8')).toBe('# demo-skill\n');
  });

  it('refreshes a skill that is already at the packaged version', () => {
    const pkg = makePackage({ version: '2.0.0' });
    const target = tempDir();
    preinstall(target, 'demo-skill', { version: '2.0.0', files: { 'stale.md': 'gone soon\n' } });

    const result = run(pkg, ['update', '--no-self-update', '--dir', target]);

    expect(result.status).toBe(0);
    expect(existsSync(join(target, 'demo-skill', 'stale.md'))).toBe(false);
  });

  it('refreshes every installed skill when none is named', () => {
    const pkg = makePackage({ ...TWO_SKILLS, version: '2.0.0' });
    const target = tempDir();
    preinstall(target, 'skill-one', { version: '1.0.0' });
    preinstall(target, 'skill-two', { version: '1.0.0' });

    const result = run(pkg, ['update', '--no-self-update', '--dir', target]);

    expect(result.status).toBe(0);
    for (const name of ['skill-one', 'skill-two']) {
      const record = JSON.parse(readFileSync(join(target, name, '.installed.json'), 'utf8'));
      expect(record.version).toBe('2.0.0');
    }
  });

  it('refreshes only the named skill', () => {
    const pkg = makePackage({ ...TWO_SKILLS, version: '2.0.0' });
    const target = tempDir();
    preinstall(target, 'skill-one', { version: '1.0.0' });
    preinstall(target, 'skill-two', { version: '1.0.0' });
    const untouched = readFileSync(join(target, 'skill-two', 'SKILL.md'), 'utf8');

    const result = run(pkg, ['update', 'skill-one', '--no-self-update', '--dir', target]);

    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(join(target, 'skill-one', '.installed.json'), 'utf8')).version).toBe('2.0.0');
    expect(JSON.parse(readFileSync(join(target, 'skill-two', '.installed.json'), 'utf8')).version).toBe('1.0.0');
    expect(readFileSync(join(target, 'skill-two', 'SKILL.md'), 'utf8')).toBe(untouched);
  });

  it('reports an unknown skill name and writes nothing', () => {
    const pkg = makePackage({ version: '2.0.0' });
    const target = tempDir();
    preinstall(target, 'demo-skill', { version: '1.0.0' });

    const result = run(pkg, ['update', 'nonesuch', '--no-self-update', '--dir', target]);

    expect(result.status).not.toBe(0);
    expect(JSON.parse(readFileSync(join(target, 'demo-skill', '.installed.json'), 'utf8')).version).toBe('1.0.0');
  });

  describe('what it may replace', () => {
    for (const force of [[], ['--force']]) {
      const label = force.length > 0 ? ' even with --force' : '';

      it(`skips a directory it did not install and updates the rest${label}`, () => {
        const pkg = makePackage({ ...TWO_SKILLS, version: '2.0.0' });
        const target = tempDir();
        preinstall(target, 'skill-one', { version: '1.0.0' });
        preinstall(target, 'skill-two', { record: 'none', files: { 'mine.md': 'hand written\n' } });

        const result = run(pkg, ['update', ...force, '--no-self-update', '--dir', target]);

        expect(result.status).toBe(0);
        expect(JSON.parse(readFileSync(join(target, 'skill-one', '.installed.json'), 'utf8')).version).toBe('2.0.0');
        expect(readFileSync(join(target, 'skill-two', 'mine.md'), 'utf8')).toBe('hand written\n');
        expect(existsSync(join(target, 'skill-two', '.installed.json'))).toBe(false);
        expect(result.stdout).toContain('did not install');
      });

      it(`refuses when that directory is named explicitly${label}`, () => {
        const pkg = makePackage({ version: '2.0.0' });
        const target = tempDir();
        preinstall(target, 'demo-skill', { record: 'none', files: { 'mine.md': 'hand written\n' } });
        const before = snapshot(target);

        const result = run(pkg, ['update', 'demo-skill', ...force, '--no-self-update', '--dir', target]);

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('refusing to update');
        expect(snapshot(target)).toEqual(before);
      });
    }

    it('leaves a skill installed by another package alone', () => {
      const pkg = makePackage({ version: '2.0.0' });
      const target = tempDir();
      preinstall(target, 'demo-skill', { package: 'some-other-package', version: '1.0.0' });

      const result = run(pkg, ['update', '--no-self-update', '--dir', target]);

      expect(result.status).toBe(0);
      expect(JSON.parse(readFileSync(join(target, 'demo-skill', '.installed.json'), 'utf8')).package)
        .toBe('some-other-package');
    });
  });

  describe('what it will not add', () => {
    it('does not install a skill that is not installed', () => {
      const pkg = makePackage({ ...TWO_SKILLS, version: '2.0.0' });
      const target = tempDir();
      preinstall(target, 'skill-one', { version: '1.0.0' });

      const result = run(pkg, ['update', '--no-self-update', '--dir', target]);

      expect(result.status).toBe(0);
      expect(existsSync(join(target, 'skill-two'))).toBe(false);
      expect(result.stdout).toContain('run `install`');
    });

    it('refuses a named skill that is not installed', () => {
      const pkg = makePackage({ version: '2.0.0' });
      const target = tempDir();

      const result = run(pkg, ['update', 'demo-skill', '--no-self-update', '--dir', target]);

      expect(result.status).not.toBe(0);
      expect(snapshot(target)).toEqual([]);
    });

    it('reports nothing to update and exits zero', () => {
      const pkg = makePackage({ version: '2.0.0' });
      const target = tempDir();

      const result = run(pkg, ['update', '--no-self-update', '--dir', target]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Nothing to update');
      expect(snapshot(target)).toEqual([]);
    });
  });

  describe('--check', () => {
    it('reports the CLI and each skill against the latest published version', async () => {
      const registry = await startRegistry('9.9.9');
      const pkg = makePackage({ ...TWO_SKILLS, version: '2.0.0' });
      const parent = tempDir();
      const target = join(parent, 'skills');
      mkdirSync(target);
      preinstall(target, 'skill-one', { version: '1.0.0' });
      const before = snapshot(target);

      try {
        const result = await runAsync(pkg, ['update', '--check', '--dir', target], undefined, {
          npm_config_registry: registry.url,
        });

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('CLI  2.0.0  — latest 9.9.9, outdated');
        expect(result.stdout).toContain('skill-one  — installed 1.0.0, outdated');
        expect(result.stdout).toContain('skill-two  — not installed');
        expect(snapshot(target)).toEqual(before);
      } finally {
        await registry.close();
      }
    });

    it('creates nothing, not even the destination', async () => {
      const registry = await startRegistry('9.9.9');
      const pkg = makePackage({ version: '2.0.0' });
      const target = join(tempDir(), 'skills');

      try {
        const result = await runAsync(pkg, ['update', '--check', '--dir', target], undefined, {
          npm_config_registry: registry.url,
        });

        expect(result.status).toBe(0);
        expect(existsSync(target)).toBe(false);
      } finally {
        await registry.close();
      }
    });

    it('says which comparison it made when the registry is not consulted', () => {
      const pkg = makePackage({ version: '2.0.0' });
      const target = tempDir();
      preinstall(target, 'demo-skill', { version: '1.0.0' });

      const result = run(pkg, ['update', '--check', '--no-self-update', '--dir', target], undefined, OFFLINE);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('not checked for a newer version');
      expect(result.stdout).toContain('compared against 2.0.0');
      expect(result.stdout).not.toContain('up to date\n\nSkills');
    });
  });

  describe('--dry-run', () => {
    it('prints the hand-off it would perform and changes nothing', async () => {
      const registry = await startRegistry('9.9.9');
      const pkg = makePackage({ version: '2.0.0' });
      const target = tempDir();
      preinstall(target, 'demo-skill', { version: '1.0.0' });
      const before = snapshot(target);

      try {
        const result = await runAsync(pkg, ['update', '--dry-run', '--dir', target], undefined, {
          npm_config_registry: registry.url,
        });

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('running 2.0.0, latest 9.9.9');
        expect(result.stdout).toContain('would run  npx');
        // The command it prints is the one it would run — including the flag
        // that stops the newer version handing off again.
        expect(result.stdout).toContain('--no-self-update --dry-run');
        expect(result.stdout).toContain(`replace  ${join(target, 'demo-skill')}`);
        expect(snapshot(target)).toEqual(before);
      } finally {
        await registry.close();
      }
    });

    it('names what it would skip', () => {
      const pkg = makePackage({ ...TWO_SKILLS, version: '2.0.0' });
      const target = tempDir();
      preinstall(target, 'skill-one', { record: 'none' });
      const before = snapshot(target);

      const result = run(pkg, ['update', '--dry-run', '--no-self-update', '--dir', target]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('did not install');
      expect(result.stdout).toContain('not installed; run `install`');
      expect(snapshot(target)).toEqual(before);
    });
  });

  it('warns and refreshes from this package when the registry cannot be reached', () => {
    const pkg = makePackage({ version: '2.0.0' });
    const target = tempDir();
    preinstall(target, 'demo-skill', { version: '1.0.0' });

    const result = run(pkg, ['update', '--dir', target], undefined, OFFLINE);

    expect(result.status).toBe(0);
    expect(result.all).toContain('could not check for a newer version');
    // A failed check must never read as a clean bill of health.
    expect(result.all).not.toContain('already at the latest version');
    expect(JSON.parse(readFileSync(join(target, 'demo-skill', '.installed.json'), 'utf8')).version).toBe('2.0.0');
  });

  it('reports a development checkout and never looks anything up', () => {
    const pkg = makePackage({ version: '0.0.0' });
    const target = tempDir();
    preinstall(target, 'demo-skill', { version: '0.0.0' });

    const result = run(pkg, ['update', '--dir', target], undefined, OFFLINE);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('development checkout');
    expect(result.all).not.toContain('could not check');
  });

  it('rejects the update flags on the other commands', () => {
    const pkg = makePackage();
    const target = tempDir();

    for (const command of ['install', 'list', 'uninstall']) {
      for (const flag of ['--check', '--no-self-update']) {
        const result = run(pkg, [command, flag, '--dir', target]);
        expect(result.status).not.toBe(0);
        expect(result.all).toContain('only applies to update');
      }
    }
  });

  it('lists update in the usage text', () => {
    const result = run(makePackage(), ['--help']);

    expect(result.stdout).toContain('update [skill...]');
    expect(result.stdout).toContain('--check');
    expect(result.stdout).toContain('--no-self-update');
  });

  describe('scope of filesystem effects', () => {
    it('touches no Claude Code settings file and no other package\'s skills', () => {
      const pkg = makePackage({ version: '2.0.0' });
      const cwd = tempDir();
      const target = join(cwd, '.claude', 'skills');
      mkdirSync(target, { recursive: true });
      preinstall(target, 'demo-skill', { version: '1.0.0' });
      preinstall(target, 'theirs', { package: 'another-package' });
      const theirs = snapshot(join(target, 'theirs'));

      const result = run(pkg, ['update', '--no-self-update', '--project'], cwd, OFFLINE);

      expect(result.status).toBe(0);
      expect(existsSync(join(cwd, '.claude', 'settings.json'))).toBe(false);
      expect(snapshot(join(target, 'theirs'))).toEqual(theirs);
    });
  });

  describe('failure handling', () => {
    const rootless = process.getuid?.() !== 0 ? it : it.skip;

    rootless('exits non-zero on an unwritable destination and leaves nothing half-written', () => {
      const pkg = makePackage({ version: '2.0.0' });
      const target = tempDir();
      preinstall(target, 'demo-skill', { version: '1.0.0' });
      const before = snapshot(target);
      chmodSync(target, 0o500);

      try {
        const result = run(pkg, ['update', '--no-self-update', '--dir', target]);

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('update failed');
      } finally {
        chmodSync(target, 0o700);
      }

      // The old skill is still there, and no staging directory was left behind.
      expect(snapshot(target)).toEqual(before);
    });
  });

  it('never lets a test spawn a global install', () => {
    const source = readFileSync(__filename, 'utf8');
    const invocations = source.match(/runA?s?y?n?c?\(\s*pkg,\s*\[\s*'update'[\s\S]*?\);/g) ?? [];

    expect(invocations.length).toBeGreaterThan(0);
    for (const invocation of invocations) {
      // Every CLI-level update run has to be one that cannot reach `npm install
      // -g`: either self-update is off, or the run is a read-only one, or the
      // registry is a closed port so the lookup fails before anything spawns.
      // The upgrade argv is asserted through the injected runner instead.
      expect(invocation).toMatch(/--no-self-update|--check|--dry-run|OFFLINE/);
    }
  });
});
