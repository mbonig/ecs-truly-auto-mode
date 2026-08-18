## Context

The generated CDK app treats every AWS resource as create-or-adopt, projected from the manifest's `plan.resources` into a typed config the stacks read and nothing else. `Adoptable<T>` — `{mode:'create'} | ({mode:'adopt'} & T)` — is the existing shape for that, already used by `cluster`, `repository`, `logGroup` and `loadBalancer`.

Two resources never got it, and they fail in opposite directions.

The **certificate** is adopt-only in code. `PublicHostname` is a flat record with a required `certificateArn`, so `platform-stack.ts` has exactly one path (`Certificate.fromCertificateArn`), and `generate-config.mjs` refuses to emit a `publicHostname` at all unless the `certificate` plan entry is `adopt`. Everything upstream already models `certificate` as a resource with a `create` action; only the projection and the stack are missing it, and the mismatch fails silently.

The **GitHub OIDC provider** is create-only in code. `GitHubOidcRole` already accepts `existingProviderArn`, and `PlatformStackGitHubActions` already forwards it — but no manifest field, no projection, and no entry point ever populates it. The default is therefore "create", against accounts that `adopt-validation.md` itself says usually already have a provider, and the mismatch fails loudly at deploy with `EntityAlreadyExists`.

Both are the same defect: the plan's decision never reaches the generated stack. Both touch the same four files. Fixing them separately means editing those files twice.

Two constraints shape the work. Synth must stay hermetic — no `fromLookup`, no `cdk.context.json`, no credentials. And the skill does not create hosted zones, so any created certificate must validate against a zone the user already owns in the target account.

## Goals / Non-Goals

**Goals:**

- `certificate: create` produces a DNS-validated `AWS::CertificateManager::Certificate` wired to the HTTPS listener; `certificate: adopt` keeps today's import-by-ARN behavior exactly.
- `github-oidc-provider: adopt` makes the deploy role trust the existing provider and creates none; `github-oidc-provider: create` creates one, for the accounts that genuinely have none.
- Neither decision can be reached by default. The provider decision comes from an account check or an explicit answer; a certificate `create` decision can never silently degrade the hostname to an internal HTTP listener.
- Synth still needs no AWS credentials on any of the four paths.
- Both project styles stay equivalent; changes land in the shared stack sources and in both entry points, not in per-style scaffolding.

**Non-Goals:**

- Creating hosted zones. Unchanged: zones are adopt-only, because creating one means delegating nameservers at a registrar.
- Validation methods other than DNS against an adopted Route 53 zone.
- Cross-account certificate validation, where the zone lives outside the target account.
- Subject alternative names or wildcard certificates. One certificate, one recorded hostname.
- Certificates for anything but the ALB listener. CloudFront and API Gateway are out of scope, and the `us-east-1` regional trap that comes with them stays a validation warning on the adopt path.
- Managing the OIDC provider's lifecycle beyond creation. An adopted provider's thumbprint list and client IDs are the account owner's; the skill reads the ARN and does not modify it.
- Deleting or reconciling a provider when a plan flips from `create` to `adopt`. The stack stops managing it; it does not remove one it previously created.

## Decisions

### Certificate becomes `Adoptable<{ certificateArn: string }>` on `PublicHostname`

Not a separate top-level config field: the certificate has no meaning without a hostname to issue it for and a zone to validate it against, and those three values are already grouped. Separating them would let the config express a certificate for no hostname.

Rejected alternative: keep `certificateArn` and add an optional `createCertificate: boolean`. It admits the incoherent state `createCertificate: true` alongside a populated ARN, and would be the only resource in the config not using `Adoptable`.

### The zone is imported once and passed to both consumers

`buildDnsRecord` currently calls `HostedZone.fromHostedZoneAttributes` with construct ID `HostedZone`. A created certificate needs the same zone for `CertificateValidation.fromDns`. Importing it twice would either collide on the ID or need a second ID for the same logical resource, which reads as two zones in the construct tree. Hoisting the import into the ingress path that owns both is a small refactor and keeps the tree honest.

