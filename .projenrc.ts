import { typescript } from 'projen';
import { NodePackageManager, NpmAccess } from 'projen/lib/javascript';
import { ReleaseTrigger } from 'projen/lib/release';

const project = new typescript.TypeScriptProject({
  name: '@matthewbonig/ecs-truly-auto-mode-skill',
  description:
    'A Claude Code skill that analyzes a containerized repository and generates the ECS infrastructure and pipeline it needs, plus the CLI that installs it',
  repository: 'https://github.com/mbonig/ecs-truly-auto-mode.git',
  homepage: 'https://github.com/mbonig/ecs-truly-auto-mode',
  keywords: ['claude-code', 'skill', 'ecs', 'fargate', 'aws', 'cdk', 'installer'],

  authorName: 'Matthew Bonig',
  license: 'MIT',
  copyrightOwner: 'Matthew Bonig',

  defaultReleaseBranch: 'main',
  projenrcTs: true,
  packageManager: NodePackageManager.NPM,
  // 20.9.0 is the first Node 20 *LTS*; 20.0.0 was never one, and claiming support
  // for it is not something anyone verifies.
  minNodeVersion: '20.9.0',

  // Must be set explicitly: workflowNodeVersion defaults to minNodeVersion, which
  // pinned CI to the oldest Node the package supports. projen's own task runner
  // uses `Symbol.dispose` (Node >= 20.4), so on 20.0.0 it died evaluating a task
  // condition — the release silently skipped its version bump and then failed on
  // the missing dist/releasetag.txt. The floor a package supports and the Node its
  // tooling runs on are different questions; `lts/*` can never be too old.
  workflowNodeVersion: 'lts/*',

  // Pinned to 5.x deliberately. TypeScript 7 is the native rewrite and drops the
  // `ts.sys` API that ts-node 10 — which is what executes this file — depends on;
  // installing it unpinned breaks `npx projen` itself.
  typescriptVersion: '~5.9.0',

  // Not optional for a scoped package: npm defaults `@scope/*` to restricted, so
  // without this the publish fails outright (or, worse, succeeds privately).
  //
  // It is also what makes provenance available — projen defaults npmProvenance to
  // true for public packages, so the published tarball carries an attestation
  // tying it to the commit and workflow run that built it. That matters more than
  // usual for a package whose whole job is to write files into someone's home
  // directory.
  npmAccess: NpmAccess.PUBLIC,

  // Every push to main releases. The version is computed from git history,
  // written into the artifact, published, and tagged — and then unbumped, so no
  // commit lands on main and a release can never trigger another release.
  //
  // Authentication is OIDC trusted publishing, not a token. The first attempt used
  // an NPM_TOKEN and failed with `EOTP: This operation requires a one-time
  // password` — and npm's own output in that same run warned that "npm tokens that
  // bypass 2FA are being restricted for direct publishing". Trusted publishing
  // removes the long-lived credential entirely: npm verifies the workflow's OIDC
  // identity instead, so there is no secret to leak, rotate, or have expire.
  //
  // This requires a matching trusted publisher configured on npmjs.com for this
  // repository and workflow file. Without it the publish is rejected.
  release: true,
  releaseToNpm: true,
  npmTrustedPublishing: true,
  releaseTrigger: ReleaseTrigger.continuous(),

  // Deliberately unscoped and short: this is what someone types. `npx
  // @matthewbonig/ecs-truly-auto-mode-skill` resolves to it regardless of the
  // name, and a global install puts `ecs-truly-auto-mode` on the PATH.
  bin: { 'ecs-truly-auto-mode': 'lib/cli.js' },

  // No sample code, and no generated README — this repository already has both.
  sampleCode: false,
  readme: undefined,

  // Both of projen's optional workflows stay on.
  //
  // pull-request-lint is not merely a default here: once release is enabled, the
  // size of each version bump is derived from commit messages, and with squash
  // merges the PR title *is* that message. Enforcing a conventional title is what
  // makes the release increment mean anything.
  //
  // upgrade keeps dependencies current, and the build workflow's drift check is
  // the safety net that stops an upgrade PR from landing stale generated files.

  // Used by the validation scripts under scripts/, not by the CLI. The CLI itself
  // has zero runtime dependencies: it is run via npx into someone's home
  // directory, so every transitive dependency would be one more thing to audit.
  devDeps: ['ajv', 'ajv-formats', 'yaml'],
});

