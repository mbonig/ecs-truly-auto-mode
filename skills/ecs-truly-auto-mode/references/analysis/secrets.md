# Configuration and secrets

Enumerate the environment variables the container reads, and split them into
plaintext configuration and secrets. The split matters because it decides whether a
value lands in the task definition's `environment` block — readable by anyone with
`ecs:DescribeTaskDefinition` — or its `secrets` block, injected at task start by the
execution role.

## The rule that overrides everything else

**Never read a secret's value.** Record the variable *name* and a pointer to where
the value lives. Nothing else.

This is not a stylistic preference. A secret read into an agent's context has leaked:
it lands in conversation history, in logs, and potentially in a file written later. If
a `.env` file with real credentials is sitting in the repo, the correct behavior is to
note that the variable exists and move on without opening it.

Concretely:

- Read `.env.example`, `.env.sample`, `.env.template` — these hold names with
  placeholder values and are meant to be read.
- Do **not** read `.env`, `.env.local`, `.env.production`, or any file matching
  `*.pem`, `*.key`, `credentials`, `secrets.y?ml`.
- To learn which variables exist, read the **code that consumes them**
  (`process.env.X`, `os.environ["X"]`), not the files that supply them.
- If a real secret value is encountered incidentally, do not record it, do not repeat
  it, and do not include it in a summary. Mention that a credential appears to be
  committed — that is worth the user knowing — without reproducing it.

The manifest schema enforces this structurally: a secret entry has no `value`
property and forbids additional properties, so a value cannot be recorded even by
mistake.

## Classifying

### Secret

By **name** — case-insensitive substring match:

`PASSWORD`, `PASSWD`, `SECRET`, `TOKEN`, `API_KEY`, `APIKEY`, `ACCESS_KEY`,
`PRIVATE_KEY`, `CREDENTIAL`, `AUTH`, `SIGNING`, `SALT`, `CERT`, `PASSPHRASE`,
`CLIENT_SECRET`, `WEBHOOK_SECRET`, `ENCRYPTION_KEY`, `DSN`.

By **usage**, regardless of name — a variable passed as a password or credential
argument, an `Authorization` header, a signing key, or a JWT secret. Usage beats
naming: a variable called `DB_STRING` used as a connection string with a password in
it is a secret.

By **shape** — a connection URL that embeds credentials
(`postgres://user:pass@host/db`) is a secret in full, not a plaintext host.

### Not a secret

`LOG_LEVEL`, `NODE_ENV`, `PORT`, `AWS_REGION`, feature flags, timeouts, pool sizes,
public URLs, bucket **names** (a name is not a credential), and non-sensitive
hostnames.

A CA bundle **path** is plaintext configuration, not a secret, even when it exists
only to make a database connection succeed. It names a file already present in the
image, not a credential — see the libpq trust-path note below.

### Not a secret at all: IAM-authenticated datastores

An IAM-authenticated network datastore (Aurora DSQL; RDS/Aurora with IAM database
authentication — see [datastores.md](./datastores.md)) has **no password anywhere in
the system**. The driver authenticates with a short-lived SigV4 token signed by the
task role, so there is no `config.secrets` entry to record for it — recording one is
a bug, not a cautious extra. The endpoint hostname it connects to is plaintext
configuration, exactly like a bucket name, and belongs in `config.environment` (or,
when the platform stack resolves it at deploy time, injected the same way a
platform-published SSM value normally is).

A libpq-based driver (`psycopg`, `psycopg2`, `ruby-pg`, `pdo_pgsql`, `psql`) connecting
with `sslmode=verify-full` from a slim or minimal base image is a case worth flagging
regardless of which datastore it is: libpq's default `sslrootcert`
(`~/.postgresql/root.crt`) does not exist in most container images, and its `system`
mode resolves through OpenSSL's hashed-symlink directory, which slim images typically
omit even though the underlying CA bundle is present and correct. The practical
result is a connection that fails outright, or — worse — an application that catches
the error and reports healthy anyway, which an ALB health check cannot see through.
For a Debian/Ubuntu-based image, recommend the explicit path
`/etc/ssl/certs/ca-certificates.crt` as plaintext `config.environment`, using the
variable name the application code already reads — never invent one. Alpine,
distroless, and RHEL-family paths differ and have not been verified; say so rather
than guessing. Clients that are not libpq-based (Node `pg`, Go `pgx`) use their
runtime's own TLS stack and need no such variable.

### Neither, and worth catching

**AWS credentials** — `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_SESSION_TOKEN`. These should not be injected at all. A Fargate task gets
credentials from its **task role** through the container credentials endpoint. If the
code reads them explicitly, that is a finding to raise: the task role replaces them,
and the plan should say so rather than wiring up a secret to preserve a pattern that
should go away.

The AWS SDKs pick up the task role automatically with no configuration, so in almost
every case the fix is deleting the explicit credential handling.

### Ambiguous

Ask, and default to treating it as a secret. Putting a non-secret in the `secrets`
block costs an extra API call at task start. Putting a secret in the `environment`
block exposes it to everyone with read access to the task definition. The asymmetry
is obvious enough to decide the default.

## Where the values live

For each secret, ask the user for the store:

- **Secrets Manager** — record the ARN. For a JSON-valued secret, also record the
  `jsonKey`; ECS can inject a single key rather than the whole document, which is
  what makes an RDS-managed credential secret usable directly.
- **SSM Parameter Store** — record the parameter name. `SecureString` parameters work
  the same way at injection time and cost nothing.

If the secret does not exist yet, it becomes a plan entry the user must create before
deploying. The skill does not create secrets, because creating one means having its
value, and having its value is the thing being avoided.

RDS-managed credentials are the common case worth naming: an RDS instance with
managed rotation already has a Secrets Manager secret containing `username`,
`password`, `host`, `port`, and `dbname`. Point at it with the appropriate `jsonKey`
rather than creating a parallel secret that will drift out of date after the first
rotation.

## Recording

```yaml
config:
  environment:
    - name: LOG_LEVEL
      value: info
  secrets:
    - name: DATABASE_URL
      source: secretsmanager
      arn: arn:aws:secretsmanager:us-east-1:071128183726:secret:orders/db-AbC123
      jsonKey: url
      confidence: high
      evidence:
        - file: app/db.py
          line: 6
          excerpt: 'os.environ["DATABASE_URL"]'
```

Note that the evidence excerpt shows the *read* of the variable, never its value.

## What this produces downstream

- `config.environment` → the task definition's `environment` block.
- `config.secrets` → the task definition's `secrets` block, plus
  `secretsmanager:GetSecretValue` or `ssm:GetParameters` on those specific ARNs,
  granted to the **execution role**.

The execution role, not the task role, is what matters here: secret injection happens
before the container starts, performed by the ECS agent. Granting the task role
instead is a subtle mistake that produces a task which fails to start with a
permission error naming a role that looks correct.

If the secret is encrypted with a customer-managed KMS key, the execution role also
needs `kms:Decrypt` on that key.
