## 1. Config contract

- [x] 1.1 In `templates/cdk/lib/config.ts`, replace `PublicHostname.certificateArn: string` with `certificate: Adoptable<{ certificateArn: string }>`, keeping `hostname`, `hostedZoneId` and `zoneName` as they are
- [x] 1.2 In the same file, add `oidcProvider: Adoptable<{ providerArn: string }>` to the `github-actions` variant of `PipelineConfig`, non-optional, so an undecided manifest is a type error rather than a silent create
- [x] 1.3 Document on both types why the zone is adopt-only, why a created certificate is DNS-validated against it, and why the provider is a union rather than an optional ARN — matching the comment density of the surrounding types

## 2. Platform stack: certificate

- [x] 2.1 In `templates/cdk/lib/platform-stack.ts`, extract the `route53.HostedZone.fromHostedZoneAttributes` call out of `buildDnsRecord` into a single import (construct ID `HostedZone`) reachable by both the certificate and the alias record
- [x] 2.2 Change `buildDnsRecord` to take the imported `route53.IHostedZone` rather than importing its own
- [x] 2.3 In `buildLoadBalancing`, branch on `publicHostname.certificate.mode`: `adopt` keeps `acm.Certificate.fromCertificateArn` with the recorded ARN; `create` builds `new acm.Certificate(this, 'Certificate', { domainName: hostname, validation: acm.CertificateValidation.fromDns(zone) })`
- [x] 2.4 Confirm the HTTPS listener, the port-80 redirect listener, and the alias record are unchanged on both branches — the only difference is where the certificate comes from
- [x] 2.5 Confirm no `fromLookup` or context-dependent call was introduced, so synth stays hermetic

## 3. Platform stack and entry points: OIDC provider

- [x] 3.1 Add the provider decision to `PlatformStackGitHubActions` consumption in `buildGitHubOidcRole`, passing `existingProviderArn` through to `GitHubOidcRole` — confirm `deploy-permissions.ts` itself needs no change
- [x] 3.2 In `templates/cdk/bin/app.ts`, map `pipeline.oidcProvider.mode === 'adopt' ? { existingProviderArn: pipeline.oidcProvider.providerArn } : {}` into the `githubActions` prop
- [x] 3.3 Apply the identical change to `templates/cdk-projen/src/main.ts`, keeping the two files identical apart from import paths
- [x] 3.4 Confirm the `codepipeline` target is unaffected: no `githubActions` prop, no provider, no OIDC role

## 4. Manifest projection

- [x] 4.1 In `scripts/generate-config.mjs`, rewrite `buildPublicHostname` to gate on the adopted `hosted-zone` entry plus a recorded hostname, and to emit `certificate: { mode: 'create' }` or `{ mode: 'adopt', certificateArn }` from the `certificate` plan entry
- [x] 4.2 Make an unsatisfiable public hostname — a recorded hostname with a `certificate` entry that is neither `create` nor a complete `adopt`, or with no adopted hosted zone — fail loudly with a message naming the missing piece, rather than returning `undefined`
- [x] 4.3 Extend `buildPipeline` to emit `oidcProvider` from the `github-oidc-provider` plan entry for the `github-actions` target, and to fail with a message naming the missing decision when that entry is absent or is `adopt` with no `providerArn`
- [x] 4.4 Confirm a plan with `certificate: skip` and `dns-record: skip` still projects no `publicHostname` and produces an internal HTTP-only load balancer, unchanged

## 5. Manifest schema

- [x] 5.1 Add `providerArn` to the identifier documentation for a `github-oidc-provider` plan entry in `skills/ecs-truly-auto-mode/references/manifest-schema.md`, and add a pattern constraint in `schemas/manifest.schema.json` if plan identifiers are constrained per resource there
- [x] 5.2 Confirm no new top-level manifest field is needed for either resource — both decisions belong in `plan.resources`

## 6. Planning behavior

