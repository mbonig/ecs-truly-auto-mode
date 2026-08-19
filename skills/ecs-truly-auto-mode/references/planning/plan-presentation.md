# Presenting the plan

The plan is the moment the user can catch a wrong inference for free. After this,
mistakes cost a failed deploy or a surprising bill. So it is optimized for *being
read* — which mostly means being short enough that someone actually reads it.

## Ordering by consequence

Not alphabetical, not by resource type. Ordered by what it costs to get wrong:

1. **Egress classification** — decides NAT, which is standing cost. Always first,
   always with its evidence.
2. **Adoption decisions still needing an identifier** — these block generation.
3. **Datastores** — a miss here means a service that cannot reach its data.
4. **Inbound configuration** — port and health check. A wrong health check means a
   service that never stabilizes.
5. **Everything created with sensible defaults** — collapsed to a list.
6. **Everything skipped** — one line each, with the reason.

## Shape

```
## Plan: orders-api → 071128183726 / us-east-1

### Network egress: PUBLIC — a NAT gateway will be created

  app/payments.py:15  httpx.post("https://api.stripe.com/v1/charges", ...)

  This one call is what requires it. A NAT gateway costs roughly $32/month plus
  data processing. Without that call the service would run in isolated subnets
  with no NAT at all.

### Needs an identifier from you (3)

  database        An existing RDS Postgres instance
                  Detected: app/db.py:6, alembic.ini
                  Need: instance identifier, endpoint, port, security group

  certificate     An ACM certificate for orders.example.com
                  Need: certificate ARN in us-east-1
                  Or `create` — issued and DNS-validated in the zone below

  hosted-zone     The public zone for example.com
                  Need: hosted zone ID

### Datastores (3)

  RDS Postgres    adopt  — orders-prod, found in the account
                  Security group rule + credentials secret

  S3 receipts     adopt  — orders-receipts-prod, found in the account
                  s3:PutObject, s3:GetObject

  sessions-table  CREATE — no table named in app/sessions.py exists in this account
                  Key: sessionId (S)  — from app/sessions.py:14, confirmed
                  On-demand billing, PITR on
                  Retained on stack deletion

### Inbound

  Port 8000, health check GET /healthz
  From docker/Dockerfile:18 and app/main.py:44,20 — corroborated, high confidence.

### Will be created (9)

  cluster, ecr-repository, load-balancer, target-group, log-group,
  task-role, execution-role, task-security-group, alb-security-group

### Will be skipped (1)

  vpc-endpoints   Private subnets have NAT; interface endpoints are optional

### Generated project

  Pipeline    GitHub Actions, on push to main
  Infra app   plain CDK  (projen is the alternative -- same stacks either way)
```

## Presenting a created datastore

A created datastore needs three things said that an adopted one does not, because each is
a commitment the user cannot see from the entry alone:

1. **Why it is `create`.** Name the lookup: "no table of that name exists in this
   account". A `create` that reads as a default invites the user to wonder what was
   checked. If the lookup could not run, say *that* instead — and offer both actions.
2. **The shape, and where it came from.** Which values were asked, which were derived
   from the code (with the `file:line`), and which are fixed. A created table's key
   schema is worth showing in full: it is immutable, so it is the one datastore value the
   user cannot revise later.
3. **What it leaves behind.** Retained on stack deletion, and deletion-protected for a
   database. Add the **first-deploy duration** for a relational or document database —
   tens of minutes, which reads as a hang if unsaid — and that the database comes up
   **empty**, so migrations are still the user's.

Do not steer toward `adopt`. Both actions are real, and a datastore the account does not
have is an ordinary answer rather than a blocked run.

The one case that is genuinely blocked: a `create` decision on a database whose
application reads a single URL-shaped variable. Say what is missing and name both
resolutions, rather than falling back to `adopt` or injecting fields nothing reads:

```
  database        CREATE — but incomplete

                  app/db.py:8 reads DATABASE_URL as a single connection string.
                  A generated secret holds host, port, username, password and
                  dbname — it cannot hold an assembled URL, and composing one
                  would mean reading the password.

                  Pick one:
                    1  Give me a secret ARN holding the URL. The database is
                       still created; the secret is injected by reference.
                    2  Switch to discrete PGHOST/PGUSER/... and adapt the app.
```

## The egress headline

This gets a section of its own, always, in both directions. It is the item most
likely to cost money the user didn't intend and least likely to be noticed in a list.

**When `public`:** name the specific call. Give the rough monthly cost. Say what it
would be without that call, so the user can weigh whether the dependency is worth it —
sometimes the answer is to move that call elsewhere.

**When `none`:** say what was *not* found, and be honest that this is the riskier
direction to be wrong in.

```
### Network egress: NONE — isolated subnets, no NAT gateway

  No outbound call leaves the VPC. Checked: HTTP clients, URL literals,
  third-party SDKs, and runtime package installs.

  This saves roughly $32/month versus a NAT gateway. Interface endpoints for
  ECR and CloudWatch Logs will be created instead (~$7/month each per AZ).

  If the service later needs to reach something on the internet, it will fail
  with a connection timeout. Switching is a one-line manifest change.
```

## Rules

**State high-confidence findings; don't ask about them.** A port corroborated by both
the Dockerfile and a listener bind is a statement. Asking about it trains the user to
click through without reading, which defeats the purpose of the plan.

**Show evidence as `file:line`, not prose.** `app/payments.py:15` is checkable in
seconds. "an outbound call in the payments module" is not.

**Batch the questions.** Every question for a phase comes at once, ordered by
consequence. A run that asks one question at a time across twenty resources is a
worse experience than a wrong default. The two generation-shape questions — pipeline
target and [infra style](../generation/iac-style.md) — depend on nothing in the
analysis, so they are asked together, near the end, after the decisions that cost
money.

**Say what a resource costs when it is not obvious.** NAT gateways, interface
endpoints, and ALBs all carry standing charges. This is the one moment where
mentioning it changes a decision.

**Name what was skipped and why.** A silently-absent certificate looks identical to a
forgotten one.

**Do not present a resource as needing an identifier when it can be created.** The
certificate is the one that gets this wrong: adopting an already-issued one is often
convenient, but it is a choice, not a prerequisite. Whenever `hosted-zone` is adopted,
show `create` alongside the ARN as a real option — the certificate is issued by the
platform stack and DNS-validated in that zone, so nothing has to exist in AWS first.

**Show a decision the skill already made, and how it made it.** The GitHub OIDC
provider is normally answered by looking in the account rather than by asking, so it
belongs in the plan as a stated decision rather than a question:

```
  github-oidc-provider   adopt — found in this account
                         arn:aws:iam::071128183726:oidc-provider/token.actions.githubusercontent.com
```

or, when the account could not be reached, as one of the few questions worth asking
outright — because guessing it wrong fails the first deploy in one direction or the
first pipeline run in the other. See
[adopt-validation.md](./adopt-validation.md#github-oidc-provider).

## Approval

Approval is explicit, and generation is blocked until `plan.approved` is `true`.

Before asking for it, verify the plan is **complete** — every `adopt` entry has
non-empty identifiers, and every finding is either `high` or `confirmedByUser`. An
incomplete plan cannot be approved regardless of what the user says; the validator
rejects it, and generating from it would produce CDK that does not synthesize.

If something is missing, say exactly what and stop:

```
Cannot generate yet — 2 items still need identifiers:

  database      instance identifier, endpoint, port, security group
  certificate   certificate ARN

Supply these, or change either entry to `create` where that's an option.
```

## On a re-run

Do not re-present the whole plan. Show the diff, and say plainly when there isn't
one — see [replanning](./replanning.md).
