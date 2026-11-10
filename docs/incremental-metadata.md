# Incremental metadata

Incremental metadata is an opt-in mode for selected repositories. Instead of regenerating a
repository's whole metadata document after every change, Repo Radar updates the previous document
from the commit it was built from. It summarizes each page of the Git diff in a short model call of
its own, merges those notes when there are too many to hand over together, and then one short
conversation edits only the sections the change affects. Diff size selects the amount of work, not a
different strategy. A full rebuild still happens weekly, or when the model or policy changes.

It is off for every repository unless you list it. Every repository, listed or not, goes through the
same worker and the same full-build adapter: one that isn't listed is full-only, rebuilt in full when
its tracked source changes and never updated from a diff (see "Repositories that aren't opted in").

## Turning it on and off

Add exact `owner/repository` names to `~/.config/repo-radar/config.json`:

```json
"incremental_metadata_repos": ["ReperioHealth/reperio-telehealth"]
```

The names must match the `full_name` of a configured repository. There are no wildcards. Settings
keeps the field when it saves the config. A malformed list stops a metadata-enabled sync with an
error before any work.

To turn it off, remove the name, or the whole field, and the repository is full-only from its next
metadata-enabled sync. To force a full rebuild of any repository, run
`repo-radar sync --regenerate-metadata`.

`"incremental_full_rebuild_days"` sets how old a full build can get before the next one: a whole
number of days, 7 by default, with 0 turning the age trigger off. There's no Settings control for it.

## What happens on each sync

Every metadata-enabled sync evaluates each repository, even when its HEAD didn't move, because a
weekly rebuild or an unfinished rebuild can be due. `--skip-metadata` and `--repos-only` skip metadata
for every repository. `--dry-run` reports the decision without any token counts, model calls or file
writes.

The decision, in order:

1. **Full rebuild** when it's forced; when there's no usable document (missing, degraded, or for
   another repository); when the analyzed commit is missing or isn't an ancestor of the new HEAD;
   when the configured model or the metadata policy changed; when the last full-build time is
   unknown; or when a previous full rebuild that's still owed didn't finish.
2. **Full rebuild** when `incremental_full_rebuild_days` have passed since the last successful full
   rebuild, even on an unchanged HEAD. A failed rebuild and an incremental update don't reset this clock.
3. **Nothing to do** when the tracked tree is identical.
4. **Incremental update** otherwise, however large the change.

How much of the source changed is recorded as a diagnostic only. A full rebuild that older versions
chose because a change was large, and that never finished, isn't owed any more: its failure stays on
record and the update takes the incremental path. A requested rebuild that didn't finish is still due.
A weekly rebuild that didn't finish is owed only while the age rule is due under the current
`incremental_full_rebuild_days`, counted from the last successful full build. After the interval is
raised it waits for the new date, and 0 drops it. Its failure and the failure count stay on record.

### Repositories that aren't opted in

A repository that isn't in `incremental_metadata_repos` uses the same decision with two differences: there
is no age-triggered rebuild (it gains no weekly schedule), and a changed tracked tree means a full rebuild,
with no diff listed. An unchanged tree does nothing, even when only the commit moved, and a healthy document
from the retired generator is adopted at the same tree without a rebuild. It gets the same failure hold,
reporting, `INDEX.md` staleness and `<repo>.md` alias as an opted-in repository. Its rebuild analyzes the
pinned commit, so uncommitted or untracked files never reach a document labelled with that commit, and it
uses the shared collector, credential exclusions and full adapter below. It is admitted for its own
estimate rather than the whole $40 (see the full rebuild below).

An existing document written by the retired full generator is adopted once without a paid rebuild. Its
`last_updated` becomes its full-build time, and its model is recorded as unknown. A document also
records its `pipeline_version`; a new version doesn't force a rebuild.

## How an update runs

