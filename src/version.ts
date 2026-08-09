/**
 * Version comparison, deliberately shallow.
 *
 * Only the leading numeric dot-separated fields are compared; anything after a
 * `-` or `+` is ignored. This never gates an install — an existing install is
 * refused regardless of version unless --force is passed — so the worst a
 * mis-ranked prerelease can cost is one wrong word in a `list` row. A semver
 * dependency would buy nothing else, and this CLI ships with none.
 */

export type VersionStatus = 'same' | 'outdated' | 'differs';

function numericFields(version: string): number[] {
  return version
    .split(/[-+]/)[0]
    .split('.')
    .map((field) => Number.parseInt(field, 10))
    .map((value) => (Number.isNaN(value) ? 0 : value));
}

/** Compare the numeric prefixes of two versions: -1, 0, or 1. */
export function compareVersions(a: string, b: string): number {
  const left = numericFields(a);
  const right = numericFields(b);
  const width = Math.max(left.length, right.length);

  for (let i = 0; i < width; i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

/** How an installed version relates to the one this package ships. */
export function versionStatus(installed: string, packaged: string): VersionStatus {
  if (installed === packaged) return 'same';
  return compareVersions(installed, packaged) < 0 ? 'outdated' : 'differs';
}
