# Ecosystem signals

Per-language signals for the inbound surface, datastores, and configuration. These
checklists exist to make coverage *systematic* rather than whatever happened to catch
the eye — work the relevant section top to bottom rather than grepping ad hoc.

Identify the ecosystem from the base image and the dependency manifest, then read
only that section. A Go service does not need the Rails checklist.

Every signal here produces a [finding record](./findings.md), and the corroboration
rule applies: two *independent* signals make `high`.

---

## Node.js

**Manifest:** `package.json`. **Lockfiles:** `package-lock.json`, `pnpm-lock.yaml`,
`yarn.lock`.

### Listener

| Framework | Signal |
| --- | --- |
| Express | `app.listen(PORT)` |
| Fastify | `fastify.listen({ port })` |
| Koa | `app.listen(PORT)` |
| NestJS | `app.listen(PORT)` in `main.ts` |
| Hono | `serve({ fetch: app.fetch, port })` |
| Next.js | No explicit listen — defaults to 3000, configurable by `PORT` |
| raw `http` | `server.listen(PORT)` |

`PORT` is very often `process.env.PORT || <default>`. The default is the finding; the
env var means the port is overridable at runtime, which is worth noting because the
task definition can set it.

### Routes and health checks

`app.get('/health')`, `router.get(...)`, NestJS `@Get('health')` decorators,
Next.js files under `pages/api/` or `app/api/`. Conventional health paths: `/health`,
`/healthz`, `/_health`, `/ping`, `/status`, `/livez`, `/readyz`.

Tests corroborate: a test asserting `expect(res.status).toBe(200)` against a path
turns a `medium` health-check finding into `high`.

### Datastores

| Dependency | Datastore |
| --- | --- |
| `pg`, `postgres`, `mysql2`, `mariadb` | RDS (relational) |
| `prisma`, `typeorm`, `sequelize`, `knex`, `drizzle-orm` | RDS — check the config for the dialect |
| `mongoose`, `mongodb` | DocumentDB or self-hosted Mongo — **ask**, these are not interchangeable |
| `redis`, `ioredis` | ElastiCache |
| `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb` | DynamoDB |
| `@aws-sdk/client-s3` | S3 |

Prisma's `schema.prisma` names the provider explicitly and is the most reliable
relational signal in this ecosystem. Also check for `migrations/`, `prisma/migrations/`.

### AWS SDK

`@aws-sdk/client-*` (v3) or `aws-sdk` (v2). The v3 package name *is* the service,
which makes the outbound AWS surface easy to enumerate precisely — take the client
list straight from `package.json` dependencies.

### Config

`process.env.X` throughout. `dotenv` usage means `.env` files — read `.env.example`
for variable *names*, never `.env` for values.

---

## Python

**Manifest:** `requirements.txt`, `pyproject.toml`, `Pipfile`, `setup.py`.

### Listener

| Framework | Signal |
| --- | --- |
| FastAPI | `uvicorn.run(app, port=...)`, or `CMD ["uvicorn", "main:app", "--port", "8000"]` |
| Flask | `app.run(port=...)`, or gunicorn in the `CMD` |
| Django | `manage.py runserver`, or gunicorn/uWSGI in the `CMD` |
| Starlette | `uvicorn.run(...)` |

In this ecosystem the port very often lives in the **`CMD`, not the source** — a
gunicorn or uvicorn `--bind 0.0.0.0:8000`. Read the Dockerfile `CMD` carefully before
concluding the port is undiscoverable.

`--bind 127.0.0.1:8000` is a real finding and a real problem: a container bound to
loopback is unreachable from the load balancer. Flag it.

### Routes and health checks

`@app.get("/health")` (FastAPI), `@app.route("/health")` (Flask), `urlpatterns` in
Django `urls.py`. Tests: `assert response.status_code == 200` in `tests/`.

### Datastores

| Dependency | Datastore |
| --- | --- |
| `psycopg2`, `psycopg`, `asyncpg` | RDS PostgreSQL |
| `pymysql`, `mysqlclient` | RDS MySQL |
| `sqlalchemy`, `alembic` | RDS — the URL names the dialect |
| `django` | RDS — see `DATABASES` in `settings.py` |
| `redis`, `aioredis` | ElastiCache |
| `boto3`, `aioboto3` | AWS services — see below |
| `pymongo` | DocumentDB or self-hosted — **ask** |

`alembic.ini`, `migrations/`, and Django's `*/migrations/` directories are strong
relational signals even when the driver is an indirect dependency.

### AWS SDK

`boto3.client("s3")` / `boto3.resource("dynamodb")`. Unlike the JS v3 SDK, the
service name is a **string argument**, so it must be read from call sites rather than
from the dependency list. Search for `boto3.client(` and `boto3.resource(` and
collect every literal. A non-literal service name means the set cannot be determined
statically — ask.

