## Context

Phase 3 emits one shape of CDK app. `templates/cdk/` holds the sources; `bin/app.ts` instantiates two stacks from `lib/`, and `package.json`, `tsconfig.json` and `cdk.json` are copied as ordinary files the user then owns. Everything downstream assumes that layout: the manifest's `generated` list hashes files under `infra/`, the pipeline path filter names `infra/lib/service-stack.ts`, and the completion instructions tell the user to run `npm ci && npx cdk deploy <app>-platform`.

Projen inverts who owns the scaffolding. `.projenrc.ts` declares an `awscdk.AwsCdkTypeScriptApp` and `npx projen` derives `package.json`, `tsconfig.json`, `cdk.json`, `.gitignore`, `.projen/` and the lockfile from it. Sources live under `src/`. For a team already on projen, a hand-maintained CDK app dropped into their repository is the odd one out, and the hand conversion that follows is exactly the edit that makes the next skill run stop on a divergent file.

Two constraints shape the design. First, the manifest is the single source of truth and generation is a pure function of it (design decision 1 of the original change) — so the style has to be a recorded field, not an ambient property of the working tree. Second, the skill is resumable, and every manifest already in the wild describes a plain app without saying so.

A working reference implementation of this feature exists outside the repository, in the installed copy at `~/.claude/skills/ecs-truly-auto-mode/` (published `0.0.2` plus local edits: `references/generation/iac-style.md`, `assets/templates/cdk-projen/`, and edits to `SKILL.md` and four references). It is prior art to port rather than re-derive — with one caveat: it addresses templates as `./assets/templates/...`, the layout the CLI packaging on the `cli-to-install` branch produces, while `main` addresses them as `templates/`. Paths must be rewritten to whichever branch this lands on.

## Goals / Non-Goals

**Goals:**

- Let the user choose the generated project's shape, and record the choice where every later phase and every resume can read it.
- Keep the two styles behaviorally identical: same stacks, same SSM contract, same synthesized CloudFormation, same deployment contract.
- Change nothing for anyone who does not choose projen, including every manifest that predates this change.
- Keep the skill out of projen's way — never write, and never hash, a file projen derives.

**Non-Goals:**

- Converting an already-generated `plain` app to `projen` in place. Re-running with a changed style is a new-project operation; the overwrite check governs it like any other divergence.
- Inferring the style from the repository.
- Any third style (CDK Pipelines-managed, Python, monorepo-nested).
- The skill repository's own build tooling. That is the `cli-to-install` branch's business and is unrelated to what the skill generates.

## Decisions

### 1. The style is asked, never inferred

A `.projenrc.ts` elsewhere in the repository is evidence that the user *knows* projen, not that they want the infrastructure app managed by it. Plenty of repositories use projen for a library and would rather not learn what `npx projen` does to a CDK app they are about to hand to an SRE.

The question is batched with the pipeline-target question in Phase 2: both are generation-shape questions, neither depends on the analysis, and asking them in separate rounds spends two interactions on one decision point — against the skill's own rule about batching questions per phase.

*Alternative considered:* default to projen when the repository already uses it. Rejected — it makes a structural choice on ambiguous evidence, which is the failure mode the whole skill is built to avoid.

### 2. `plain` is the default, and an absent `infra` means `plain`

`infra` is an optional manifest object rather than a required one. Every manifest written before this change describes a plain app, and reading one must not convert a repository to projen or stall a resume on a missing field.

```yaml
infra:
  style: projen
  cdkVersion: 2.263.0
```

*Why optional over required with a bump to `schemaVersion`:* the manifest's meaning does not change — a v1 manifest describes exactly what it described before. `schemaVersion` exists so an unrecognized manifest stops the skill; spending it on a field with a well-defined absent-value would strand every existing repository for no gained clarity.

### 3. The stacks are byte-identical across styles, and that equivalence is the invariant

`platform-stack.ts`, `service-stack.ts`, `config.ts`, `app-config.ts` and `deploy-permissions.ts` are copied unchanged under both styles. The only source that differs is the entry point, and only in its import paths — `../lib/x` under plain, `./x` under projen, because projen keeps sources under one directory. So `templates/cdk-projen/src/main.ts` is a twin of `templates/cdk/bin/app.ts`, and a change to either belongs in both.

Twins drift. The repository already guards a comparable invariant with `verify:pipeline-equivalence`, and this change adds the same kind of check: the two entry points must match modulo their import paths, and the projen template's `cdkVersion` must equal the `aws-cdk-lib` floor in `templates/cdk/package.json` with the caret stripped (`^2.263.0` → `2.263.0`; `AwsCdkTypeScriptApp` takes a version, not a range). A check that runs in `npm test` is worth more here than a comment asking people to remember.

*Alternative considered:* generate `src/main.ts` from `bin/app.ts` by rewriting imports at generation time, keeping one template. Rejected — it makes a generated file that no one can read in the repository, for a saving of thirty lines, and the skill's own rule is that generated code should be readable by the person who inherits it. The equivalence check buys the same protection without hiding the artifact.

### 4. Projen's outputs are neither written nor hash-tracked

Under `projen` the skill owns `.projenrc.ts`, everything in `src/`, and `scripts/ssm-preflight.sh`. It never writes `package.json`, `tsconfig.json`, `cdk.json`, `.gitignore`, `.projen/` or `package-lock.json`, and never records a hash for them in `generated`.

