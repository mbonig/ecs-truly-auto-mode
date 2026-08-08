# Incremental re-planning

A repository with a manifest has been through this before. The second run must not
feel like the first — re-asking settled questions is the fastest way to make someone
stop reading the answers.

The principle: **re-analyze fully, but ask narrowly.** Analysis is cheap and catches
real drift. Questions are expensive and should be spent only where the answer
actually changed.

## Procedure

1. Read the manifest. If `schemaVersion` is unrecognized, **stop** — never
   reinterpret a document whose meaning may have changed.
2. Run the full analysis fresh, as if the manifest did not exist.
3. Diff fresh findings against recorded ones, by `value`.
4. Derive what the fresh analysis implies for the plan, and diff that too.
5. Present only the differences.
6. Regenerate only what the changed manifest fields control.

## Diffing findings

For each finding, compare `value` — not evidence. Evidence shifts constantly as line
numbers move, and treating that as a change would make every commit look like drift.

| Fresh vs. recorded | Recorded state | Action |
| --- | --- | --- |
| Same | any | Keep, including `confirmedByUser`. Silent. |
| Different | `confirmedByUser: true` | **Ask.** The user chose deliberately and the code now disagrees. |
| Different | inferred only | **Ask**, showing old and new. |
| Gone | any | **Ask** before removing. |
| New | — | **Ask**, as a new finding. |

When evidence changes but the value doesn't, update the evidence silently. Keeping
stale line numbers makes the manifest actively misleading.

### The confirmed-but-contradicted case

This is the one worth handling carefully. The user previously told the skill the port
was 3000, overriding a Dockerfile that said 8080. Now the source says 4000.

Show all three facts — what they chose, what the code said then, what it says now:

```
Container port changed.

  You confirmed:  3000
  Now found:      4000   src/server.ts:41  app.listen(4000)

  The Dockerfile still says EXPOSE 8080.

  Keep 3000, or use 4000?
```

Do not silently keep the confirmed value, and do not silently take the new one. The
first ignores the code; the second discards a decision the user made on purpose.

### Findings that disappear

A datastore that vanished from the code is not automatically a datastore to drop from
the plan. The dependency may have moved behind an internal API, or the analysis may
simply have missed it this time — non-determinism is a real property of this analysis
and the reason findings are recorded at all.

Ask. Removing a datastore silently drops a security group rule and IAM permissions,
and the resulting failure looks nothing like its cause.

## Diffing the plan

Fresh analysis can imply new plan entries or change derived actions.

**New resource needed** — a newly detected datastore adds an entry, which needs a
create-or-adopt decision before generation. Present it with the finding that caused
it.

**Egress classification flipped** — the highest-consequence change, in both
directions:

```
Network egress changed: NONE → PUBLIC

  app/notify.py:22  requests.post("https://hooks.slack.com/...")

  This is new since the last run. A NAT gateway will be added (~$32/month),
  and the service moves from isolated to private subnets.
```

The reverse — `public` → `none`, when the last external call is removed — is worth
surfacing just as clearly. Nobody will notice they could stop paying for a NAT
gateway unless told.

Never flip this silently. It changes both cost and reachability.

**Resource no longer needed** — mark `skip` rather than deleting the entry, and keep
the reason. The entry is a record of a decision, and the underlying resource may
still exist and still be billing.

## Adopted resources

Do not re-validate identifiers that are unchanged and already `validated: true`.
Re-validate when the identifier changed, when validation previously failed or was
skipped, or when the user asks.

If credentials are available and a previously-validated resource has since been
deleted, that is worth catching — but it is a `--refresh`-style explicit action, not
something to do on every run.

## Presenting no change

The common case, and it should be brief:

```
Re-analyzed orders-api. No changes — plan matches the manifest.
Generated files are current.
```

Then stop. Do not re-present the plan, do not re-ask for approval, do not regenerate
files whose inputs are identical.

## Regenerating

Only regenerate files whose controlling manifest section changed — that is what the
`section` field in `generated` records is for.

- `plan.resources` changed → platform stack
- `analysis.container`, `analysis.config` → service stack
- `pipeline` → pipeline definition
- `analysis.egress` → both stacks

Before writing any file, run the overwrite check: hash the file on disk and compare
against the recorded `sha256`. A mismatch means the user edited it, and the skill
shows the difference and asks rather than writing.

## Re-approval

A changed plan needs re-approval. Set `plan.approved` to `false` as soon as any
difference is found, and ask again after presenting the diff.

Approval covers a specific plan, not the project in general. Carrying a stale
approval forward would let a NAT gateway appear without anyone agreeing to it.
