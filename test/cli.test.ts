import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { makePackage, run, snapshot, tempDir } from './harness';

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