All reads come from Git objects of the two pinned commits, never the working tree. Git runs without
external diff or textconv helpers, without global or system config, and without credentials in its
environment. Credential files (`.env`, private keys, `.netrc` and similar), symlinks, submodules and binary
files are unavailable, and the update records them as omissions. The only name exceptions are the four
templates `.env.example`, `.env.sample`, `.env.template` and `.env.dist`, which stay readable. Other names
stay withheld even when they look public, such as `.env.local.example` or a `.pem` certificate: a name
can't show that a file holds no secret, and a PEM file can carry a private key. There are no shell, network, host-filesystem or write tools.

1. **Pages.** The filtered diff is spooled to an owner-only directory as pages of at most 63 KiB, up to
   256 MiB in all, and removed afterwards. Each page names its commits and its files, breaks at a file
   or hunk boundary when it can, and marks any continuation. Known lockfiles, generated or vendored
   files and any single diff over 2 MiB get an omission record instead of a body, on their own pages,
   which need no model call. They're listed as not analyzed, never described as analyzed source.
   Generated or vendored means an explicit list: a directory named `node_modules`, `.next`, `.nuxt`,
   `__pycache__`, `Pods`, `.gradle` or `.terraform` at any depth; a `vendor`, `dist` or `coverage` directory
   at a build root (the repository root, or a folder holding a build manifest such as `package.json`,
   `go.mod` or `pyproject.toml`); or a name ending in `.min.js`, `.min.css`, `.js.map`, `.css.map`, `.pb.go`
   or `_pb2.py`. A source folder named `coverage` deeper in the tree, such as `src/coverage/`, is analyzed.
2. **Notes.** Each diff page gets one model call of its own, at most four at a time: at most 2,048 output
   tokens and 60 seconds. It sees only that page, the commits and the section titles, and returns a
   validated note of at most 3 KiB.
3. **Merging.** If the notes total more than 96 KiB or leave the editor too little room, they're merged
   into notes of at most 12 KiB (4,096 output tokens, 90 seconds) on one fixed schedule: groups of 16 map
   notes, then groups of 5, for as many levels as it takes. A note on its own passes through without a
   call. Each merge request also names the status and paths of the file ids its notes cite. The app tracks
   which pages each note covers and requires every page to be covered exactly once; a model can't change
   that. A note or merged note may cite only the files its request listed. An exact path of one of those
   files becomes its id; any other citation is dropped and the change kept, possibly with no file. Each
   call's record and the attempt's usage count those repaired and dropped citations, and when one was
   dropped the editor and the published coverage note say file attribution is incomplete. Section ids
   are repaired the same way: a single id becomes a list, an id the request wasn't given (or a blank or
   non-string) is dropped, and a change whose sections were all dropped is kept with none, so one
   malformed change doesn't fail the update or lose what it says. Those repairs are counted too
   (`normalized_sections`, `dropped_sections`), and the editor and the coverage note say when any were dropped.
   Everything else about a note stays strict: its shape and its size, before and after the repairs, and a
   note left with nothing is refused.
4. **Editing.** One conversation gets the document's sections and hashes, its summary fields, the notes,
   the status and paths of the file ids they cite, and what wasn't analyzed: at most 4 turns, 6 `read_file`
   or `search` calls, 64 KiB of delivered tool results and 16,384 output tokens. Its first request is
   prepared to fit 65,536 tokens with room for a tool-calling reply; every editor request, including the
   later ones that replay earlier replies with their provider fields, may use up to 128,000 input tokens,
   or the model's input budget if that is smaller. Tools are offered only while a tool-calling reply and
   its results would still fit, and the delivered-results budget has room left, and never on the last turn. A result is cut to the room left in the counted request, with a notice saying so. Its
   answer is a set of section edits: replace, delete or insert, each naming the section's id and hash.
   Edits that don't match are rejected, untouched sections keep their exact bytes, and the app writes the
   commit IDs, timestamps and provenance itself. A reply that isn't JSON as a whole may still hold exactly
   one complete JSON object, in a code fence or among a few words, and that object is the answer, checked as usual;
   with none or several, the reply is refused. A final request with no tools defined (the one-note case)
   also asks Gemini for a JSON reply; a later final turn keeps the tool definitions its history needs and
   doesn't. When a reply is refused, the attempt's usage keeps `rejected_reply`: which call, the first
   4 KiB of its text after redaction, and, for a refused section edit, its shape (at most 1 KiB, no prose).

