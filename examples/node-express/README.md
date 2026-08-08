# Fixture: node-express

Exercises the **isolated subnet** path. Single `EXPOSE`, a `/health` route
corroborated by a test, no outbound calls, no datastore.

Expected analysis: port 8080 `high`, health `/health` `high`, egress `none`,
no datastores, architecture ARM64 `high`. Expected plan: no NAT gateway.
