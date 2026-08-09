import { SpawnSyncReturns, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '..');

export interface FakeSkill {
  /** Extra files to write inside the skill directory, keyed by relative path. */
  readonly files?: Record<string, string>;
  /** Asset copies to declare in skill.json. Omit for a skill with no assets. */
  readonly assets?: Array<{ from: string; to: string }>;
}

export interface FakePackage {
  /** Directories to create at the package root, keyed by relative path. */
  readonly assetDirs?: Record<string, Record<string, string>>;
  readonly skills?: Record<string, FakeSkill>;
  readonly version?: string;
  readonly name?: string;
}

const temporaries: string[] = [];

afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

export function tempDir(prefix = 'ecs-auto-mode-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaries.push(dir);
  return dir;
}

/**
 * Build a throwaway package containing the real compiled CLI and whatever skills
 * a test needs.
 *
 * Tests drive the CLI as a subprocess out of one of these rather than out of the
 * repository, so a test can control the package version and the set of skills —
 * which is what makes the version-comparison and unknown-skill paths reachable,
 * and what proves a second skill needs no installer change.
 */
export function makePackage(spec: FakePackage = {}): string {
  const root = tempDir('ecs-auto-mode-pkg-');

  const lib = join(REPO, 'lib');
  if (!existsSync(join(lib, 'cli.js'))) {
    throw new Error('lib/cli.js is missing — run `npx projen compile` before the tests');
  }
  cpSync(lib, join(root, 'lib'), { recursive: true });

  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify(
      { name: spec.name ?? '@matthewbonig/ecs-truly-auto-mode-skill', version: spec.version ?? '1.2.3' },
      null,
      2,
    ),
  );

  for (const [dir, files] of Object.entries(spec.assetDirs ?? {})) {
    mkdirSync(join(root, dir), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(root, dir, name), content);
    }
  }

  const skills = spec.skills ?? { 'demo-skill': {} };
  mkdirSync(join(root, 'skills'), { recursive: true });

  for (const [name, skill] of Object.entries(skills)) {
    const dir = join(root, 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `# ${name}\n`);

    for (const [file, content] of Object.entries(skill.files ?? {})) {
      const full = join(dir, file);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content);
    }

    if (skill.assets) {
      writeFileSync(join(dir, 'skill.json'), JSON.stringify({ name, assets: skill.assets }, null, 2));
    }
  }

  return root;
}

export interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly all: string;
}

/** Run the CLI from a fake package. stdin is a pipe, so it is never a TTY. */
export function run(pkgRoot: string, args: string[], cwd?: string): RunResult {
  const result: SpawnSyncReturns<string> = spawnSync(
    process.execPath,
    [join(pkgRoot, 'lib', 'cli.js'), ...args],
    { encoding: 'utf8', cwd: cwd ?? pkgRoot, input: '' },
  );

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { status: result.status ?? -1, stdout, stderr, all: `${stdout}${stderr}` };
}

/** A directory tree as a sorted list of relative paths, for comparing before and after. */
export function snapshot(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const walk = (current: string, prefix: string): string[] => {
    return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? [rel, ...walk(join(current, entry.name), rel)] : [rel];
    });
  };
  return walk(dir, '').sort();
}