On Gemini, note and merge calls ask for low reasoning effort and a JSON reply. Other models keep their
usual options and output floors, which are priced in. A whole update has one 20-minute allowance, from
listing its changes through preparing its pages and counting its requests to draining its last call. A
full rebuild's listing of changes has its own 20 minutes; its generation time isn't limited. Running out
reports the update as skipped and keeps the document, and it never uses a partial list of changes.

Each generated document also records which paths and file contents (by Git blob ID) are withheld as
credentials, in its `credential_exclusions` header. This holds no credential bytes. Every
publication, full rebuilds included, carries the record forward and only adds to it. So a known
protected path or blob, and whatever Git detects as a rename or copy of one, edited or not, stays
withheld under an ordinary name after the commit that showed its origin is gone. Git's detection is by
similarity, so this isn't a scan for secret content: a copy rewritten until Git no longer sees it as a
copy isn't recognized. An edited copy made in the same update that first adds a credential file is not recognized either, just as a secret pasted into a new ordinary file is not scanned for. Every page, note and tool uses that one record. A generated document whose
record is missing or invalid, or an existing document that can't be read, is kept as it is. Its update
fails before anything is read, counted or sent, and `--regenerate-metadata` doesn't bypass this.
Restoring the record is a manual recovery step. A first build, or one from a full-generator document,
starts the record from the commits it can see.

## Spending

Before the first generation call, the whole update is quoted at worst case and uncached prices: the
counted request for every page, the merge schedule all the way down to one note, each at its full input
limit, and all four editing turns. A quote over the update limit, an unknown price or a request that can't
fit stops the update before anything is sent. The limit is **$12** by default (`INCREMENTAL_CAP_USD`); Settings
can set it from $1 to $100 (`incremental_update_limit_usd`), and a missing or invalid value means $12. A larger diff never turns into an
uncapped full rebuild. Gemini is priced at its Standard tier, which is what a request naming no tier gets.
Other providers keep their priority and flex rates in the bound, because such a request can run on the
project's configured tier.

The quote is only a check. Every request is still counted in full before it's sent: instructions, tool
definitions and tool results. For Claude the count comes from Anthropic's Count Tokens API, from the
same request shape that is sent. If that count isn't available, nothing is sent on a local estimate:
before any request has gone out the update is skipped, and after a paid call it fails, so the failure
streak and its hold still apply.

The requests of a wave are reserved together at their input plus maximum output, so they can't each
pass against the same remaining budget. A reply settles its reservation with its reported or computed
cost. If the cost isn't known, the whole reservation stays counted and no further request goes out. An
update uses one set of prices throughout, including Google's announced January 2027 price for Gemini
3.8 Flash. Attempt usage records the quote, the prices, the pages and the calls per stage. There are no
automatic retries, including after a 429 or 503, and no model fallbacks.

A full rebuild runs on the same request executor. Every request, whether the whole repository,
a chunk or a reduction, is counted complete and must fit 128,000 input tokens (or the model's own limit, if
lower). The whole repository goes as one request only when it fits; otherwise the source is split into
chunks, a file too large for one chunk is split into ordered parts, and the chunk analyses are reduced
until one remains. Every selected file reaches a chunk and every chunk reaches the final reduction: when
something can't fit, or the four-level and 32-call reduction limits run out, the rebuild stops and the
document stays, rather than send excerpts. A full rebuild is capped at **$40** per attempt
(`FULL_CAP_USD`). There's no up-front quote: each request reserves its worst case before it's sent, and
when its count is only a local estimate, as on Gemini, that worst case is the model's whole input limit.
A request that could pass the cap stops the rebuild; once anything has been spent, that counts as a failed
update. The cap bounds what one attempt can spend; it doesn't promise a repository can be rebuilt for that much.

