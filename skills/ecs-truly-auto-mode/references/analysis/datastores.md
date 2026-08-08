# Datastore analysis

Datastores split into two kinds, and the distinction drives everything downstream:

- **Network-reached** (RDS, ElastiCache, DocumentDB) — connected to over TCP with
  credentials. Needs a **security group rule** and a **secret**. IAM grants nothing.
- **API-reached** (DynamoDB, S3, SQS, SNS) — called through the AWS SDK. Needs
  **task role permissions** and, in isolated subnets, a **VPC endpoint**. No security
  group rule, no credentials.

Getting this backwards produces a confusing failure: an IAM policy for RDS that
grants nothing, or a security group rule for DynamoDB that does nothing, while the
actual missing piece goes unnoticed.

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

**Adoption:** the skill does not create databases. A database is a stateful resource
with a lifecycle far longer than a service, and creating one as a side effect of
deploying an app is the wrong default. Collect `dbInstanceIdentifier`,
`endpointAddress`, `port`, and `securityGroupId`, and wire connectivity to it. If the
user has no database yet, say that it needs to exist first and stop asking for it —
do not offer to create one.

### ElastiCache (Redis / Memcached)

**Signals:** a `redis` client dependency, `REDIS_URL`, `*.cache.amazonaws.com`.
Sidekiq, Celery, and BullMQ all require Redis.

**Implies:** a security group rule on 6379 (Redis) or 11211 (Memcached), a secret if
auth is enabled, and `iamActions: []`.

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

### S3

**Signals:** an S3 SDK client, a bucket name in config, presigned-URL generation.

**Implies:** `s3:GetObject` / `s3:PutObject` / `s3:DeleteObject` on
`arn:aws:s3:::<bucket>/*`, and `s3:ListBucket` on `arn:aws:s3:::<bucket>` — a
different resource ARN, which is a routine source of confusing access-denied errors.
Plus a **gateway** endpoint, which is required anyway for ECR image layers.

### SQS / SNS / EventBridge

**Signals:** the corresponding SDK clients.

**Implies:** `sqs:SendMessage` / `ReceiveMessage` / `DeleteMessage`,
`sns:Publish`, `events:PutEvents`, each scoped to the specific queue, topic, or bus.
Interface endpoints in isolated subnets.

An SQS **consumer** is another worker-process signal — a long-polling receive loop is
usually not the web process. Same treatment as Sidekiq: flag it and ask.

## Recording

```yaml
datastores:
  - kind: rds
    engine: postgres
    confidence: high
    evidence:
      - file: app/db.py
        line: 6
        excerpt: 'create_async_engine(os.environ["DATABASE_URL"])'
      - file: alembic.ini
        excerpt: 'alembic migration config present'
    iamActions: []
```

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