- [x] 6.1 Update the `certificate` entry in `skills/ecs-truly-auto-mode/references/planning/resource-catalog.md` to state that `create` is offered only when a hosted zone covering the hostname is adopted, and that a created certificate blocks the platform stack's first deploy until ACM issues it
- [x] 6.2 Promote `github-oidc-provider` from the aside under `github-oidc-role` to its own catalog entry, with `providerArn` as the adopt identifier and both create and adopt paths stated
- [x] 6.3 In `skills/ecs-truly-auto-mode/references/planning/adopt-validation.md`, scope the existing `describe-certificate` / `ISSUED` / region checks to the adopt path, and add the hostname-inside-`zoneName` precondition for the create path
- [x] 6.4 In the same file, turn the GitHub OIDC provider check into a decision procedure the skill runs before asking anything: `aws iam list-open-id-connect-providers`, matching a URL ending in `token.actions.githubusercontent.com` — a match records `adopt` with that ARN and `validated: true`, a successful call returning no match records `create` with `validated: true`
- [x] 6.5 State in that procedure that a lookup which could not run — no credentials, or `iam:ListOpenIDConnectProviders` denied — is not evidence of absence, and falls through to a question rather than to `create`
- [x] 6.6 Write the fallback question so its answer decides both ways: the user says one exists and supplies its ARN (recorded `adopt`, `validated: false`), or confirms none exists (recorded `create`, `validated: false`); offer `arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com` as the pre-filled suggestion for the ARN rather than synthesizing it unasked
- [x] 6.7 Add to that check a note that an adopted provider missing the `sts.amazonaws.com` client ID fails at pipeline run time rather than deploy time, and that it is visible in the same call
- [x] 6.8 Update `skills/ecs-truly-auto-mode/references/planning/plan-presentation.md` if it names the certificate as adopt-only or omits the provider entry
- [x] 6.9 Add to `skills/ecs-truly-auto-mode/references/planning/replanning.md` that flipping the certificate from `adopt` to `create` issues a second certificate for the same domain, and that flipping the provider from `create` to `adopt` leaves any previously created provider in place unmanaged

## 7. Documentation

- [x] 7.1 In `docs/adopting-resources.md`, add `github-oidc-provider` with `providerArn` to the identifier table, and remove any implication that the certificate can only be adopted
- [x] 7.2 In `skills/ecs-truly-auto-mode/references/pipeline/contract.md`, name both OIDC provider failure modes — `EntityAlreadyExists` from a `create` decision against an account that already has one, and the invalid-principal role failure from an `adopt` decision naming one that does not exist
- [x] 7.3 Check `README.md`, `docs/getting-started.md`, `docs/known-limits.md` and `skills/ecs-truly-auto-mode/SKILL.md` for statements that a certificate must exist before the platform stack deploys, or that the OIDC provider is always created, and correct them
- [x] 7.4 Add a note to `skills/ecs-truly-auto-mode/references/generation/iac-style.md`'s re-run section that regenerating an app produced before this change rewrites `config.ts` and `app-config.ts` together, and that a hand-edited `app-config.ts` is caught by the existing overwrite check

## 8. Examples and fixtures

- [x] 8.1 Add a `github-oidc-provider` plan entry to every example manifest whose pipeline target is `github-actions`, with at least one `create` and at least one `adopt`
- [x] 8.2 Add a `certificate: create` case to the example manifests — either a new example or by switching one existing public-hostname manifest — keeping at least one exercising `certificate: adopt`
- [x] 8.3 Give each of those plan entries a `reason` that states which path it is pinning down, so the fixtures read as the coverage they are
- [x] 8.4 In `scripts/verify-fixtures.mjs`, assert the certificate create path synthesizes an `AWS::CertificateManager::Certificate` with `DomainValidationOptions` naming the recorded `hostedZoneId`, and the adopt path synthesizes none and references the recorded ARN on the listener
- [x] 8.5 In the same suite, assert the provider adopt path synthesizes no OIDC provider and the role's trust policy names the recorded ARN, and the create path synthesizes exactly one for `token.actions.githubusercontent.com` with the `sts.amazonaws.com` client ID
- [x] 8.6 Assert both certificate paths still produce exactly one alias record and one HTTPS listener

## 9. Verification

- [x] 9.1 Confirm the created OIDC provider's custom resource deploys for an `egress: none` application — it runs in the CloudFormation service account rather than the VPC — and record the finding either way
- [x] 9.2 Run `npm run validate:examples` and `npm run validate:manifest` and confirm the updated examples pass the JSON Schema
- [x] 9.3 Run `npm run verify:fixtures` and confirm all four paths synthesize with no AWS credentials present
- [x] 9.4 Run `npm run verify:styles` and confirm the plain and projen sources are still identical apart from import paths, including both entry points
- [x] 9.5 Run `npm run verify:pipelines` and confirm the two pipeline targets are still equivalent where the contract requires it
- [x] 9.6 Run `npm test`, `npm run eslint` and `npm run lint:cfn`, and confirm the generated templates lint clean on all four paths