Before anything is sent, the rebuild's first stage is prepared: the whole-repository request or every
chunk, counted and fitted. That costs nothing but counting, comes before the weekly admission, and is
exactly what's then sent. An opted-in repository's rebuild is admitted for $40. A full-only rebuild is
admitted for its own estimate: the prepared requests' counted input and maximum output and, for chunks, a
reduction at the adapter's input ceiling and output limit for at most one call fewer than the chunks (and
no more than 32), at uncached list prices with a 25% margin. The requests go one at a time, each
reservation on top of what the earlier ones cost, so that is floored at the whole sequence's worst case:
every request's estimate except the largest-reserving one's, with the same margin, plus that request's
whole reservation. A local count reserves the model's whole input limit, and a small repository's estimate
can be cents. The allowance is at most $40 (also $40 when the estimate can't be computed, which
never authorizes a send without a price). The admitted amount is the attempt's hard limit and is recorded
in attempt usage as `admitted_usd`; a later request that can't fit stops the attempt, with no top-up,
retry or switch to a diff.

A send the provider clearly refused without charging, a rate limit (429) or a service unavailable or
overloaded reply (503, 529), gives its reservation back. Any other send whose cost is unknown keeps its
whole reservation: a timeout, a dropped connection, or a 500, 502 or 504, since a gateway can fail after the
model ran. A refusal that carries a charge is no refund: the charge is recorded and the request keeps at
least its reservation. Nothing is retried, and the SDK's own retries are off.

### The weekly spending limit

Every generation attempt in a normal sync, incremental or full, is admitted against a
weekly limit before its first send: **$75** by default, on unless Settings turns it off (`weekly_spend_cap_enabled`,
`weekly_spend_cap_usd`, $1 to $1,000). The record lives in `~/.config/repo-radar/spending/`, owner-only, and
is shared by stable and dev builds and every repository root. It holds attempt and send identifiers, the
channel, repository, model, times and amounts, never prompts, replies, credentials or settings.

- **What an attempt holds.** A diff update holds its whole quote, an opted-in full rebuild $40, and a
  full-only rebuild its estimate. That hold is also the attempt's hard limit: nothing is topped up once sending starts.
  An attempt is admitted only if the week's committed money (recorded charges, unknown-cost reservations and
  every running attempt's whole hold) plus its own hold fits the limit.
- **A refusal** is a skip before any send: the previous summary, the failure count, the last failure and any
  owed full rebuild stay, with no retry, fallback or other strategy. The reason says what the update needed
  and what remains until the week resets.
- **During and after an attempt.** Each send is recorded inside the hold before it goes out and its cost as
  soon as the reply arrives. When the attempt ends, however it ends, its known charges and unresolved
  reservations stay and the rest of its hold is released. A cost above its reservation is recorded in full
  and stops further sends. A reported cost is a known charge even when the reply's token counts are missing.
  If a cost can't be written at once it is kept and written by the next update to the record or the close, and
  that attempt sends nothing more.
- **Stop.** The Stop button during summary generation stops new updates and sends, closes this sync's open
  holds and ends the sync at once: the unused part of each hold is released, a reply that has already come
  back is recorded at its charge, and a request still in flight keeps its whole reservation, because the
  provider may still charge for it. An update stopped between two requests is skipped, not counted as a
  failure. A sync killed outright, a power
  loss or a record that can't be written leaves the whole hold counted. Nothing expires with time, and there
  is no reset button.
- **Weeks.** The first period runs from the first sync that uses the record to the next Monday 00:00 UTC, with
  nothing estimated for earlier spending; later ones run Monday to Monday UTC. A charge belongs to the week
  its attempt was admitted in, even if it finishes after Monday. Settings are read again at each admission, so
  lowering the limit affects new attempts only.
- **Turned off,** nothing is refused for the week, but every charge is still recorded and each attempt keeps
  its own limit.
- **A record that can't be trusted** (it existed and is now missing, damaged or not owner-only) is
  unavailable: nothing is admitted until it is fixed, and it is never recreated at $0.

Settings shows the week's recorded spend, what is reserved or uncertain and what is available, from the same
aggregation admission uses. Before the first sync it says tracking starts with the next sync; when the record
can't be read it says the spend is unavailable, never $0.

Combined enforcement needs both the stable and the dev app on a build that uses this record: an older build
neither checks nor records spending. The record doesn't estimate what older builds spent.

