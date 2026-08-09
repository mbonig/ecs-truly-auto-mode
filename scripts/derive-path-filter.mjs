#!/usr/bin/env node
/**
 * Derive a pipeline path filter from what the image build actually reads.
 *
 * A filter that is too narrow is the nasty failure here: a code change doesn't
 * trigger a deploy, and the pipeline reports success by staying silent. So this
 * biases toward *wider* — an unnecessary run costs a few minutes of compute, a
 * missed run costs an incident.
 *
 * Usage:
 *   node scripts/derive-path-filter.mjs <dockerfile> <build-context> [--style=plain|projen] [--json]
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, posix } from 'node:path';

/** Dependency manifests and lockfiles worth watching when present in the context. */
const DEPENDENCY_FILES = [
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
  'requirements.txt', 'pyproject.toml', 'poetry.lock', 'Pipfile', 'Pipfile.lock',
  'go.mod', 'go.sum',
  'Gemfile', 'Gemfile.lock',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'gradle.lockfile',
  'Cargo.toml', 'Cargo.lock',
];

/**
 * Parse COPY/ADD source paths out of a Dockerfile.
 *
 * Every stage is scanned, not just the final one: a builder stage that does
 * `COPY package.json .` still means a package.json change must rebuild the image.
 */
export function parseCopySources(dockerfile) {
  const sources = [];
  const lines = dockerfile.split('\n');

  for (let i = 0; i < lines.length; i++) {
    // Join continuations so a multi-line COPY is seen whole.
    let line = lines[i].trim();
    while (line.endsWith('\\') && i + 1 < lines.length) {
      line = line.slice(0, -1).trim() + ' ' + lines[++i].trim();
    }

    if (!/^(COPY|ADD)\s/i.test(line)) continue;

    // `COPY --from=builder /app /app` reads from an earlier stage, not the context.
    if (/--from=/i.test(line)) continue;

    const withoutVerb = line.replace(/^(COPY|ADD)\s+/i, '');
    const tokens = withoutVerb
      .split(/\s+/)
      .filter((t) => !t.startsWith('--'));

    // The last token is the destination; everything before it is a source.
    if (tokens.length < 2) continue;
    for (const token of tokens.slice(0, -1)) {
      sources.push(token.replace(/^["']|["']$/g, ''));
    }
  }

  return sources;
}

/** Entries from .dockerignore, used to avoid a filter that fires on doc edits. */
function readDockerignore(context) {
  const path = join(context, '.dockerignore');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'));
}

/** A directory source becomes a glob; a file source stays as-is. */
function toGlob(source, context) {
  let path = source.replace(/^\.\//, '');
  if (path === '.' || path === './' || path === '*') return null; // handled by caller
  const full = join(context, path);
  if (existsSync(full) && statSync(full).isDirectory()) {
    return posix.join(path, '**');
  }
  // A path that doesn't resolve at derivation time (a build arg inside it, say) is
  // kept verbatim rather than dropped — a filter entry that never matches is
  // harmless, a missing one is not.
  return path;
}

/**
 * Where the generated infra project keeps the files the filter cares about, per
 * `infra.style`. Projen keeps its sources under src/ and derives the project files
 * from .projenrc.ts, which pins the CDK version the service stack is synthesized
 * with — so a change to it changes what gets deployed, and it belongs in the filter.
 */
const STYLE_PATHS = {
  plain: { serviceStack: 'infra/lib/service-stack.ts', extra: [] },
  projen: { serviceStack: 'infra/src/service-stack.ts', extra: ['infra/.projenrc.ts'] },
};

export function derivePathFilter({
  dockerfilePath,
  buildContext,
  style = 'plain',
  serviceStackPath,
  repoRoot = process.cwd(),
}) {
  const stylePaths = STYLE_PATHS[style];
  if (!stylePaths) {
    throw new Error(`unknown infra style "${style}" — expected one of ${Object.keys(STYLE_PATHS).join(', ')}`);
  }
  // An explicit path wins, for a project that doesn't live at infra/.
  const serviceStack = serviceStackPath ?? stylePaths.serviceStack;

  const dockerfile = readFileSync(dockerfilePath, 'utf8');
  const sources = parseCopySources(dockerfile);
  const filter = new Set();

  // Everything is emitted relative to the repository root, because that is what a
  // pipeline path filter is matched against. COPY sources are relative to the build
  // context, so they need the context prefix; the Dockerfile path may be given as
  // absolute or relative and is normalized the same way.
  const rel = (p) => relative(repoRoot, p).split('\\').join('/');
  const inContext = (p) => {
    const joined = buildContext === '.' ? p : posix.join(rel(buildContext), p);
    return joined.replace(/^\.\//, '');
  };

  const wholeContext = sources.some((s) => s === '.' || s === './' || s === '*');

  if (wholeContext) {
    // `COPY . .` means everything. Subtract .dockerignore rather than emitting a
    // bare `**`, which would fire on every documentation edit and train people to
    // ignore the pipeline.
    const ignored = readDockerignore(buildContext);
    filter.add(inContext('**'));
    for (const entry of ignored) {
      filter.add(`!${inContext(entry.replace(/\/$/, '/**'))}`);
    }
  } else {
    for (const source of sources) {
      const glob = toGlob(source, buildContext);
      if (glob) filter.add(inContext(glob));
    }
  }

  // The Dockerfile itself.
  filter.add(rel(dockerfilePath));

  // Dependency manifests present in the context.
  for (const file of DEPENDENCY_FILES) {
    if (existsSync(join(buildContext, file))) filter.add(inContext(file));
  }

  // Changing what gets deployed must trigger a deploy.
  if (serviceStack) filter.add(serviceStack);
  for (const path of stylePaths.extra) filter.add(path);

  // NOTE: the platform stack is deliberately absent. This pipeline does not deploy
  // it, and a trigger that runs a pipeline which ignores the change is worse than
  // no trigger at all.

  return dedupe([...filter]);
}

/** Drop paths already covered by a broader glob in the set. */
function dedupe(paths) {
  const negations = paths.filter((p) => p.startsWith('!'));
  const positives = paths.filter((p) => !p.startsWith('!'));

  const kept = positives.filter((path) => {
    return !positives.some((other) => {
      if (other === path || !other.endsWith('/**')) return false;
      const prefix = other.slice(0, -3);
      return path.startsWith(prefix + '/') || path === prefix;
    });
  });

  return [...new Set([...kept, ...negations])].sort();
}

function main() {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith('--'));
  const [dockerfilePath, buildContext = '.'] = args.filter((a) => !a.startsWith('--'));
  if (!dockerfilePath) {
    console.error('usage: derive-path-filter.mjs <dockerfile> [build-context] [--style=plain|projen] [--json]');
    process.exit(2);
  }

  const style = flags.find((f) => f.startsWith('--style='))?.split('=')[1] ?? 'plain';

  const filter = derivePathFilter({
    dockerfilePath,
    buildContext,
    style,
    repoRoot: buildContext,
  });

  if (flags.includes('--json')) {
    console.log(JSON.stringify(filter, null, 2));
  } else {
    for (const path of filter) console.log(path);
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main();
}
