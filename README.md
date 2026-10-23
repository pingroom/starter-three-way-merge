# PingRoom three-way merge

Reconcile two concurrent edits to a small flat JSON record. Code compares
**base**, **ours**, and **theirs**, preserves independent edits, and asks one named
person only about fields changed differently on both sides. It emits a merged
proposal after every conflict has a valid resolution. Original inputs are never
overwritten or applied to another system.

## Try it offline

Requires Node.js 22 or newer on macOS or Linux and persistent private storage.
Choose **Use this template**, clone your repository, then:

```sh
npm ci
npm test
npm run demo
```

The demo merges reading-view preferences, including independent edits, an
addition, a deletion, and one conflicting theme choice. It uses the real SDK
through an in-memory HTTP transport, needs no credentials, makes no network
requests, and removes temporary state. Installation requires npm access.

## Prepare and connect

```sh
cp examples/merge.json merge.json
cp config.example.json config.json
cp .env.example .env
npm run plan
npm run connect
npm run inspect
```

Edit `merge.json` before starting. Give the merge a unique `mergeId`, a title,
and three complete flat snapshots. `base` must be their common ancestor; the
starter trusts that assertion and does not inspect Git history or your database.
The bundled example is harmless configuration data.

`plan` is offline and prints each field's automatic decision or conflict without
creating state or sending questions. Automatic rules are:

- If ours and theirs agree, use that value, including an agreed deletion.
- If only one side differs from base, keep that side's edit or deletion.
- Otherwise, ask **Use ours / Use theirs / Use base / Leave unresolved**.

A missing property represents deletion and differs from a present `null`, empty
string, `false`, or `0`. Questions display JSON-quoted strings and explicitly
label missing properties. Choosing a missing version deletes the property from
the proposed record. Choosing base restores the original value.

Install [PingRoom](https://pingroom.io/i), approve the pairing link, and select a
**standard private room** containing the resolver. They may be you or another
room member. The connection needs `pingroom:rooms:read`,
`pingroom:questions:ask`, and access to that room. Normal permissions and quotas
apply. Connecting sends no merge question.

`inspect` lists member UUIDs and lookup names. Verify the intended person in the
app and set their exact UUID and local label in `config.json`. Names and labels
are not identity proof. The resolver receives the three values for each conflicting field.

Pairing saves private `.pingroom/credentials.json`. Pending pairing reuses the
saved link, and an existing connection is never overwritten. If creation becomes
uncertain or the link expires, inspect Connected Agents and resolve or revoke the
old robot before deliberately archiving `.pingroom/pairing.json` for new setup.
Do not discard that intent merely to obtain another link.

For an existing connection or unattended run, set **both** `PINGROOM_TOKEN` and
`PINGROOM_ROOM` in `.env` or the process environment. A complete pair overrides
saved credentials; blank or partial pairs fail. Defining either shell variable
selects the entire shell pair; values are never mixed with `.env`.
All files resolve from the project directory, regardless of the working directory.

## Resolve and export

```sh
npm start          # Ask the next conflict, or read the active Question.
# Answer in PingRoom, then rerun:
npm start
npm run status     # Read local state; no network or credentials required.
npm run report     # Also write private .merge/report.json.
```

One invocation creates or reads at most one Question. A later invocation asks the
next conflict in field-ID order. At most one is active; each expires after
**15 minutes**. There is no installed scheduler or background wait. Serialize
invocations from your own workflow if you want periodic checks.

The report includes canonical SHA-256 hashes for the complete input, each
snapshot, and the proposed record; every field's automatic rule or human choice;
and Question, resolver, asking-registration, and observation provenance.
Whitespace and object-key order do not change these content hashes.

`proposal.record` exists only when all conflicts are resolved. While any remains,
`proposal` is `null`, with reasons in `unresolvedFields`. Leave unresolved is an
explicit response. Expired, cancelled, pending, invalid, and unasked outcomes are
separate and never become a default choice. Expired/cancelled/invalid or deliberately
unresolved fields are not asked again in the same merge. Other conflicts can
still be examined, but no complete proposal is emitted.

The exact request, room, target, asking registration, options, and Question
lifetime are verified. Answer timestamps must match resolution and fall within
the lifetime. Expiry may be observed at or after its deadline; implausible future
timestamps fail, with 60 seconds allowed for local clock skew. Completed evidence
is reused locally and does not claim current room access or delivery health.

`start` and `recover` exit with `0` for complete, `2` for an incomplete merge
or newly observed invalid/expired/cancelled outcome, `3` for ready/pending/interrupted,
`4` for uncertain creation, and `1` for errors. Local commands return `0` when
readable; inspect their JSON status rather than treating it as approval to apply.

## Interrupted creation

The journal saves and syncs the fixed request, target, TTL, correlation, and
idempotency key before the POST. Lost responses, malformed responses, interrupted
creation, or failed saves can leave `create_unknown`. Later invocations neither
repeat that POST nor ask another field until it is resolved.

```sh
npm run status
npm run find-id
npm run recover -- EXACT_QUESTION_UUID
```

`find-id` reads up to 200 recent Questions and prints matching candidates. No match
does not prove creation failed. Find the original ID in your originating robot's
history or saved response when needed. `recover` reads that exact ID and verifies
its complete request and provenance before attaching it. It sends no question.
Keep uncertain state while investigating; deleting it or using another checkout
can create a duplicate.

Inputs, resolver configuration, room, and credential are bound to the journal.
Changes are refused. To revisit an incomplete merge, first resolve
active or uncertain work, archive the entire private `.merge/` directory, and
start with a new merge ID. Keep the old evidence. There is no automatic migration.

## Adapt and check

`src/model.js` owns the merge rules; `src/merge.js` exports the durable `step`
function. The starter handles at most **12 distinct fields** across all three
snapshots, with at most 12 Questions. Fields and merge IDs start with a lowercase
letter and contain up to 40 lowercase letters, digits, `_`, or `-`. Prototype keys
are rejected. Values are null, booleans, safe integers, or strings of up to 40
printable ASCII characters. Empty strings are valid. Nested objects, arrays,
floating-point values, and control characters are unsupported. Titles allow
1–60 printable ASCII characters without outer spaces.

Independent field edits can still violate application rules spanning several
fields. Before applying a proposal elsewhere, validate its full schema and
cross-field rules, recheck the source revision/hash, and use that system's
concurrency control. This template performs no writes to source records,
deployments, commands, or external systems beyond asking the resolver.
Input text is data, never executable instructions; no AI service is required.

Input/configuration files are limited to 16 KiB each; state and reports to 1 MiB;
HTTP bodies to 512 KiB. Atomic writes use file sync, rename, and directory sync.
A lock excludes concurrent commands. After a crash, inspect `.merge/.lock/owner.json`
or `.pingroom/.lock/owner.json`, confirm the owning process stopped, then remove
only its stale lock. Restore corrupt state from a valid backup. Local persistence
does not provide distributed exactly-once delivery or permanent server idempotency.

Credentials, inputs, state, and reports are ignored by Git. Files use `0600` and
directories `0700` on POSIX; keep backups private. Requests use the official API
origin, reject redirects, and have a five-second deadline through body consumption.
The [official SDK](https://github.com/pingroom/sdk) is pinned to **0.6.0** with a
lockfile and 14-day minimum release age. CI checks Node 22 and 24 with offline
tests and the demo. Live phone delivery is not tested.

Unlike [data completion](https://github.com/pingroom/starter-data-completion), this
workflow reconciles concurrent versions against an explicit base and preserves
independent edits; it does not fill a missing business field.

MIT licensed; see [LICENSE](LICENSE).