On Gemini, a full rebuild's chunk, synthesis and single-pass calls ask for low thinking, because
thinking and the visible answer share the output limit. Their limits stay 8,192 tokens for a chunk and 16,384
for synthesis or a single pass. Low thinking makes truncation less likely but doesn't rule it out: a truncated
reply is still rejected, nothing is retried, and the document stays. Attempt usage's `full_stage` records the
last call attempted: its stage, call number, chunk and total, output limit, finish reason, and the provider's
total and reasoning output counts when reported. The failure reason names the stage and call too.

## When an update fails

The previous document is never replaced by a failed attempt. A pending record is written before any
model work, and the new document replaces the old one atomically only after the update succeeded,
the document it started from is unchanged, and the repository is still at the same commit.

`INDEX.md` marks such a document stale and names the analyzed revision, the attempted revision and
the reason. A repository that has never had a document is listed as having metadata
unavailable. The sync's progress view and Activity report the update as failed (an error) or skipped
(a warning, for example an unavailable token count or price, a spending limit, or the spool limit). Such a
stop is a skip only while nothing has been paid for; once any call has been sent, it is a failure.
When any call fails, nothing further is started, the calls already launched finish and are accounted
for, and no partial set of notes is used. A failed incremental update is not followed by an automatic
full rebuild; the next ordinary sync tries again from the start, spending again, up to the hold below.
A document too large for the editor's request fails before anything is spent, and stays until a weekly or
requested rebuild replaces it. A full rebuild that fails stays owed for the reason it was first chosen, kept across retries;
an older record that shows only the generic retry reason owes nothing, and the current rules decide.

Attempt records live in `~/repos-pristine/.metadata-state/<cache>.json` (owner-only). Each one holds
the latest attempt and its usage, never prompts or source.

### Latest summary changes

Each publication, incremental or full, also writes `~/repos-pristine/.summary-changes/<cache>.md` (owner-only),
replacing the one before. It is a local line comparison of the summary text before and after: the one-line
summary, related repositories, Quick Reference and analysis, leaving out commits, timestamps and provenance. No
model is called and no source is read. It shows the analyzed commit range, the generation time and the added and
removed lines, at most 64 KiB, saying when the diff is cut. A first summary is labelled as one, and an update
that only moved the analyzed commit says "summary text unchanged". A failed, refused or no-op update leaves the
page as it was; a comparison that fails is recorded as unavailable and the publication stands. Its header names
the old and new document hashes and the generation ID, and `INDEX.md` links it beside View Details only while
its new hash is the current document's. The page is a second copy of summary text: if you scrub something from a
document by hand, delete or edit its page too.

### The hold after repeated failures

Any update that ends failed, incremental or full, adds one to `consecutive_failures` in its attempt record,
except a failure because the provider's API key isn't set: that is reported as failed but leaves the count
as it was.
A skipped update doesn't count, including one superseded by newer work or stopped by a resource or spending
limit before anything was paid for, and a publication resets the count to 0. A document replaced some other way starts again from none.

At 2 failures in a row by default (Settings can choose 1 to 10, `incremental_failure_stop`; a missing or
invalid value means 2), a sync started by anything but a person makes no model call for that repository, even
when a weekly rebuild is due, so a failing full rebuild can't repeat about $20 a day. That covers scheduled and
catch-up syncs, and `repo-radar sync` from a terminal, which isn't marked as manual. It reports the update as
skipped, a warning rather than an error: "held after 2 failed updates in a row; a manual sync or a forced
rebuild retries". The document, the stale mark and the last failure's details all stay, and Activity and `INDEX.md`
show the hold.

The menu's Sync Now tries once. From a terminal, the same retry is:

```sh
REPO_RADAR_TRIGGER=manual repo-radar sync
```

It marks the sync as started by a person, so it tries once with the usual choice of an incremental update
or a full rebuild. A bare `repo-radar sync` stays held, since unattended scripts run it too.
`repo-radar sync --regenerate-metadata` also tries, but always buys a full rebuild, so it isn't the cheap
retry. Every retry stays within the update or rebuild limit and the weekly spending limit. If it fails too,
the hold continues.