### DNS validation via `acm.CertificateValidation.fromDns(zone)`, not a custom resource

With a hosted zone ID in `DomainValidationOptions`, CloudFormation's native ACM resource writes the validation record itself and waits for issuance. No Lambda, no extra IAM, no synth-time lookup — `fromHostedZoneAttributes` is attribute-based, so hermetic synth holds. The cost is a blocking deploy, covered under risks.

### The hosted zone, not the certificate, gates whether a public hostname exists

`buildPublicHostname` currently requires `certificate.action === 'adopt' && hostedZone.action === 'adopt'`. It becomes: a recorded hostname, plus an adopted hosted zone, plus a `certificate` entry that is `create` or a complete `adopt`. That is the correct invariant in both directions — without a zone there is nowhere to put the alias record or the validation record, so neither a DNS record nor a created certificate can exist.

### A `certificate: create` entry with no adopted hosted zone is a planning error, not a generation-time degradation

The projection cannot invent a zone, and silently returning `undefined` is the bug being fixed. Planning offers `create` only when a zone is adopted; a manifest that reaches generation in that state gets a message naming what is missing. This matches how the plan gate already treats an `adopt` entry with no identifiers.

### `github-oidc-provider` becomes a first-class plan entry, not a `pipeline.*` field

The catalog already names `github-oidc-provider` as a resource id, in an aside under `github-oidc-role`. Making it a real entry with `action` and a `providerArn` identifier puts the decision where every other create-or-adopt decision lives, gets it presented and approved with the rest of the plan, and gets it validated by the machinery that already validates adopted identifiers.

Rejected alternative: a `pipeline.oidcProviderArn` string. `pipeline.roleArn` is a *record* of the role once it exists, not a decision; overloading `pipeline` with a decision would hide it from the plan the user approves.

### The decision reaches the stack through `PipelineConfig`, as `Adoptable<{ providerArn: string }>`

`AppConfig` is the projection of the resource plan and `PipelineConfig` is the pipeline's own shape, so a strict reading would put the provider in `AppConfig`. But the platform stack's `githubActions` prop is already fed entirely from `pipeline` in both entry points, and the provider exists only for the `github-actions` target. Putting it on that variant of `PipelineConfig` keeps one prop fed from one source.

It is a union rather than an optional `providerArn?: string` deliberately. An absent optional field means "create" by omission, which is precisely the failure being fixed — the union forces the projection to have made a decision, and an incomplete one is a type error rather than a silent default.

### `GitHubOidcRole` keeps its `existingProviderArn?: string` interface; the entry point does the mapping

`deploy-permissions.ts` is untouched. `bin/app.ts` and `src/main.ts` map `pipeline.oidcProvider.mode === 'adopt' ? { existingProviderArn: … } : {}` at the single place that already builds the `githubActions` prop. The construct-level default stays "create when absent", but nothing reaches it without an explicit upstream decision, and the mapping is in one reviewable line per entry point.

### Keep the L2 `iam.OpenIdConnectProvider` on the create path

The create path is the code that exists today; the change is that it is now reached deliberately rather than by omission. The L2 fetches the issuer thumbprint through a custom resource, which adds a Lambda to the platform stack. That is a real cost, and `CfnOIDCProvider` would avoid it — but the L1 requires the thumbprint as input, which reintroduces a value that goes stale, and the platform stack is the rarely-deployed one. Verify during implementation that the custom resource deploys for an `egress: none` app: it runs in the CloudFormation service account rather than the VPC, so it should, and that is worth confirming rather than assuming.

### The provider decision is a lookup first, a question only when the lookup cannot run

The skill looks in the account before it asks anything. `aws iam list-open-id-connect-providers`, matching a URL ending in `token.actions.githubusercontent.com`:

