# Dockerfile analysis

Read the Dockerfile at `app.dockerfile` and record findings for the container port,
the architecture, and the build-context paths. Everything here produces
[finding records](./findings.md).

## Ports

`EXPOSE` is documentation, not configuration — it does not publish anything, and it
is frequently stale. Treat it as one signal among several.

**One `EXPOSE`, corroborated by a listener bind on the same port in the source** →
`confidence: high`. State it, don't ask.

**One `EXPOSE`, no corroborating listener found** → `confidence: medium`. Ask, with
the exposed port pre-filled.

**More than one `EXPOSE`** → ask which port receives traffic from the load balancer.
Record the chosen one as the container port. Common shapes: an app port plus a
metrics port (`9090`, `9100`), or an app port plus a debug port. Note that the others
exist in the plan — the user may want a second target group later, but that is not
something to build unprompted.

**No `EXPOSE`** → fall back, in order:

1. A listener bind in the source (`app.listen(...)`, `uvicorn.run(port=...)`,
   `http.ListenAndServe(":8080")`). See [ecosystems](./ecosystems.md).
2. A default in a port environment variable: `ENV PORT 8080`, or
   `process.env.PORT || 3000` in the source.
3. The base image's conventional port — `nginx` 80, `httpd` 80. This is `low`
   confidence at best.

Whatever the fallback produces, ask. A container port derived without an `EXPOSE` is
never `high` on its own.

**`EXPOSE` disagrees with the listener bind** → `confidence: conflict`. Record both
with their evidence and ask. Do not prefer the Dockerfile as a rule; a stale `EXPOSE`
against a live `listen()` is exactly how this disagreement usually arises.

`EXPOSE 8080/udp` is not an HTTP port. If the only exposed port is UDP, the workload
is not load-balancer-fronted in the way this skill assumes — say so and ask.

## Architecture

The Fargate runtime platform must match what the image was built for, and a mismatch
produces a task that fails to start with an exec-format error — an error whose cause
is not obvious from the message.

In order of authority:

1. **`--platform` on a `FROM`** — `FROM --platform=linux/arm64 node:22-alpine`.
   Explicit and unambiguous: `high`.
2. **An architecture-specific base image tag** — a tag containing `arm64v8`,
   `amd64`, `arm64`. `high`.
3. **A downloaded binary with an architecture in its URL or name** — a `curl` or
   `ADD` in a `RUN` fetching `..._linux_amd64.tar.gz`. This *pins* the image
   regardless of the base image, so it is strong evidence: `high`, and it overrides
   a generic base image.
4. **Nothing** — the image builds for the builder's architecture. Ask. Do not assume
   `X86_64`; developers on Apple Silicon routinely produce `arm64` images from
   Dockerfiles with no platform declared, and ARM64 Fargate is also cheaper.

Record as `ARM64` or `X86_64` to match the CDK enum.

## Build context paths

This is what the pipeline's path filter is derived from, and getting it wrong causes
a specific nasty failure: a filter that is too narrow means a code change does not
trigger a deploy, and the pipeline reports success by staying silent.

Collect:

- Every **`COPY`** and **`ADD`** source path, excluding `--from=<stage>` copies,
  which read from an earlier build stage rather than the context.
- The **Dockerfile itself**.
- **Dependency manifests and lockfiles** in the context — `package.json`,
  `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `requirements.txt`,
  `pyproject.toml`, `poetry.lock`, `go.mod`, `go.sum`, `Gemfile`, `Gemfile.lock`,
  `pom.xml`, `build.gradle`.

Then widen and normalize:

- `COPY . .` means the whole context. Record the context root, then subtract
  `.dockerignore` entries — an unfiltered `**` produces a filter that fires on every
  documentation edit, which trains people to ignore the pipeline.
- A directory source becomes a glob: `COPY src ./src` → `src/**`.
- Deduplicate and drop paths already covered by a broader glob.

When in doubt, **widen rather than narrow**. A pipeline that occasionally runs when
it didn't need to costs a few minutes of compute. A pipeline that doesn't run when it
should costs a production incident.

## Multi-stage builds

Analyze the **final stage** for the runtime facts — the port, the entrypoint, and the
base image the container actually runs. Earlier stages are build tooling and say
nothing about runtime.

But collect build-context paths from **every** stage. A builder stage that does
`COPY package.json .` still means a `package.json` change must rebuild the image.

The final stage is the last `FROM`, unless the build uses `--target`, which the skill
does not currently detect. If the Dockerfile has stages after what looks like the
runtime stage, say so rather than guessing.

## Entrypoint and command

Record `ENTRYPOINT` and `CMD` for the task definition. Two things to notice:

- **Shell form** (`CMD npm start`) wraps the process in `/bin/sh -c`, so the app runs
  as PID 2 and does not receive `SIGTERM` on task stop. That means ECS waits the full
  stop timeout on every deploy, making rollouts slow for no visible reason. Worth
  flagging as a note in the plan — it is a real problem, but not one to fix by
  editing someone's Dockerfile.
- **A shell-script entrypoint** (`ENTRYPOINT ["./entrypoint.sh"]`) can start
  migrations, fetch config, or exec something entirely different. Read it. It is a
  common place to find datastore and secret usage that appears nowhere in the
  application source.

## Build arguments

Record every `ARG` that has no default, since the build will need a value supplied
and the pipeline must pass it. An `ARG` used to inject a credential is a finding for
[secrets](./secrets.md), and is worth flagging separately: build args are visible in
image history, so a secret passed that way is already exposed.

## Build validation

Build the image before generating anything. It is the one check that turns "this
probably works" into a fact, and it costs one command.

```
docker build -f <dockerfile> -t ecs-auto-mode-validate:<app-name> <context>
```

Add `--platform` matching the recorded architecture, so the validation exercises the
architecture that will actually be deployed.

**On success**, set `analysis.buildValidated: true` and continue.

**On failure**, report the error and **stop**. Do not modify the Dockerfile, do not
retry with different flags, do not proceed to the plan. A build failure is the user's
to fix, and infrastructure generated for an image that does not exist is worthless.
The manifest validator enforces this: an approved plan with `buildValidated: false`
is rejected.

Two failure modes worth naming in the report, because their error messages are
misleading:

- **A private base image or registry** — the build needs credentials the environment
  does not have. This is an environment problem, not a Dockerfile problem.
- **A platform mismatch under emulation** — building `arm64` on `x86_64` without
  emulation available fails in ways that look like application errors.
