/**
 * Bringing the CLI itself up to date, before it refreshes any skill.
 *
 * A skill's version is the package's version — `buildInstallRecord` writes
 * `pkg.version` and there is no per-skill version — so refreshing skills from a
 * stale CLI copies stale skills and reports success. That is the failure this
 * module exists to remove.
 *
 * Nothing here performs I/O. Every network call, subprocess, and filesystem
 * probe goes through an injected `Runner`, which is what makes the whole thing
 * testable without reaching the registry or running `npm install -g`.
 */
import { join, normalize, sep } from 'node:path';
import { PackageInfo } from './paths';
import { compareVersions } from './version';

/**
 * The version a working tree carries. Releases are continuous and unbump after
 * publishing, so this placeholder is true of every checkout and of no published
 * tarball — which makes it the one reliable signal that self-updating would
 * pull a published package over the change being tested.
 */
export const DEVELOPMENT_VERSION = '0.0.0';

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/** Long enough for a slow registry, short enough that nobody waits on a dead one. */
export const LOOKUP_TIMEOUT_MS = 5000;

export interface CommandLine {
  readonly command: string;
  readonly args: readonly string[];
}

export interface RunOutcome {
  /** The command's exit code, or -1 when it could not be run at all. */
  readonly status: number;
  readonly stdout?: string;
  /** Set when the command could not be run or exited non-zero. */
  readonly error?: string;
}

/** Every side effect this module needs, in one injectable seam. */
export interface Runner {
  fetchJson(url: string, headers: Record<string, string>, timeoutMs: number): Promise<unknown>;
  run(line: CommandLine, capture?: boolean): RunOutcome;
  exists(path: string): boolean;
}

/** How the running copy of this CLI got onto the machine. */
export type InstallMode = 'development' | 'global' | 'npx' | 'dependency';

export type LatestVersion =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly reason: string };

export function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

