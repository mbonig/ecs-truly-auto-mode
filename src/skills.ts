import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { PackageInfo } from './paths';

/** The file that makes a directory under skills/ an installable skill. */
export const SKILL_FILE = 'SKILL.md';

/** The per-skill declaration of what else has to travel with it. */
export const SKILL_DECLARATION = 'skill.json';

/** The record this CLI writes into every skill directory it installs. */
export const INSTALL_RECORD = '.installed.json';

/** One directory to copy from the package root into the installed skill. */
export interface AssetCopy {
  /** Path relative to the package root. */
  readonly from: string;
  /** Path relative to the installed skill directory. */
  readonly to: string;
}

export interface Skill {
  readonly name: string;
  /** Absolute path to the skill's source directory inside the package. */
  readonly dir: string;
  readonly assets: readonly AssetCopy[];
}

export interface InstallRecord {
  readonly skill: string;
  readonly package: string;
  readonly version: string;
  readonly installedAt: string;
}

/**
 * Enumerate the skills this package ships.
 *
 * A directory is a skill if it contains a SKILL.md. Anything else under skills/
 * is ignored rather than reported, so the installer needs no change when a
 * second skill is added — or when a stray directory appears.
 */
export function discoverSkills(pkg: PackageInfo): Skill[] {
  const skillsDir = join(pkg.root, 'skills');
  if (!existsSync(skillsDir)) return [];

  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(skillsDir, entry.name))
    .filter((dir) => existsSync(join(dir, SKILL_FILE)))
    .map((dir) => readSkill(pkg, dir))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function readSkill(pkg: PackageInfo, dir: string): Skill {
  const name = dir.split(/[\\/]/).pop()!;
  const declarationPath = join(dir, SKILL_DECLARATION);

  // A skill with no declaration is valid and simply carries no assets.
  if (!existsSync(declarationPath)) {
    return { name, dir, assets: [] };
  }

  const declaration = JSON.parse(readFileSync(declarationPath, 'utf8'));
  const assets: AssetCopy[] = (declaration.assets ?? []).map((asset: AssetCopy) => {
    if (!asset?.from || !asset?.to) {
      throw new Error(`${name}: every entry in ${SKILL_DECLARATION} needs both "from" and "to"`);
    }
    if (isAbsolute(asset.to) || normalize(asset.to).startsWith('..')) {
      // This CLI writes into someone's home directory. An asset target that
      // escapes the skill directory is the one way that becomes dangerous.
      throw new Error(`${name}: asset target "${asset.to}" escapes the skill directory`);
    }
    if (!existsSync(join(pkg.root, asset.from))) {
      throw new Error(
        `${name}: ${SKILL_DECLARATION} declares asset "${asset.from}", which does not exist in the package`,
      );
    }
    return { from: asset.from, to: asset.to };
  });

  return { name, dir, assets };
}

export function findSkill(skills: readonly Skill[], name: string): Skill | undefined {
  return skills.find((skill) => skill.name === name);
}

/** Read the record this CLI wrote when it installed a skill, if there is one. */
export function readInstallRecord(skillDir: string): InstallRecord | undefined {
  const recordPath = join(skillDir, INSTALL_RECORD);
  if (!existsSync(recordPath)) return undefined;
  try {
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    if (typeof record?.version !== 'string' || typeof record?.package !== 'string') {
      return undefined;
    }
    return record as InstallRecord;
  } catch {
    // A corrupt record is treated as no record: the directory is then something
    // this CLI will refuse to remove, which is the safe direction.
    return undefined;
  }
}

export function buildInstallRecord(skill: Skill, pkg: PackageInfo, now: Date): InstallRecord {
  return {
    skill: skill.name,
    package: pkg.name,
    version: pkg.version,
    installedAt: now.toISOString(),
  };
}
