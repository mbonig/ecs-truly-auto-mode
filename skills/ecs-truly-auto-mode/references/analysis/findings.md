# Finding records

Every inference the analysis makes is recorded as a finding. This is the format that
makes the rest of the skill work: the plan is reviewable because findings carry
evidence, and re-runs are incremental because findings are comparable values.

## Shape

```yaml
value: 8080
confidence: high
evidence:
  - file: Dockerfile
    line: 12
    excerpt: "EXPOSE 8080"
  - file: src/server.ts
    line: 41
    excerpt: "app.listen(8080)"
```

- **`value`** — the inferred value. A scalar or a short list, never prose. This is
  what gets compared on a re-run, so `8080` is a finding and "the app seems to listen
  on 8080" is not.
- **`evidence`** — at least one entry. `file` is always present; `line` and `excerpt`
  are present when the signal is a line rather than the existence of a file. A
  `Gemfile` or a `migrations/` directory is legitimate evidence with no line number.
- **`confidence`** — see below.

## Confidence levels

| Level | When to use it | What the plan does |
| --- | --- | --- |
| `high` | Two or more corroborating signals, or one unambiguous one. | States it as a default. Does not ask. |
| `medium` | One plausible signal, nothing corroborating or contradicting. | **Asks**, with this value pre-filled as the suggestion. |
| `low` | Indirect or weak signal — a naming convention, a comment, a doc. | **Asks**, presented plainly as a guess. |
| `conflict` | Two signals disagree. | **Asks**, showing every competing value with its evidence. |

### The rule

**Anything not `high` becomes a question.** There is no silent fallback, no
"reasonable default" applied quietly. A wrong port produces a service that never
passes a health check; a missed external call produces a service that cannot reach
its dependencies. Both are cheap to prevent at plan time and expensive to debug at
deploy time.

The inverse matters just as much: **do not ask about `high`-confidence findings.**
A single `EXPOSE 8080` corroborated by a matching `listen(8080)` is not a question,
and treating it as one trains the user to click through the plan without reading it.
Questions are a scarce resource — spend them where the answer is genuinely unknown.

### Calibrating `high`

Two signals count as corroborating only if they are *independent*. A port in the
Dockerfile and the same port in a `docker-compose.yml` that was written from the
Dockerfile is one signal, not two. A port in the Dockerfile and the same port in a
`listen()` call in the source is two.

### Recording a conflict

When signals disagree, the primary `value` is the better-supported one, and every
competitor goes in `alternatives`:

```yaml
value: 8080
confidence: conflict
evidence:
  - file: Dockerfile
    line: 12
    excerpt: "EXPOSE 8080"
alternatives:
  - value: 3000
    evidence:
      - file: src/server.ts
        line: 41
        excerpt: "app.listen(process.env.PORT || 3000)"
```

Never resolve a conflict by preferring one source as a rule. The Dockerfile is not
automatically right — a stale `EXPOSE` against a live `listen()` is a common way for
these to disagree, and the user knows which is current.

## After the user answers

A finding the user confirms or corrects is rewritten with the answer as `value`,
`confidence: high`, and `confirmedByUser: true`. The evidence is kept — it explains
why the question was asked. The marker is what stops later runs from asking again.

```yaml
value: 3000
confidence: high
confirmedByUser: true
evidence:
  - file: src/server.ts
    line: 41
    excerpt: "app.listen(process.env.PORT || 3000)"
```

The manifest validator enforces this: an approved plan containing a finding that is
below `high` and not `confirmedByUser` is rejected, because it means a question was
skipped.

## On re-runs

Fresh analysis produces a new finding; compare its `value` to the recorded one.

- **Same value** — keep the manifest entry, including `confirmedByUser`. Do not ask.
- **Different value, manifest entry was `confirmedByUser`** — the user made a
  deliberate choice that the code now contradicts. Show both, with the new evidence,
  and ask which stands.
- **Different value, manifest entry was not confirmed** — the code changed under an
  inferred value. Show old and new, and ask.
- **No longer found at all** — do not silently drop it. A dependency that disappeared
  from the code may still be a resource the user is paying for.
