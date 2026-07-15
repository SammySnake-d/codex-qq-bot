# Group Summary Agent

Status: implemented on 2026-07-14. Live NapCat delivery was confirmed on
2026-07-15 with a real source group, local Codex generation, private-friend
delivery, persisted cursors, and QQ history verification.

## Outcome

Run a normal QQ account through NapCat/OneBot and periodically summarize new
group messages with a fresh Codex CLI or Claude Code process. Source groups and
the delivery destination are separate. The worker must persist its cursor,
survive restarts, avoid duplicate delivery, and send only validated,
deterministically rendered output.

## Acceptance Boundary

The first vertical slice is accepted when a local fake OneBot server proves the
complete observable chain:

1. Fetch group history from `get_group_msg_history`.
2. Normalize and de-duplicate messages into SQLite.
3. Select only messages after the last summarized cursor.
4. Apply the due-time, activity, speaker-count, and quiet-period policy.
5. Invoke a structured summary provider.
6. Validate and render the provider result.
7. Call the configured OneBot delivery action once: `send_private_msg` for a
   private recipient, or `send_group_msg` for legacy group delivery.
8. Persist the sent message id and advance the summary cursor.
9. Re-running the worker does not resend the same window.

Live QQ delivery is a separate readiness boundary. It requires a logged-in
NapCat account, the target group id, a working OneBot token, and authenticated
Codex CLI or Claude Code on the deployment host.

## Non-goals

- Replacing the existing interactive QQ assistant.
- Giving Codex or Claude direct OneBot credentials or send permissions.
- Executing instructions found inside chat messages.
- Summarizing images or untranscribed voice in the first slice.
- Adding a continuously running WebSocket ingestion service in the first slice.
- Changing existing QQ reply, memory, or proactive-response behavior.

## Product Body

The stable product body is a per-group summary state machine backed by SQLite.
Scheduling and provider choices are feature policy outside the state store.

```text
idle -> syncing -> not_due
                -> deferred
                -> generating -> ready -> sending -> sent
                              -> generation_failed
                                         -> delivery_unknown
                                         -> delivery_failed
```

Only `sent` advances `last_summarized_seq`. A delivery timeout is treated as
unknown and must be reconciled against recent messages from the bot account
before a retry is allowed.

## Module Contracts

| Module | Responsibility | Does not own |
| --- | --- | --- |
| `config.js` | Resolve and validate environment configuration | Runtime side effects |
| `onebot-client.js` | OneBot HTTP calls, response normalization, timeouts | Scheduling or persistence |
| `message-normalizer.js` | Convert OneBot messages into stable text records | Network or database IO |
| `sqlite-store.js` | Schema, transactions, cursors, run lifecycle | Provider or rendering policy |
| `schedule-policy.js` | Decide due, defer, or summarize | Time persistence or randomness source |
| `providers.js` | Fresh Codex/Claude structured-output invocation | OneBot credentials or sending |
| `summary-schema.js` | Validate provider output and render QQ text | Model invocation |
| `worker.js` | Orchestrate one group through the state machine | CLI parsing or daemon lifecycle |
| `cli.js` | Run one cron-safe worker pass with a process lock | Business policy |

Dependency direction:

```text
cli -> worker -> store / policy / provider slot / OneBot adapter
provider slot -> Codex provider or Claude provider -> external CLI
OneBot adapter -> NapCat HTTP API
```

The Codex adapter uses an isolated `CODEX_HOME`, disables plugins and bundled
skill instructions, and turns off shell, browser, computer-use, memory, and
multi-agent features. The model receives the transcript and output schema but
does not receive a general-purpose execution tool. Claude Code uses
`--safe-mode`, an empty tool allow-list, no slash commands, and no session
persistence.

Large eligible windows use rolling batches. Each provider invocation is a fresh
process with at most `QQ_SUMMARY_CHUNK_SIZE` messages and the configured prompt
character budget. The first batch receives only raw messages. Later batches
receive the previous validated cumulative summary plus the current raw-message
batch. Intermediate summaries are not sent; only the final cumulative summary
is rendered and delivered.

## Configuration Contract

The worker is disabled unless `QQ_SUMMARY_GROUP_IDS` is non-empty. Source group
ids are independent from the delivery destination. Private delivery requires
both `QQ_SUMMARY_DELIVERY_MODE=private` and an explicit
`QQ_SUMMARY_DELIVERY_USER_ID`; a missing private recipient fails closed.
Credentials and send authorization come only from environment variables or CLI
flags. Non-targeting schedule defaults are configurable and cannot cause a send
until a source group is selected and sending is explicitly enabled.

The cron process performs a short heartbeat. Randomness is persisted as
`next_due_at`; the cron entry itself remains deterministic.

## Rollback

Removing the cron entry disables the feature without changing the existing bot.
The worker uses its own SQLite file and source directory. Existing QQ state and
memory files are not migrated or modified.

## Validation

- Pure unit tests for message normalization, policy decisions, rendering, and
  provider command construction.
- Store tests against a temporary SQLite database.
- Fake-OneBot integration test covering fetch, summarize, send, cursor advance,
  restart, and duplicate suppression.
- `npm run verify` remains the merge gate.

## Research Basis

- [NapCat `get_group_msg_history` implementation](https://github.com/NapNeko/NapCatQQ/blob/738e272d2c46bff6882751b26a742f891d95152b/packages/napcat-onebot/action/go-cqhttp/GetGroupMsgHistory.ts)
  confirms the canonical string ids, `message_seq`, `count`, and
  `reverse_order` request shape used by the adapter.
- [AstrBot chat summary v2](https://github.com/sinkinrin/astrbot_plugin_chatsummary_v2)
  demonstrates the alternative event-cache architecture. This worker keeps the
  requested cron-only deployment and compensates with bounded history backfill,
  SQLite cursors, and duplicate suppression.
- [OpenAI Codex configuration schema](https://github.com/openai/codex/blob/effd58d7505382f6b2d1736a4fc9e3eb90df1966/codex-rs/core/config.schema.json)
  provides the `skills.bundled.enabled` and `skills.include_instructions`
  controls used by the isolated runtime.