## Telehealth pilot

The pilot measures this engine against real telehealth history before live use. It runs from a checkout
with a Python environment built from this repository's dependency lock, never through the installed
sync, and installed documents and state are never updated. Matt runs the paid commands with his own key.

A replay manifest names the model and, for each case, immutable commits, where its baseline comes from
and its output directory. A case's baseline must have been built at exactly its `base` commit, so a later
document is never relabeled as a historical one. For example:

```json
{"schema": "repo-radar-pilot-replay/1", "model": "gemini/gemini-3.8-flash",
 "clone_url": "https://github.com/ReperioHealth/reperio-telehealth.git", "cases": [
  {"id": "oct27-baseline", "kind": "full_baseline", "target": "07c0fc386349ebe6a7e6662b01df248aecf994dc"},
  {"id": "oct27", "kind": "replay", "baseline_from": "oct27-baseline", "weekly_trigger": false,
   "base": "07c0fc386349ebe6a7e6662b01df248aecf994dc", "target": "da7c4b7209f29353d863f186cf3640c0060d5596"},
  {"id": "oct28", "kind": "replay", "baseline_from": "oct27", "weekly_trigger": false,
   "base": "da7c4b7209f29353d863f186cf3640c0060d5596", "target": "6d7f496e011a360a7d55fb1c091b60a7ba001980"},
  {"id": "nov3", "kind": "replay", "baseline_file": "/path/to/a/copy/of/full-scheduled.md", "weekly_trigger": false,
   "base": "4a5bec61bebc3a9a3b471993f0654fa755e6584d", "target": "d8f327b17f87b44a6380fc75a132660a4b1db9f6"}]}
```

`weekly_trigger: false` stops today's clock from replacing a historical case with an age-triggered full
rebuild; the other baseline and safety checks stay. Use a fresh, empty pilot directory:

```bash
# Free, needs no key: each case's pages, omissions and admission quote, in plan.json.
python3 -I scripts/pilot-incremental-metadata.py plan --manifest manifest.json --pilot-dir ~/pilot --repo-path ~/repos-pristine/reperio-telehealth-fab3ba4
# Paid: runs the cases in order and stops the chain at the first failure.
python3 -I scripts/pilot-incremental-metadata.py replay --manifest manifest.json --pilot-dir ~/pilot --repo-path ~/repos-pristine/reperio-telehealth-fab3ba4
```

Every request is charged to one ledger capped at **$40**: $24 for the scratch baseline and $16 for all
replays, with each replay also under the $12 update cap. The ledger survives restarts, can't have its
limits changed, and never buys the same request twice; a request's identity includes its case, stage,
commits, page or group, model and prompt version. Only one pilot command can use a directory at a time. A
ledger holding a request of unknown cost, or an entry it couldn't update, refuses further paid requests
until it's reconciled by hand. A completed case isn't bought again, and a case that stopped is never rerun
from the same directory. Each case needs its own output directory, and a completed result counts only if
its case, model, commits, baseline, prompt and pipeline versions and weekly setting all match and its
candidate is unchanged; anything else is refused, not rebuilt.

Each case's directory holds `candidate.md`, `notes.json` (every note accepted so far, saved after each
wave, the page and file inventory, and every call with its latency, tokens and cost) and `result.json` (commits and hashes, page coverage,
omissions, calls and latencies per stage, rates, estimated and actual cost, and which sections changed).
The spooled pages stay in `pages/` for inspection. Compare each candidate with the significant changed
APIs, schemas, configuration and removals in the diff, including effects across components; unchanged
sections must stay unchanged. Don't turn on live use until the results and any budget change are accepted.

The scratch baseline is also the real test of low thinking on a telehealth full build, which hasn't been shown
to finish yet. If it stops at the output limit anyway, its `result.json` has the `full_stage` details to size a
separate decision about the limit. The chain stops there: nothing is rebought and no limit is raised automatically.

The older single-case commands (`plan`, `incremental` and `full` with `--target` and `--model`) remain,
from a document copied into the pilot directory as `baseline.md`, with their own $40 ledger of $8 for the
incremental candidate and $24 for the full comparison.