export function npxCommand(): string {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

export function formatCommand(line: CommandLine): string {
  return [line.command, ...line.args].join(' ');
}

export function registryBase(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.npm_config_registry?.trim();
  return (configured || DEFAULT_REGISTRY).replace(/\/+$/, '');
}

/**
 * Ask the registry for the latest published version.
 *
 * One unauthenticated GET of the abbreviated document, which is kilobytes where
 * the full packument is megabytes. `npm view` would answer the same question
 * with a subprocess and seconds of npm startup; npm is still shelled out to for
 * the upgrade, where it does real work.
 *
 * Every failure — DNS, timeout, non-200, unparsable body, missing field — comes
 * back as a reason rather than a throw, because none of them may stop the skill
 * refresh.
 */
export async function resolveLatest(
  pkg: PackageInfo,
  runner: Runner,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LatestVersion> {
  const url = `${registryBase(env)}/${pkg.name}/latest`;

  try {
    const document = await runner.fetchJson(
      url,
      { Accept: 'application/vnd.npm.install-v1+json' },
      LOOKUP_TIMEOUT_MS,
    );
    const version = (document as { version?: unknown } | null)?.version;

    if (typeof version !== 'string' || version.length === 0) {
      return { ok: false, reason: `${url} returned no version` };
    }
    return { ok: true, version };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}

function isUnder(child: string, parent: string): boolean {
  let from = normalize(parent);
  while (from.length > 1 && from.endsWith(sep)) from = from.slice(0, -1);

  const to = normalize(child);
  return to === from || to.startsWith(from + sep);
}

/**
 * The npm global prefix, or undefined if npm cannot say.
 *
 * Deriving it from `process.execPath` is wrong under every version manager —
 * nvm, volta, and a configured `~/.npm-global` prefix all put global packages
 * somewhere unrelated to the Node binary. Asking npm is the only answer that is
 * right on all of them, and it costs one subprocess on `update` alone.
 */
export function globalPrefix(runner: Runner): string | undefined {
  try {
    const outcome = runner.run({ command: npmCommand(), args: ['prefix', '-g'] }, true);
    if (outcome.status !== 0) return undefined;
    const prefix = (outcome.stdout ?? '').split('\n')[0].trim();
    return prefix.length > 0 ? prefix : undefined;
  } catch {
    // npm missing, slow, or broken is not an error here: it means "not a global
    // install", and the run degrades to the hand-off path.
    return undefined;
  }
}

interface Classification {
  readonly mode: InstallMode;
  /** The global prefix, when one was found — reported if an upgrade there fails. */
  readonly prefix?: string;
}

function classify(pkg: PackageInfo, runner: Runner): Classification {
  if (pkg.version === DEVELOPMENT_VERSION || runner.exists(join(pkg.root, '.projenrc.ts'))) {
    return { mode: 'development' };
  }

  const prefix = globalPrefix(runner);
  if (prefix && isUnder(pkg.root, prefix)) return { mode: 'global', prefix };

  if (normalize(pkg.root).split(sep).includes('_npx')) return { mode: 'npx' };

  // The catch-all is deliberately the safest action: a hand-off writes nothing
  // outside the skills directory and edits no project, so a misdetection costs
  // a slightly wrong message rather than an unwanted change.
  return { mode: 'dependency' };
}

export function detectMode(pkg: PackageInfo, runner: Runner): InstallMode {
  return classify(pkg, runner).mode;
}

/** The arguments the newer CLI is re-executed with. */
export function refreshArgs(targetPath: string, dryRun: boolean): string[] {
  return ['update', '--dir', targetPath, '--no-self-update', ...(dryRun ? ['--dry-run'] : [])];
}

export function upgradeCommand(pkg: PackageInfo, latest: string): CommandLine {
  return { command: npmCommand(), args: ['install', '-g', `${pkg.name}@${latest}`] };
}

/** Re-run this same binary — after a global upgrade, that path holds the new code. */
export function reexecCommand(self: readonly string[], args: readonly string[]): CommandLine {
  return { command: self[0], args: [...self.slice(1), ...args] };
}

export function npxHandoffCommand(
  pkg: PackageInfo,
  latest: string,
  args: readonly string[],
): CommandLine {
  return { command: npxCommand(), args: ['-y', `${pkg.name}@${latest}`, ...args] };
}

/** What a run would do, in the order it would do it. */
export function plannedCommands(
  mode: InstallMode,
  pkg: PackageInfo,
  latest: string,
  self: readonly string[],
  args: readonly string[],
): CommandLine[] {
  if (mode === 'development') return [];
  if (mode === 'global') return [upgradeCommand(pkg, latest), reexecCommand(self, args)];
  return [npxHandoffCommand(pkg, latest, args)];
}

export interface SelfUpdateRequest {
  readonly pkg: PackageInfo;
  readonly targetPath: string;
  readonly dryRun: boolean;
  readonly runner: Runner;
  /** How to re-run this binary: `[execPath, entryPoint]`. */
  readonly self: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Called immediately before each command that takes real time, so the user
   * sees why the terminal has gone quiet. An injected sink rather than a
   * `console.log`, for the same reason the I/O is injected.
   */
  readonly announce?: (message: string) => void;
}

export type SelfUpdateOutcome =
  /** A working tree: refresh from it, and say so. */
  | { readonly kind: 'development'; readonly notes: string[] }
  /** Not older than what is published: nothing to do. */
  | { readonly kind: 'current'; readonly version: string; readonly notes: string[] }
  /** The lookup failed. Warn, and refresh from the package in hand. */
  | { readonly kind: 'unchecked'; readonly reason: string; readonly notes: string[] }
  /** A dry run: what would have happened. */
  | {
    readonly kind: 'planned';
    readonly mode: InstallMode;
    readonly latest: string;
    readonly commands: CommandLine[];
    readonly notes: string[];
  }
  /** The newer version ran the refresh; its exit code is the run's. */
  | { readonly kind: 'handed-off'; readonly latest: string; readonly status: number; readonly notes: string[] }
  /** The hand-off itself could not run. Warn, and refresh from the package in hand. */
  | { readonly kind: 'failed'; readonly reason: string; readonly notes: string[] };

/**
 * Upgrade this CLI, then let the newer version do the work.
 *
 * The hand-off is not an implementation convenience. This process has already
 * loaded the old `lib/`, and `pkg.root` points at the old package — which is
 * where the skills, templates, and schemas are read from. Continuing in-process
 * after a successful upgrade would copy the old payload while reporting the new
 * version, which is the exact lie this command exists to stop telling.
 *
 * Nothing here is fatal. Every failure downgrades to "refresh from the package
 * in hand", because the person running `update` most often has a broken or
 * stale skill, and refusing to fix it because npm was unreachable turns a
 * degraded outcome into no outcome.
 */
export async function selfUpdate(request: SelfUpdateRequest): Promise<SelfUpdateOutcome> {
  const { pkg, runner, self } = request;
  const notes: string[] = [];

  const { mode, prefix } = classify(pkg, runner);
  if (mode === 'development') return { kind: 'development', notes };

  const latest = await resolveLatest(pkg, runner, request.env);
  if (!latest.ok) return { kind: 'unchecked', reason: latest.reason, notes };

  if (compareVersions(pkg.version, latest.version) >= 0) {
    return { kind: 'current', version: latest.version, notes };
  }

  const args = refreshArgs(request.targetPath, request.dryRun);

  if (request.dryRun) {
    return {
      kind: 'planned',
      mode,
      latest: latest.version,
      commands: plannedCommands(mode, pkg, latest.version, self, args),
      notes,
    };
  }

  const announce = request.announce ?? (() => {});
  let handoff = mode === 'global' ? reexecCommand(self, args) : npxHandoffCommand(pkg, latest.version, args);

  if (mode === 'global') {
    announce(`Upgrading the globally installed ${pkg.name} from ${pkg.version} to ${latest.version}...`);
    const upgrade = runner.run(upgradeCommand(pkg, latest.version));
    if (upgrade.status !== 0) {
      // Most often a root-owned global prefix. Falling back to the one-off run
      // needs no elevated permission and still refreshes from the latest
      // package — but the CLI on the PATH is still the old one, and saying so
      // is the difference between a warning and a lie.
      notes.push(
        `could not upgrade the global install${prefix ? ` under ${prefix}` : ''}: ${upgrade.error ?? `npm exited ${upgrade.status}`}`,
      );
      notes.push(
        `the installed \`${pkg.name}\` is still ${pkg.version}; falling back to a one-off run of ${latest.version}`,
      );
      handoff = npxHandoffCommand(pkg, latest.version, args);
    }
  }

  announce(`Updating with ${pkg.name} ${latest.version}...\n`);
  const result = runner.run(handoff);
  if (result.status < 0) {
    return {
      kind: 'failed',
      reason: result.error ?? `could not run ${formatCommand(handoff)}`,
      notes,
    };
  }

  return { kind: 'handed-off', latest: latest.version, status: result.status, notes };
}
