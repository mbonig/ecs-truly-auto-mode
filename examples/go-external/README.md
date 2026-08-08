# Fixture: go-external

Exercises the **NAT-required** path. A single call to `api.exchangerate.host`
is the only thing forcing public egress.

Expected analysis: port 8080 `high`, health `/health` `high`, egress `public`
with `main.go` named as the cause, architecture X86_64 `high` (GOARCH=amd64 in
the build overrides the generic alpine base).
Expected plan: NAT gateway created, with that one call cited as the reason.
