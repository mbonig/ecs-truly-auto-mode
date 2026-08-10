import { SpawnSyncReturns, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
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

export const PACKAGE_NAME = '@matthewbonig/ecs-truly-auto-mode-skill';

export interface PreinstalledSkill {
  /** The version to record. Ignored when no record is written. */
  readonly version?: string;
  /** The package to record as the installer — a foreign name makes it unmanaged. */
  readonly package?: string;
  /** How to write the install record, or `none` for a directory this CLI never installed. */
  readonly record?: 'valid' | 'corrupt' | 'none';
  /** Extra files, keyed by relative path — useful for proving a stale file is gone. */
  readonly files?: Record<string, string>;
}

/**
 * Put a skill directory at a destination without going through the CLI.
 *
 * Update's whole safety story is about what it finds already sitting there, so
 * tests need to fabricate each case directly: installed by this package,
 * installed by another one, and a directory with no record at all.
 */
export function preinstall(target: string, name: string, spec: PreinstalledSkill = {}): string {
  const dir = join(target, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `# ${name} (pre-installed)\n`);

  for (const [file, content] of Object.entries(spec.files ?? {})) {
    const full = join(dir, file);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }

  const record = spec.record ?? 'valid';
  if (record === 'corrupt') {
    writeFileSync(join(dir, '.installed.json'), '{ not json');
  } else if (record === 'valid') {
    writeFileSync(
      join(dir, '.installed.json'),
      JSON.stringify(
        {
          skill: name,
          package: spec.package ?? PACKAGE_NAME,
          version: spec.version ?? '1.0.0',
          installedAt: new Date(0).toISOString(),
        },
        null,
        2,
      ),
    );
  }

  return dir;
}

export interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly all: string;
}

/** Run the CLI from a fake package. stdin is a pipe, so it is never a TTY. */
export function run(
  pkgRoot: string,
  args: string[],
  cwd?: string,
  env?: Record<string, string>,
): RunResult {
  const result: SpawnSyncReturns<string> = spawnSync(
    process.execPath,
    [join(pkgRoot, 'lib', 'cli.js'), ...args],
    { encoding: 'utf8', cwd: cwd ?? pkgRoot, input: '', env: { ...process.env, ...env } },
  );

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { status: result.status ?? -1, stdout, stderr, all: `${stdout}${stderr}` };
}

export interface RegistryStub {
  /** What to put in `npm_config_registry`. */
  readonly url: string;
  close(): Promise<void>;
}

/**
 * A registry that answers the one question `update` asks it.
 *
 * Addressed through `npm_config_registry`, which is npm's own configuration
 * rather than a hook added for tests — the CLI honors it because a user with a
 * private registry needs it to, and the tests get a seam for free.
 */
export async function startRegistry(latest: string | undefined): Promise<RegistryStub> {
  const server = createServer((request, response) => {
    if (latest === undefined || !request.url?.endsWith('/latest')) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":"Not found"}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ name: PACKAGE_NAME, version: latest }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Run the CLI without blocking this process.
 *
 * `run` uses `spawnSync`, which holds the event loop for the whole of the
 * child's life — so a CLI that calls back into a server running here would wait
 * for a request that can never be accepted. Any test with a registry stub has
 * to use this instead.
 */
export function runAsync(
  pkgRoot: string,
  args: string[],
  cwd?: string,
  env?: Record<string, string>,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(pkgRoot, 'lib', 'cli.js'), ...args], {
      cwd: cwd ?? pkgRoot,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.stdin.end();

    child.on('close', (status) => {
      resolve({ status: status ?? -1, stdout, stderr, all: `${stdout}${stderr}` });
    });
  });
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
