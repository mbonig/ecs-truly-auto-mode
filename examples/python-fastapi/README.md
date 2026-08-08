# Fixture: python-fastapi

Exercises **adopted RDS + secrets + an API-reached datastore**. Port lives in the
`CMD`, not the source. `alembic.ini` corroborates the relational datastore.

Expected analysis: port 8000 `high`, health `/healthz` `high`, egress `none`
(boto3 S3 only), RDS + S3 datastores, `DATABASE_URL` classified as a secret.
Expected plan: `database` adopt-only, S3 task-role permissions, no NAT gateway.
