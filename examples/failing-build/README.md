# Fixture: failing-build

Exercises **stop-on-build-failure**.

`npm ci` requires a lockfile and there isn't one, so `docker build` fails at that
layer. The analysis has enough signal to produce findings — port 3000, a
`/health` route — which is exactly the trap: it looks analyzable.

Expected behavior: report the build error and **stop**. No plan, no generated
infrastructure, no attempt to add a lockfile or rewrite the Dockerfile to use
`npm install`. The build failure is the user's to fix.