*Why:* the overwrite check exists to catch *user* edits. Projen rewrites its outputs on a cadence the skill does not control — any `npx projen` the user runs, and every projen upgrade. A recorded hash would go stale on a run nobody thought of as an edit, and the next generation would stop to show a diff no human made. Worse, it would teach the user to click past the one prompt that exists to protect their work.

`scripts/ssm-preflight.sh` sits outside projen's world in both styles, so the pipeline's path to it does not change.

### 5. Bootstrap with `projen new`, then overwrite `.projenrc.ts`

Order matters, because `projen new` writes its own `.projenrc.ts`:

1. `npx projen@latest new awscdk-app-ts --name=<app>-infra --cdk-version=<cdkVersion> --package-manager=npm --projenrc-ts --no-sample-code --no-git` in `infra/`. **This exits non-zero and that is expected** — it runs eslint over an empty `src/` and TypeScript reports `TS18003: No inputs were found`. The project files are written regardless. Documenting this is the point: an undocumented expected failure is one an agent will "fix" by adding sample code or retrying with different flags.
2. Overwrite `.projenrc.ts` from the template, substituting `APP_NAME`, `CDK_VERSION`, `DEFAULT_BRANCH`.
3. Write the stack sources into `src/` and `scripts/ssm-preflight.sh`.
4. `npx projen` — installs, writes the derived files, produces `package-lock.json`.
5. Remove the bootstrap leftovers projen does not clean up itself. It removes `LICENSE`, `.mergify.yml` and `.eslintrc.json` on first synth but leaves an empty `infra/.github/workflows`, which reads like a workflow directory someone emptied.

*Alternative considered:* skip `projen new` and write `.projenrc.ts` plus a minimal `package.json` directly, then run `npx projen`. Rejected — it means hand-maintaining the bootstrap projen already knows how to do, and it puts the skill back in the business of writing a `package.json` that projen then owns.

The template sets `github: false` (projen would write workflows under `infra/.github`, which GitHub never reads — dead workflows that look live), `jest: false` and `eslint: false` (no tests are generated, and lint findings on generated sources are noise nobody can act on), `packageManager: NPM` (the pipeline runs `npm ci` against a committed lockfile; projen's yarn default would leave nothing to install from), `appEntrypoint: 'main.ts'`, and the same context flags `templates/cdk/cdk.json` sets.

### 6. Verification is per style, and still credential-free

| Style | Command |
| --- | --- |
| `plain` | `npm ci && npx tsc --noEmit && npx cdk synth '**'` |
| `projen` | `npx projen && npx projen build` |

`npx projen build` compiles and synthesizes both stacks, covering what the two plain commands cover. The no-credentials rule is unchanged and is the reason `fromLookup` stays banned in both.

### 7. The pipeline contract does not change; two derived values do

The pipeline still runs `npm ci` and `npx cdk deploy <app>-service --parameters ImageTag=<sha>`. Projen commits `package-lock.json` and puts `aws-cdk` in `devDependencies`, so both steps work identically. **The pipeline never runs projen** — a deploy that regenerated its own project files could change what it deploys, which is the opposite of what a lockfile is for.

What changes:

- the service-stack entry in the path filter is `infra/src/service-stack.ts` under projen, so `derive-path-filter.mjs` takes the path from the style instead of hardcoding `infra/lib/service-stack.ts`;
- `infra/.projenrc.ts` joins the filter under projen, because it pins the CDK version the service stack is synthesized with;
- the platform stack stays excluded, at whichever path it lives.

### 8. A re-run rarely needs projen

`app-config.ts` is a plain source file under both styles, so the common re-run — a finding changed, so the config changed — touches only `src/app-config.ts` and needs no projen invocation. `npx projen` re-runs only when `.projenrc.ts` itself is regenerated, which happens when `app.name`, `pipeline.branch`, or the pinned CDK version changes.

## Risks / Trade-offs

- **The two entry points drift, and the styles stop being equivalent** → the equivalence check in `npm test` compares them modulo import paths and fails the build; the reference document states the rule at the point where someone would edit one.
- **`projen new` requires network access at generation time**, so a run in an offline environment fails at a step the plain style does not have → state the prerequisite when the style is chosen, and let the failure be loud. Falling back to plain silently would generate a project the user did not pick.
- **`projen new`'s expected non-zero exit gets treated as a real failure**, and an agent "fixes" it by adding sample code or changing flags → documented as expected, with the reason, in the generation steps.
- **Projen's own generated output changes between versions** (new files, renamed tasks), which the skill neither pins nor controls → the skill owns nothing projen writes, so a projen upgrade cannot conflict with the overwrite check. The blast radius is the user's `infra/` project, which is theirs, and is the trade-off they accepted by choosing projen.
- **The `cdkVersion` pin and the plain template's `aws-cdk-lib` floor diverge**, so the two styles synthesize against different CDK versions → covered by the same equivalence check.
- **A user re-runs with a different style than the manifest records**, expecting an in-place conversion → out of scope by decision; the run writes the new layout and the overwrite check protects everything already on disk. Say so plainly rather than half-converting.
- **Testing the projen path in CI is expensive** — it means a real `projen new`, a real install, and a real synth → the cheap checks (template equivalence, version parity, schema, an example manifest) run in `npm test`; the full end-to-end generation stays a manual verification, as it already is for the plain style.