//
// Ignore rules
//
// The CDK build-output rules below are scoped to the CDK directories on purpose —
// a blanket `*.js` rule also swallows fixture application source, which is
// JavaScript by design, and those fixtures are what validate:examples runs
// against. Do not "simplify" these into a top-level `*.js`.
//
project.gitignore.exclude(
  'cdk.out/',
  'cdk.context.json',
  'templates/cdk/**/*.js',
  'templates/cdk/**/*.d.ts',
  'infra/**/*.js',
  'infra/**/*.d.ts',
  'templates/cdk/lib/app-config.ts',
);

// Never commit real environment files; the checked-in examples are the exception.
project.gitignore.exclude('.env', '.env.*', '!.env.example');

project.gitignore.exclude('worktrees/', '.idea/', '.vscode/', '.DS_Store', '*.log', 'npm-debug.log*');

// Assets are copied into a skill at install time (and by the skills:materialize
// task for local development). Committing them would create a second source of
// truth for templates/ and schemas/ that would drift.
project.gitignore.exclude('skills/*/assets/', 'skills/*/.installed.json');

//
// Packaging
//
// The skills and the sources they carry must ship; everything that only matters
// to developing this repository must not.
//
// templates/cdk is a real npm project with its own package.json, and the fixture
// suite installs its dependencies to synthesize CloudFormation. npm's built-in
// node_modules exclusion does not reach a nested project once an .npmignore is in
// play, so without these the published tarball carries the entire CDK dependency
// tree — build output nobody installing a skill has any use for.
project.addPackageIgnore('**/node_modules/');
project.addPackageIgnore('**/cdk.out/');
project.addPackageIgnore('**/*.tsbuildinfo');

project.addPackageIgnore('/examples/');
project.addPackageIgnore('/openspec/');
project.addPackageIgnore('/docs/');
project.addPackageIgnore('/scripts/');
project.addPackageIgnore('/.projenrc.ts');
// This repository's own Claude Code configuration, not the skills it distributes.
project.addPackageIgnore('/.claude/');

//
// Validation tasks
//
// These keep their existing scripts/*.mjs implementations — they have nothing to
// do with the CLI and no reason to be rewritten. Declaring them here rather than
// in package.json is required now that package.json is generated.
//

// A tool rather than a check: it takes manifest paths as arguments. The test task
// exercises it through validate:examples, which drives it over every example
// manifest plus a set of deliberate corruptions.
project.addTask('validate:manifest', {
  description: 'Validate one or more manifest files against the schema and consistency checks',
  exec: 'node scripts/validate-manifest.mjs',
  receiveArgs: true,
});

const validateExamples = project.addTask('validate:examples', {
  description: 'Validate every example manifest, and assert each deliberate corruption is caught',
  exec: 'node scripts/validate-examples.mjs',
});

const verifyPipelines = project.addTask('verify:pipelines', {
  description: 'Assert both pipeline targets implement the same deployment contract',
  exec: 'node scripts/verify-pipeline-equivalence.mjs',
});

const verifyResume = project.addTask('verify:resume', {
  description: 'Assert resume and incremental re-run behavior against the manifest',
  exec: 'node scripts/verify-resume.mjs',
});

const verifyFixtures = project.addTask('verify:fixtures', {
  description: 'Synthesize real CloudFormation from the fixtures and assert on what came out',
  exec: 'node scripts/verify-fixtures.mjs',
});

// Packs the real tarball and installs from it. Depends on compiled output, so it
// runs after compile — which the test task, spawned from build, already is.
const verifyPackaging = project.addTask('verify:packaging', {
  description: 'Pack the tarball, install from it, and resolve every path the installed skills reference',
  exec: 'node scripts/verify-packaging.mjs',
});

project.addTask('skills:materialize', {
  description: "Copy each skill's declared assets into skills/<name>/assets/ for local development",
  exec: 'node scripts/materialize-skills.mjs',
});

project.addTask('lint:cfn', {
  description: 'Lint synthesized CloudFormation templates',
  exec: "cfn-lint --ignore-checks W2001 'templates/cdk/cdk.out/*.template.json'",
});

project.addTask('derive:filter', {
  description: 'Derive a pipeline path filter from a build context',
  exec: 'node scripts/derive-path-filter.mjs',
  receiveArgs: true,
});

project.addTask('generate:config', {
  description: 'Generate app-config.ts from a manifest',
  exec: 'node scripts/generate-config.mjs',
  receiveArgs: true,
});

for (const task of [validateExamples, verifyPipelines, verifyResume, verifyFixtures, verifyPackaging]) {
  project.testTask.spawn(task);
}

// The CLI tests and the packaging check both exercise compiled output, so the
// test task has to compile first to be runnable on its own. Under `projen build`
// this is a no-op second call to an incremental tsc.
project.testTask.prependSpawn(project.tasks.tryFind('compile')!);

project.synth();
