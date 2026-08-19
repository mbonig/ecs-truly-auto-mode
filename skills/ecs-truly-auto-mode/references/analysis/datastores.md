# Datastore analysis

Datastores split into three kinds, and the distinction drives everything downstream:

- **Network-reached** (RDS, ElastiCache, DocumentDB) — connected to over TCP with
  credentials. Needs a **security group rule** and a **secret**. IAM grants nothing.
- **API-reached** (DynamoDB, S3, SQS, SNS) — called through the AWS SDK. Needs
  **task role permissions** and, in isolated subnets, a **VPC endpoint**. No security
  group rule, no credentials.
- **IAM-authenticated network** (Aurora DSQL) — reached over TCP like a database, but
  authorised by IAM like an API. Needs **task role permissions** and no security
  group at all: DSQL is regional and serverless, with no ENI in any VPC.

Getting this backwards produces a confusing failure: an IAM policy for RDS that
grants nothing, or a security group rule for DynamoDB that does nothing, while the
actual missing piece goes unnoticed. The third category exists because DSQL cannot be
expressed as either of the first two without lying: it has a port and an endpoint like
a network-reached store, but no security group and no password like an API-reached
one.

See [ecosystems](./ecosystems.md) for the per-language dependency signals. This
document covers what each detected datastore *implies*.

## Confidence

A dependency in the manifest is one signal. Corroborate it with a second before
calling it `high`:

- A driver dependency **and** a connection string or ORM config → `high`.
- A driver dependency **and** a `migrations/` directory → `high`.
- A driver dependency alone → `medium`. It may be transitive, or left over.
- An env var named `DATABASE_URL` alone → `medium`.

A transitive driver dependency is common and means nothing on its own — many
frameworks pull in database drivers they never use.

## Network-reached datastores

### RDS / Aurora

**Signals:** a driver dependency, an ORM config naming a dialect, a `migrations/`
directory, `*.rds.amazonaws.com` in config, a `DATABASE_URL`.

**Implies:**

- A **security group rule**: task security group → database security group on the
  engine port (PostgreSQL 5432, MySQL/MariaDB 3306, SQL Server 1433, Oracle 1521).
  This is the piece most often missed, and it fails as a connection timeout at
  startup rather than a clear permission error.
- A **secret** for the credentials. See [secrets](./secrets.md).
- **`iamActions: []`** — an ordinary password connection needs no IAM at all.
- Placement: the database must be reachable from the task subnets.

**IAM database authentication** is the exception: `rds-db:connect` on
`arn:aws:rds-db:<region>:<account>:dbuser:<resource-id>/<user>`, and no password
secret. Signals are an `AWSAuthenticationPlugin` config, a `rds.iam` connection
option, or a token-generation call. Do not assume it — it is uncommon, and assuming
it wrongly produces an app that cannot authenticate.