`boto3.client("dsql")` is a distinct signal worth naming on its own: it is Aurora
DSQL's IAM auth-token generator, not a network call — see
[datastores.md](./datastores.md#aurora-dsql). It shows up alongside a PostgreSQL
driver (`psycopg`, `psycopg2`, `asyncpg`) and a call to
`generate_db_connect_auth_token` or `generate_db_connect_admin_auth_token`. Because
"collect every `boto3.client(` literal" already surfaces `dsql` as a used service,
it is easy to over-read that as "this app needs the `dsql` VPC endpoint" — it does
not; connecting needs the *data-plane* endpoint, not the client the token generator
happens to construct. See
[egress.md](./egress.md#aws-services-to-vpc-endpoints) for the distinction.

### Config

`os.environ["X"]`, `os.getenv("X")`, `pydantic_settings.BaseSettings` subclasses
(where field names map to env vars), Django `settings.py`.

---

## Go

**Manifest:** `go.mod`.

### Listener

| Framework | Signal |
| --- | --- |
| stdlib | `http.ListenAndServe(":8080", ...)` |
| Gin | `r.Run(":8080")` |
| Echo | `e.Start(":8080")` |
| Chi | `http.ListenAndServe` with a chi router |
| Fiber | `app.Listen(":8080")` |

The port is a string literal like `":8080"`, often from a `PORT` env var with a
default.

### Routes and health checks

`http.HandleFunc("/health", ...)`, `r.GET("/health", ...)`, `e.GET(...)`. Tests use
`httptest` and assert on `rec.Code`.

### Datastores

| Import | Datastore |
| --- | --- |
| `github.com/lib/pq`, `github.com/jackc/pgx` | RDS PostgreSQL |
| `github.com/go-sql-driver/mysql` | RDS MySQL |
| `gorm.io/gorm`, `github.com/jmoiron/sqlx` | RDS — the driver import names the engine |
| `github.com/redis/go-redis` | ElastiCache |
| `github.com/aws/aws-sdk-go-v2/service/*` | The final path segment is the service |

Go's AWS SDK v2 import paths name the service, so the AWS surface is enumerable from
imports alone — the most precise of any ecosystem here.

### Config

`os.Getenv("X")`, and struct-tag config libraries (`envconfig`, `viper`). With
`envconfig`, the env var names come from struct field names and tags, not from string
literals — read the struct.

---

## Java

**Manifest:** `pom.xml`, `build.gradle`, `build.gradle.kts`.

### Listener

Spring Boot defaults to **8080** and is configured by `server.port` in
`application.properties` or `application.yml`, not in code. Read those files. Absent
any setting, 8080 is the framework default — record it as `medium`, since it is a
convention rather than a statement.

`server.servlet.context-path` prefixes every route, **including the health check
path**. Missing it produces a health check that 404s against a perfectly healthy app.

### Routes and health checks

`@RestController` with `@GetMapping("/health")`. Spring Boot Actuator, if
`spring-boot-starter-actuator` is a dependency, provides `/actuator/health` — a
reliable, purpose-built health endpoint. Prefer it when present, and remember the
context path.

### Datastores

| Dependency | Datastore |
| --- | --- |
| `spring-boot-starter-data-jpa`, `hibernate` | RDS |
| `postgresql`, `mysql-connector-java` | RDS — engine named by the driver |
| `spring-boot-starter-data-redis` | ElastiCache |
| `flyway`, `liquibase` | RDS — plus a migration step to think about |
| `software.amazon.awssdk:*` | The artifact ID is the service |

`spring.datasource.url` in `application.yml` names the engine and often the host.

### Config

`@Value("${x}")`, `@ConfigurationProperties`, and `application.yml` with
`${ENV_VAR:default}` placeholders. Spring maps `SPRING_DATASOURCE_URL` to
`spring.datasource.url` by relaxed binding, so an env var may not appear literally
anywhere in the repo — a genuine blind spot worth stating rather than guessing past.

---

## Ruby

**Manifest:** `Gemfile`.

### Listener

Puma (`config/puma.rb`, `port ENV.fetch("PORT") { 3000 }`), or the `CMD`
(`rails server -p 3000`, `puma -p 3000`). Rails conventionally uses **3000**.

### Routes and health checks

`config/routes.rb`. Rails 7.1+ ships `/up` as a built-in health endpoint — check for
`Rails.application.routes` including `rails_health_check`. Tests live in `spec/` or
`test/`.

### Datastores

| Gem | Datastore |
| --- | --- |
| `pg` | RDS PostgreSQL |
| `mysql2` | RDS MySQL |
| `redis`, `sidekiq` | ElastiCache — Sidekiq **requires** Redis |
| `aws-sdk-*` | The gem name is the service |

`config/database.yml` and `db/migrate/` are definitive relational signals.

Sidekiq deserves a note: it implies a **background worker process** in addition to
the web process. That is a second task definition, not something to fold into the web
service. Flag it rather than silently ignoring it — this skill deploys one service,
and a repo with Sidekiq needs a decision from the user.

---

## When the ecosystem isn't listed

Fall back to the general procedure and lower every confidence level by one, since the
signals are less certain:

1. The Dockerfile `CMD`/`ENTRYPOINT` names the server and often the port.
2. Grep for the recorded `EXPOSE` port as a literal across the source.
3. Grep for conventional health paths as string literals.
4. Read the dependency manifest for anything whose name contains a datastore
   (`sql`, `postgres`, `mysql`, `redis`, `mongo`, `dynamo`).
5. Grep for `amazonaws.com` and for `https://` literals.

Say plainly that the ecosystem is unrecognized. An honest "I could not determine this
reliably, please confirm" is worth more than a confident wrong answer.