| Outcome | Decision |
| --- | --- |
| A match | `adopt` with that provider's ARN, `validated: true`, no question asked |
| The call succeeded and returned no match | `create`, `validated: true` — the account demonstrably has none |
| The call could not run | **ask**, and record the answer with `validated: false` |

The question, when it is reached, decides both ways rather than merely confirming a default:

- *"This account already has one"* → the user supplies its ARN, and the entry is `adopt` with that ARN.
- *"This account has none"* → the entry is `create`.

`adopt-validation.md` already describes this check as one that "decides create versus adopt rather than merely confirming a value". The procedure exists; what is missing is that its outcome is recorded in the plan and reaches the generated stack.

**A lookup that could not run is not absence.** This is the distinction the whole decision turns on. `iam:ListOpenIDConnectProviders` denied, an expired session, or a wrong profile all return "no provider found" to code that only checks for a match — and reading that as `create` reproduces `EntityAlreadyExists` against the very accounts most likely to have a provider already. Only a call that *succeeded* and returned nothing is evidence of absence. Anything else is an unanswered question, and unanswered questions are asked, per the skill's own escalation rule.

**The ARN is supplied by the user on the ask path, not synthesized.** GitHub's provider ARN is conventionally `arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com`, and offering that as the pre-filled suggestion is worth doing — it is the same pattern the skill uses for a `medium`-confidence finding. But it is recorded as an explicit, user-confirmed identifier like every other adopted value, so it stays visible in the plan and survives non-commercial partitions where the prefix differs.

## Risks / Trade-offs

**A created certificate blocks the platform stack's first deploy until ACM issues it** → CloudFormation waits on the certificate resource, and if the validation record cannot be written or the zone is not authoritative for the hostname, the stack sits in `CREATE_IN_PROGRESS` until it times out rather than failing fast. Mitigate by stating this in the catalog and the user docs, and by checking during planning that the recorded hostname is the adopted `zoneName` or a subdomain of it — the check that catches the common cause before a deploy starts. The platform stack is the rarely-deployed one, so the cost lands once.

**Zone/hostname mismatch is only checkable against the recorded `zoneName`** → the string check catches `api.example.com` recorded against `other.com`, but not a zone that exists and simply is not the one served at the registrar. That residual case is the same class as an undelegated zone and is beyond what the skill can verify; the adopt path stays available and is the honest recommendation when the user is unsure.

**Both OIDC provider decisions fail at deploy when wrong, in opposite ways** → `create` against an account that already has one fails with `EntityAlreadyExists` on the provider; `adopt` naming a provider that does not exist fails the role's own creation on an invalid principal in the trust policy. Both are deploy-time and neither is catchable by synth. Mitigate by making the account check the default source of the decision, and by documenting both messages in `contract.md` so the diagnosis is a lookup rather than an investigation.

**An account with a GitHub OIDC provider created by another tool is adopted, not managed** → correct, and worth being explicit about: the skill reads the ARN and does not touch thumbprints or client IDs. If that provider lacks the `sts.amazonaws.com` client ID, the role cannot be assumed and the failure surfaces at pipeline run time, not deploy time. Worth a line in the validation reference, checkable in the same `list`/`get` call that makes the decision.

**Changing `PublicHostname` and `PipelineConfig` breaks the generated config contract** → both `config.ts` and `app-config.ts` are generated together from the manifest, so a re-run fixes any repo. The risk is a user who hand-edited `app-config.ts`; that is exactly what the `generated` SHA-256 record catches, and the overwrite check already stops and asks. State it in the re-run notes so it is not discovered as a type error.

**A previously-adopted certificate switched to `create` issues a second certificate for the same domain** → ACM permits this and the old certificate costs nothing, so the failure is confusing rather than harmful. Note it in the replanning reference alongside the other action-change consequences rather than trying to prevent it.

**Test surface: no example manifest exercises a public hostname on the create path, and none records a `github-oidc-provider` entry at all** → that is how both gaps shipped. Fixtures covering all four paths are part of this change, not a follow-up.