**Adopting:** collect `dbInstanceIdentifier`, `endpointAddress`, `port`, and
`securityGroupId`, and wire connectivity to it. Planning looks for one in the account
first, keyed on whatever name was found — see
[adopt-validation](../planning/adopt-validation.md#rds-instance).

**Creating:** record `engine` and the [connection style](#connection-variables) below.
The instance class, engine version, allocated storage and multi-AZ setting are *asked*
during planning rather than recorded here, because they carry a standing monthly cost
and no static analysis can infer them.

A created database is retained on stack deletion and deletion-protected, and its first
deploy blocks for tens of minutes. Say both when presenting the plan — the second reads
as a hang otherwise.

Two things a created database is **not**: migrated, or Aurora. It comes up empty, so an
app with a `migrations/` directory still needs a migration step that this skill does not
generate — say so at completion. And an `aurora-*` engine is adopt-only: a cluster's
writer/reader topology is not derivable from application code, and creating a
single-instance cluster misrepresents what Aurora is for.

### Connection variables

For every network-reached datastore, record the environment variables the application
reads to reach it, and **which of two shapes they are**:

- **`fields`** — discrete variables: `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`,
  `DB_NAME`. Map each onto the secret field that supplies it.
- **`url`** — one variable holding an assembled connection string: `DATABASE_URL`,
  `REDIS_URL`, `MONGO_URI`.

This distinction decides whether a *created* database is usable at all, which is why it
is recorded rather than left implicit.

A created database's credentials are generated, and a generated secret holds `host`,
`port`, `username`, `password` and `dbname`. It does not hold an assembled URL, and
nothing can compose one without reading the password to build it. So:

| Style | Created | Adopted |
| --- | --- | --- |
| `fields` | each variable injected from its secret field | from the recorded secret |
| `url` | **plan is incomplete** — see below | from the recorded secret |

For `create` plus `url`, say exactly that and offer the two resolutions: supply an
existing secret holding the URL — the database is still created, and the secret is
injected by reference like any other — or switch to the discrete variables and adapt the
application. Do not inject five fields an application that reads one will never look at,
and do not quietly fall back to adopting. `DATABASE_URL` is the common case, not an edge
one, so this comes up on most first runs and is worth stating plainly rather than
apologetically.

### ElastiCache (Redis / Memcached)

**Signals:** a `redis` client dependency, `REDIS_URL`, `*.cache.amazonaws.com`.
Sidekiq, Celery, and BullMQ all require Redis.

**Implies:** a security group rule on 6379 (Redis) or 11211 (Memcached), a secret if
auth is enabled, and `iamActions: []`.

**Creating:** the node type and, for Redis, the replica count are asked. ElastiCache has
no generated secret, so the endpoint and port are published as parameters and the
application's host and port variables are injected from those. In-transit encryption is
deliberately left off: it requires the client to connect over TLS, so enabling it
silently would break an application that connects in plaintext. At-rest encryption is on,
because it is transparent to the client.

A queue library is worth flagging beyond the datastore itself: Sidekiq, Celery, and
BullMQ imply a **worker process** separate from the web process — a second task
definition. This skill deploys one service, so a repo with a worker needs a decision
from the user rather than a silent omission.

### DocumentDB / MongoDB

**Signals:** `mongoose`, `pymongo`, `mongodb`, a `MONGO_URI`.

**Ask which.** DocumentDB and self-hosted MongoDB are not interchangeable — they
differ in wire-protocol compatibility, and `mongodb+srv://` URIs (Atlas) mean an
**external** service, which forces `public` egress. This is a case where guessing
wrong changes both the egress classification and the resource plan.

**Creating:** only DocumentDB. The instance class and instance count are asked; the
cluster is retained and deletion-protected like a relational database, and generates its
own credentials secret the same way. A `mongodb+srv://` URI is not a datastore to create
at all — it is an external service, and the answer there is the egress classification.
Note that a Mongo connection string is almost always `url`-shaped, so the
[connection-variable](#connection-variables) rule usually applies.

## API-reached datastores

### DynamoDB

**Signals:** a DynamoDB SDK client. Table names appear as literals, env vars, or
constants.

**Implies:**

- Task role permissions, scoped to the tables in the plan:
  - Reads: `dynamodb:GetItem`, `Query`, `Scan`, `BatchGetItem`
  - Writes: `dynamodb:PutItem`, `UpdateItem`, `DeleteItem`, `BatchWriteItem`
- Grant only the operations the code performs. If it only reads, do not grant writes.
- Index access needs the index ARN (`<table-arn>/index/*`) in addition to the table.
- A **gateway** VPC endpoint in isolated subnets — free, no ENI.
- No security group rule.

**Creating** needs the **key schema**, and this is the one place in the datastore work
where a wrong answer cannot be corrected later: a table's key schema is immutable. Fixing
it means deleting and rebuilding a table that may by then hold data.

So record the partition key, its type, any sort key, and only the indexes the code was
actually found to query — an unqueried index is a standing write cost. Then:

- Key schema at `high` confidence → `create` is available.
- Anything less → **ask.** There is no default, at any confidence level. Planning
  rejects a `create` decision on an unconfirmed key schema rather than guessing.

`GetItem({ Key: { pk: ..., sk: ... } })` and `Query({ KeyConditionExpression: ... })` are
the reliable signals. A table accessed only through a helper that builds keys dynamically
usually cannot be read at all — say so and ask.

Billing mode and point-in-time recovery are not asked: on-demand is the only honest
default when no capacity figure is derivable from static analysis, and the alternative to
PITR is silent, unrecoverable data loss. Say what was chosen; do not ask.

Also record the environment variable carrying the table name. For a *created* table that
name is a deploy-time value, so it is published as a parameter and injected — without the
variable recorded, the table gets created and the container has no way to address it.

### S3

**Signals:** an S3 SDK client, a bucket name in config, presigned-URL generation.

**Implies:** `s3:GetObject` / `s3:PutObject` / `s3:DeleteObject` on
`arn:aws:s3:::<bucket>/*`, and `s3:ListBucket` on `arn:aws:s3:::<bucket>` — a
different resource ARN, which is a routine source of confusing access-denied errors.
Plus a **gateway** endpoint, which is required anyway for ECR image layers.

**Creating** asks nothing. A bucket has no cost knob worth a question, so the shape is
fixed and stated: SSE-S3 encryption, all public access blocked, TLS enforced, versioning
on, retained on stack deletion. Record the environment variable holding the bucket name,
as for a table.

### SQS / SNS / EventBridge

**Signals:** the corresponding SDK clients.

**Implies:** `sqs:SendMessage` / `ReceiveMessage` / `DeleteMessage`,
`sns:Publish`, `events:PutEvents`, each scoped to the specific queue, topic, or bus.
Interface endpoints in isolated subnets.

An SQS **consumer** is another worker-process signal — a long-polling receive loop is
usually not the web process. Same treatment as Sidekiq: flag it and ask.

**Creating** asks nothing here either. A queue gets a dead-letter queue at 5 receives,
because a queue without one silently discards what it cannot process; a topic gets
nothing but a name. Both are retained. Record the variable holding the queue URL or the
topic ARN — a created queue's URL is a deploy-time value.

## IAM-authenticated network datastores

### Aurora DSQL

**Signals:** a PostgreSQL driver dependency (`psycopg`, `asyncpg`, `pg`, `pgx`) plus
any of: `boto3.client("dsql")` / `DsqlSigner` / a `generate_db_connect_auth_token`
call, a `*.dsql.*.on.aws` hostname (or a regex matching one), or a `DSQL_`-prefixed
env var. Driver **and** token-generation call together is `high` confidence — they
are independent signals. A PostgreSQL driver alone is not enough on its own; RDS
PostgreSQL is far more common and looks identical from the driver alone.

**Implies:**

- Task role permissions — `dsql:DbConnect` for a named database role,
  `dsql:DbConnectAdmin` for `admin` — on
  `arn:aws:dsql:<region>:<account>:cluster/<cluster-id>`.
- **No security group rule.** DSQL is regional and serverless — no ENI in the VPC, no
  security group to adopt or create.
- **No secret, in either direction.** The driver authenticates with a short-lived
  SigV4 token signed by the task role. Recording a secret for it is a bug, not a gap.
- Port 5432, PostgreSQL wire protocol, default database `postgres`.
- Egress: DSQL has an interface endpoint for its data plane, so it does **not** force
  `public` — see [egress.md](./egress.md#aws-services-to-vpc-endpoints). "The app uses
  `boto3.client('dsql')`, therefore it needs NAT" is exactly the wrong inference this
  tool exists to avoid.

**Adopting:** collect `clusterIdentifier` and `endpoint`, keyed on any recorded
cluster identifier, same lookup-first procedure as the other datastores — see
[adopt-validation](../planning/adopt-validation.md#dsql-cluster). When
`egress.classification` is `none`, also resolve `vpcEndpointServiceName`: the
certificate DSQL presents on the public endpoint does not cover the VPC-endpoint
hostname, so the isolated form has to be resolved and recorded rather than assumed.

**Creating:** asks nothing. DSQL is serverless with no capacity or version to choose,
which is what makes offering `create` here defensible — unlike RDS or DocumentDB,
provisioning takes about 30 seconds, not tens of minutes. A created cluster is
retained on stack deletion and deletion-protected, same asymmetry as a created
database.

**Record the database role and the endpoint variable.** `dbUser` names the role the
application logs in as (`admin` by default, or a least-privilege role) and decides
which action to grant. `endpointEnvVar` names the environment variable the container
reads the endpoint from — there is no `connection` block for this kind, because DSQL
has no secret to decompose into fields; the endpoint is either a literal already
known at plan time (adopted) or a deploy-time value published from SSM (created),
exactly like a created ElastiCache cluster's endpoint.

**One more thing worth flagging in the plan, not fixing in code:** the task role's IAM
grant authorises the *connection attempt*, but DSQL still needs a database role
linked to that IAM principal from inside the cluster — `CREATE ROLE <dbUser> WITH
LOGIN; AWS IAM GRANT <dbUser> TO '<task-role-arn>';`. This is manual work the user
does after the platform stack deploys, because the task role's ARN does not exist
until then. See
[resource-catalog.md](../planning/resource-catalog.md#dsql-cluster) for the full
statement and the idempotency note.

## Recording

Every datastore records a **`planId`** naming its entry in `plan.resources`, and a
**`nameFound`** flag. Both exist for planning rather than for analysis:

- `planId` is the link to the create-or-adopt decision. The network-reached kinds map
  onto fixed ids (`database`, `cache`), and DSQL onto `dsql-cluster` for the same
  reason, but an API-reached entry's id names its role — `receipts-bucket`,
  `sessions-table` — and two buckets are indistinguishable without it. An adopted
  entry could once be matched by its identifiers; a created one has none.
- `nameFound` says whether a name exists to look up in the account. `true` means
  planning runs one targeted lookup; `false` means there is nothing to look up, so
  planning asks instead of enumerating the account. **These are different branches**,
  so record which one applies rather than leaving it inferred from an absent field.

A network-reached datastore:

```yaml
datastores:
  - kind: rds
    engine: postgres
    planId: database
    nameFound: false        # nothing but DATABASE_URL — no instance name to look up
    confidence: high
    evidence:
      - file: app/db.py
        line: 6
        excerpt: 'create_async_engine(os.environ["DATABASE_URL"])'
      - file: alembic.ini
        excerpt: 'alembic migration config present'
    iamActions: []
    connection:
      style:
        value: url          # a generated secret cannot serve this — see above
        confidence: high
        evidence:
          - file: app/db.py
            line: 6
      variables:
        - name: DATABASE_URL
```

An API-reached datastore that could be created:

```yaml
  - kind: dynamodb
    planId: sessions-table
    nameFound: true
    confidence: high
    evidence:
      - file: app/sessions.py
        line: 11
        excerpt: 'GetItem/PutItem on SESSIONS_TABLE'
    iamActions:
      - dynamodb:GetItem
      - dynamodb:PutItem
    schema:               # required before `create` — the key schema is immutable
      partitionKey:
        value: { name: sessionId, type: string }
        confidence: high
        evidence:
          - file: app/sessions.py
            line: 14
            excerpt: 'Key: { sessionId: { S: sessionId } }'
    attributeVariables:
      - name: SESSIONS_TABLE
        attribute: tableName
```

An IAM-authenticated datastore:

```yaml
  - kind: dsql
    planId: dsql-cluster
    nameFound: true
    confidence: high
    evidence:
      - file: app/db.py
        line: 4
        excerpt: "new DsqlSigner({ hostname: process.env.DSQL_CLUSTER_ENDPOINT, region: 'us-east-1' })"
      - file: app/db.py
        line: 9
        excerpt: 'const client = new pg.Client({ host: process.env.DSQL_CLUSTER_ENDPOINT, ... })'
    iamActions:
      - dsql:DbConnect
    dbUser: app_user
    endpointEnvVar: DSQL_CLUSTER_ENDPOINT
```

The `schema`, `connection` and `attributeVariables` fields carry evidence and a
confidence level like every other finding, and record **names and fields only**. There is
no property anywhere in them that could hold a credential value. `dbUser` and
`endpointEnvVar` carry the same guarantee for `dsql` — a role name and a variable
name, never a value.

## Presenting

List every detected datastore for explicit confirmation, and always offer **"I use
one that isn't listed."** A missed datastore is the failure this analysis is most
prone to, and one that costs nothing to ask about.

When nothing is found, record that the workload appears stateless and ask the user to
confirm. Silence is not the same as confirmation — an app whose data access is behind
an internal API the analysis didn't recognize looks exactly like a stateless app.

**Never grant wildcard permissions** to cover uncertainty. `dynamodb:*` on `*` makes
the uncertainty permanent and invisible. If the tables cannot be determined, say so
and ask — the plan is the right place to resolve it.

**Do not steer the user toward adopting.** Both actions are real now, and a datastore the
account does not have is a normal answer rather than a blocked run. Present what the
account lookup found, say what creating would build and what it would cost — retained on
delete, tens of minutes on the first deploy for a database — and let the user choose.
Kind `other` is the one exception: the skill cannot create a resource it could not
identify, so that entry is adopt-only and should say why.
