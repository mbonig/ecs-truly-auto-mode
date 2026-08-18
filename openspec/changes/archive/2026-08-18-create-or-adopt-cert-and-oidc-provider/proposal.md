## Why

Two resources in the plan carry a create-or-adopt decision that never reaches the generated code, and both fail in a way the user cannot see coming.

**The certificate can only be adopted.** The resource catalog promises that `certificate` is "created DNS-validated, requiring a hosted zone in the same account." Nothing shipped can do that: `PublicHostname.certificateArn` in `templates/cdk/lib/config.ts` is a required string, `platform-stack.ts:396` only ever calls `acm.Certificate.fromCertificateArn`, and `buildPublicHostname` in `scripts/generate-config.mjs` returns `undefined` unless the `certificate` plan entry is `adopt`. Marking it `create` — the action the catalog says is available — silently drops the whole public hostname: an *internal* HTTP-only ALB, no HTTPS listener, no DNS record, no error. The only working path is to obtain and validate a certificate by hand before the platform stack is ever deployed.

**The GitHub OIDC provider can only be created.** `GitHubOidcRole` builds a new `iam.OpenIdConnectProvider` unless handed `existingProviderArn` (`deploy-permissions.ts:160-165`). That prop exists, and `PlatformStackGitHubActions` forwards it, but nothing populates it: `PipelineConfig` has no field for it, `buildPipeline` in `generate-config.mjs` never emits one, and neither entry point passes it. So an account that already has a GitHub OIDC provider — which `adopt-validation.md` itself calls "most accounts" — fails the first platform deploy with `EntityAlreadyExists`. Yet an account that genuinely has no provider does need one created, so the answer is not to always import: it is to make the decision real in both directions.

The two are one defect: a `create`-or-`adopt` decision the plan records, the projection drops, and the generated stack therefore gets wrong. Fixing them together keeps one set of edits across `config.ts`, `platform-stack.ts`, `generate-config.mjs`, and the fixture suite.

## What Changes

### Certificate

- `PublicHostname` gains `certificate: Adoptable<{ certificateArn: string }>`. The platform stack creates a DNS-validated `acm.Certificate` against the adopted hosted zone when the plan says `create`, and imports by ARN when it says `adopt`. **BREAKING** for the generated `config.ts` / `app-config.ts` contract: the required `certificateArn` string is replaced by the union. Both files are skill-generated and rewritten together, so the break is contained to a re-run.
- Hoist the `route53.IHostedZone` import in `platform-stack.ts` so the created certificate and the alias record share one imported zone rather than importing it twice.
- Fix `buildPublicHostname` so a `certificate: create` entry projects a public hostname instead of discarding it. The hosted zone — which the skill never creates — becomes what gates whether a public hostname exists at all.
- Offer `create` in planning only when a hosted zone covering the hostname is adopted in the target account, and check the hostname is inside the recorded `zoneName` before the decision is accepted.

### GitHub OIDC provider

- Promote `github-oidc-provider` to a first-class plan entry with a real create-or-adopt decision and a `providerArn` adopt identifier, rather than the aside it is today under `github-oidc-role`.
- Add `oidcProvider: Adoptable<{ providerArn: string }>` to the `github-actions` variant of `PipelineConfig`, emit it from `buildPipeline`, and map it to `existingProviderArn` in `bin/app.ts` and `src/main.ts`. This closes the only path from the manifest to the prop that already exists.
- Make the decision a **lookup against the target account first**: `aws iam list-open-id-connect-providers`, matching a URL ending in `token.actions.githubusercontent.com`. A match means `adopt` with that ARN and no question asked. A successful lookup that returns no match means `create`.
- When the lookup cannot be run at all — no credentials, or `iam:ListOpenIDConnectProviders` denied — **ask, and let the answer decide both ways**: the user says one exists and supplies its ARN, which is adopted; or the user confirms none exists, and one is created. A lookup that could not run is never read as absence, because "the check failed" and "there is no provider" produce opposite correct actions and only one of them is safe to guess.
- Record both failure directions in the pipeline documentation: a `create` decision against an account that already has one fails with `EntityAlreadyExists`, and an `adopt` decision naming a provider that does not exist fails the role's own creation on an invalid principal.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `infrastructure-generation`: the platform stack requirement gains scenarios for a created versus adopted certificate, for the hosted zone being imported once and shared, and for the GitHub OIDC role reusing an adopted provider rather than creating a second one.
- `pipeline-generation`: the GitHub Actions prerequisites now include the OIDC *provider* as its own create-or-adopt plan entry alongside the role, and the credentials requirement states that the generated stack creates a provider only when the plan records one as absent.
- `resource-planning`: a `create` decision must be carried through to generated code rather than causing the resource and its dependents to be omitted; the certificate's `create` path requires an adopted hosted zone; and the OIDC provider's decision is made from an account check when credentials allow and from an explicit user answer when they do not.

## Impact

- `templates/cdk/lib/config.ts` — `PublicHostname.certificateArn` becomes `certificate: Adoptable<…>`; `PipelineConfig`'s `github-actions` variant gains `oidcProvider: Adoptable<…>`.
- `templates/cdk/lib/platform-stack.ts` — `buildLoadBalancing` creates or imports the certificate; the hosted zone import moves out of `buildDnsRecord`; `buildGitHubOidcRole` passes `existingProviderArn` through from the config.
- `templates/cdk/bin/app.ts` and `templates/cdk-projen/src/main.ts` — map `pipeline.oidcProvider` onto the `githubActions` prop, staying identical apart from import paths.
- `templates/cdk/lib/deploy-permissions.ts` — unchanged if `existingProviderArn` stays the construct's interface; verify only.
- `scripts/generate-config.mjs` — `buildPublicHostname` gates on the hosted zone and emits the certificate union; `buildPipeline` emits the OIDC provider union.
- `schemas/manifest.schema.json`, `skills/ecs-truly-auto-mode/references/manifest-schema.md` — the `github-oidc-provider` plan entry's `providerArn` identifier; no change needed for the certificate.
- `skills/ecs-truly-auto-mode/references/planning/resource-catalog.md` — the certificate entry's promise matches the code and states the hosted-zone precondition; `github-oidc-provider` becomes its own entry.
- `skills/ecs-truly-auto-mode/references/planning/adopt-validation.md` — the certificate's `ISSUED` check becomes adopt-only; the OIDC provider check becomes the decision procedure, including what to do with no credentials.
- `skills/ecs-truly-auto-mode/references/pipeline/contract.md` — the two OIDC provider failure modes.
- `docs/adopting-resources.md`, `docs/known-limits.md` — the certificate is no longer effectively adopt-only; the OIDC provider is listed with its identifier.
- `examples/` manifests and `scripts/verify-fixtures.mjs` — fixtures covering a created certificate, an adopted certificate, a created provider, and an adopted provider.
