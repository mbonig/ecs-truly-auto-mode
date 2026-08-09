import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';

/** Identity of the package this CLI was run from. */
export interface PackageInfo {
  /** Absolute path to the package root — the directory holding package.json and skills/. */
  readonly root: string;
  readonly name: string;
  /**
   * The version recorded in package.json. In a working tree this is the `0.0.0`
   * placeholder; the real version is written in only at release time.
   */
  readonly version: string;
}

/**
 * Locate the package root by walking up from the compiled file's directory.
 *
 * The compiled entry point lives at `<root>/lib/cli.js`, so the root is normally
 * one level up — but walking and checking for the two things that actually
 * matter (a package.json and a skills directory) means this works identically
 * from a repository checkout and from an extracted tarball, without either
 * layout being hardcoded.
 */
export function findPackageRoot(start: string = __dirname): string {
  let dir = start;
  for (let depth = 0; depth < 6; depth++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'skills'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate the package root above ${start}`);
}

export function readPackageInfo(root: string = findPackageRoot()): PackageInfo {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return { root, name: pkg.name, version: pkg.version };
}

/** Where an install can be sent. */
export type TargetKind = 'user' | 'project' | 'dir';

export interface Target {
  readonly kind: TargetKind;
  readonly path: string;
}

export function userTarget(): Target {
  return { kind: 'user', path: join(homedir(), '.claude', 'skills') };
}

export function projectTarget(cwd: string = process.cwd()): Target {
  return { kind: 'project', path: join(cwd, '.claude', 'skills') };
}

export function explicitTarget(dir: string, cwd: string = process.cwd()): Target {
  return { kind: 'dir', path: isAbsolute(dir) ? normalize(dir) : resolve(cwd, dir) };
}
