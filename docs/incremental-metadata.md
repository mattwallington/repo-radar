# Incremental metadata

Incremental metadata is an opt-in mode for selected repositories. Instead of regenerating a
repository's whole metadata document after every change, Repo Radar updates the previous document
from the commit it was built from. It gives the model the git diff, the previous document and
read-only access to the surrounding source, and the model edits only the sections the change
affects. A full rebuild still happens weekly, after a large change, or when the model or policy
changes.

It is off for every repository unless you list it. Repositories that aren't listed keep today's
full-generation path unchanged.

## Turning it on and off

Add exact `owner/repository` names to `~/.config/repo-radar/config.json`:

```json
"incremental_metadata_repos": ["ReperioHealth/reperio-telehealth"]
```

The names must match the `full_name` of a configured repository. There are no wildcards. Settings
keeps the field when it saves the config. A malformed list stops a metadata-enabled sync with an
error before any work.

To turn it off, remove the name, or the whole field, and the repository goes back to the
full-generation path on its next metadata-enabled sync. The extra frontmatter fields that
incremental documents carry are ignored by everything else. To force a full rebuild of an opted-in
repository, run `repo-radar sync --regenerate-metadata`.

## What happens on each sync

Every metadata-enabled sync evaluates each opted-in repository, even when its HEAD didn't move,
because a weekly rebuild can be due. `--skip-metadata` and `--repos-only` do nothing for opted-in
repositories. `--dry-run` reports the decision without any token counts, model calls or file writes.

The decision, in order:

1. **Full rebuild** when it's forced; when there's no usable document (missing, degraded, or for
   another repository); when the analyzed commit is missing or isn't an ancestor of the new HEAD;
   when the configured model or the metadata policy changed; when the last full-build time is
   unknown; or when the previous full rebuild didn't finish.
2. **Full rebuild** when seven days have passed since the last successful full rebuild, even on an
   unchanged HEAD. A failed rebuild and an incremental update don't reset this clock.
3. **Full rebuild** when more than 20% of the eligible source changed. Eligible means what the full
   generator would read: its file rules and 100 KiB limit. The figure is the larger of the
   changed-file and changed-byte fractions. Additions, deletions, renames (both paths) and files
   crossing the size limit all count. Exactly 20% stays incremental.
4. **Nothing to do** when the tracked tree is identical.
5. **Incremental update** otherwise.

An existing document written by the full generator is adopted once without a paid rebuild. Its
`last_updated` becomes its full-build time, and its model is recorded as unknown.

## What the model can see and do

All reads come from Git objects of the two pinned commits, never the working tree. Git runs without
external diff or textconv helpers, without global or system config, and without credentials in its
environment. The model gets:

- the previous document's sections (each with an id and a hash) and its summary fields;
- every changed path with its status, and the textual diff, in pages of at most 64 KiB;
- four tools: `read_diff`, `list_paths`, `read_file` (either commit) and literal `search`.

Credential files (`.env`, private keys, `.netrc` and similar; `.env.example` stays readable),
symlinks, submodules and binary files are unavailable, and the update records them as omissions.
There are no shell, network, host-filesystem or write tools. The model must read every diff page
before it answers. Its answer is a set of section edits: replace, delete or insert, each naming the
section's id and hash. Edits that don't match are rejected, untouched sections keep their exact
bytes, and the app writes the commit IDs, timestamps and provenance itself.

Limits per attempt: 16 model turns, 64 tool calls, 20 minutes, 64 KiB per tool result. A fresh
conversation is used for each attempt; nothing is saved or resumed.

## Spending

Every request is counted in full before it's sent: instructions, the conversation so far, tool
definitions and tool results. For Claude the count comes from Anthropic's Count Tokens API, from the
same request shape that is sent. If that count isn't available, the update is skipped rather than
sent on a local estimate.

The request's input plus its maximum output is then priced at uncached rates and reserved. An
incremental update stops before any request that would take it past **$8**. A reply settles its
reservation with its reported or computed cost. If the cost isn't known, the whole reservation stays
counted. There are no automatic retries or model fallbacks. Full rebuilds follow the existing
full-generation cost policy.

## When an update fails

The previous document is never replaced by a failed attempt. A pending record is written before any
model work, and the new document replaces the old one atomically only after the update succeeded,
the document it started from is unchanged, and the repository is still at the same commit.

`INDEX.md` marks such a document stale and names the analyzed revision, the attempted revision and
the reason. An opted-in repository that has never had a document is listed as having metadata
unavailable. The sync's progress view and Activity report the update as failed (an error) or skipped
(a warning, for example an unavailable token count or price, or a spending limit). A failed
incremental update is not followed by an automatic full rebuild; the next ordinary sync tries again.

Attempt records live in `~/repos-pristine/.metadata-state/<cache>.json` (owner-only). Each one holds
the latest attempt and its usage, never prompts or source.

## Telehealth pilot

The pilot compares an incremental update with a clean full rebuild for
`ReperioHealth/reperio-telehealth` only. It runs from a checkout with a Python environment built from
this repository's dependency lock, never through the installed sync. Every request is charged to one
ledger capped at **$40**: $8 for the incremental candidate, $24 for the full comparison, and $8 held
back as contingency. The ledger survives restarts, can't have its limits changed, and never buys the
same request twice. Only one pilot command can use a pilot directory at a time; a second one exits
before touching anything. If a candidate can't fit its allowance, or a reply's cost is unknown, the
pilot stops; it doesn't change models or raise the cap, and a ledger holding a request of unknown cost
refuses further paid requests until it's reconciled by hand.

1. Make a pilot directory and copy the latest healthy full telehealth document into it as
   `baseline.md` (for example `~/repos-pristine/reperio-telehealth-fab3ba4.md`). Don't buy a new
   baseline.
2. Pick a later commit that is a descendant of the baseline's `last_commit`, changes 20% or less of
   the eligible source, and is within seven days of the baseline. Check it:

   ```bash
   python3 -I scripts/pilot-incremental-metadata.py plan --pilot-dir ~/pilot --repo-path ~/repos-pristine/reperio-telehealth-fab3ba4 --target <commit> --model claude-sonnet-5-5
   ```

   The first run fixes the baseline, target and model for both candidates.
3. With the provider key in the environment, build each candidate once:

   ```bash
   python3 -I scripts/pilot-incremental-metadata.py incremental --pilot-dir ~/pilot --repo-path ~/repos-pristine/reperio-telehealth-fab3ba4 --target <commit> --model claude-sonnet-5-5
   python3 -I scripts/pilot-incremental-metadata.py full --pilot-dir ~/pilot --repo-path ~/repos-pristine/reperio-telehealth-fab3ba4 --target <commit> --model claude-sonnet-5-5
   ```

   The outputs are `incremental.md` and `full.md`, with `results-*.json` holding usage, cost, calls,
   elapsed time and ledger totals. A candidate that was built but can't be accepted (for example an
   unsafe header) is kept as `rejected-<mode>.json` instead, and its cost still counts. The installed
   document is never touched.
4. Compare both documents against the actual diff and surrounding source. Look at removed or renamed
   interfaces, effects across components, schema and configuration changes, whether unrelated
   sections were preserved, unsupported claims, and useful detail. If the incremental result loses
   useful facts or doesn't save money, leave enrollment off and report that. Don't rerun to buy a
   better result.
