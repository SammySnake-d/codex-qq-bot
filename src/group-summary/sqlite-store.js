import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export class GroupSummaryStore {
  constructor(databasePath, { DatabaseCtor = Database } = {}) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseCtor(databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("synchronous = NORMAL");
    this.database.pragma("busy_timeout = 5000");
    this.#migrate();
  }

  close() {
    this.database.close();
  }

  getState(groupId) {
    this.#ensureGroup(groupId);
    return mapState(this.database.prepare("select * from group_state where group_id = ?").get(String(groupId)));
  }

  setNextDueAt(groupId, nextDueAt, nowMs = Date.now()) {
    this.#ensureGroup(groupId, nowMs);
    this.database.prepare(`
      update group_state
      set next_due_at = @nextDueAt, updated_at = @nowMs
      where group_id = @groupId
    `).run({ groupId: String(groupId), nextDueAt: Number(nextDueAt) || null, nowMs });
  }

  upsertMessages(groupId, messages, nowMs = Date.now()) {
    const normalizedGroupId = String(groupId);
    const insert = this.database.prepare(`
      insert into group_messages (
        group_id, message_id, message_seq, message_cursor, sent_at, user_id,
        display_name, content, content_hash, raw_hash, is_self, inserted_at
      ) values (
        @groupId, @messageId, @sequence, @cursor, @sentAt, @userId,
        @displayName, @content, @contentHash, @rawHash, @isSelf, @insertedAt
      )
      on conflict(group_id, message_id) do update set
        message_seq = excluded.message_seq,
        message_cursor = excluded.message_cursor,
        sent_at = excluded.sent_at,
        user_id = excluded.user_id,
        display_name = excluded.display_name,
        content = excluded.content,
        content_hash = excluded.content_hash,
        raw_hash = excluded.raw_hash,
        is_self = excluded.is_self
    `);
    const transaction = this.database.transaction((items) => {
      this.#ensureGroup(normalizedGroupId, nowMs);
      let changed = 0;
      let newestCursor = "";
      for (const message of items) {
        const result = insert.run({
          ...message,
          groupId: normalizedGroupId,
          sequence: message.sequence || null,
          userId: message.userId || "",
          isSelf: message.isSelf ? 1 : 0,
          insertedAt: nowMs
        });
        changed += result.changes;
        if (message.cursor > newestCursor) newestCursor = message.cursor;
      }
      if (newestCursor) {
        this.database.prepare(`
          update group_state
          set last_ingested_cursor = case
              when last_ingested_cursor is null or last_ingested_cursor < @cursor then @cursor
              else last_ingested_cursor
            end,
            updated_at = @nowMs
          where group_id = @groupId
        `).run({ groupId: normalizedGroupId, cursor: newestCursor, nowMs });
      }
      return { changed, newestCursor };
    });
    return transaction(Array.isArray(messages) ? messages : []);
  }

  getPendingMessages(groupId, { limit = 1_000 } = {}) {
    const state = this.getState(groupId);
    const rows = this.database.prepare(`
      select * from group_messages
      where group_id = @groupId
        and is_self = 0
        and message_cursor > @afterCursor
      order by message_cursor asc
      limit @limit
    `).all({
      groupId: String(groupId),
      afterCursor: state.lastSummarizedCursor || "",
      limit: Math.max(1, Math.floor(limit))
    });
    return rows.map(mapMessage);
  }

  getOrCreateRun(groupId, messages, nowMs = Date.now()) {
    if (!messages.length) throw new Error("Cannot create a summary run without messages");
    const startCursor = messages[0].cursor;
    const endCursor = messages.at(-1).cursor;
    const existing = this.database.prepare(`
      select * from summary_runs
      where group_id = ? and start_cursor = ? and end_cursor = ?
    `).get(String(groupId), startCursor, endCursor);
    if (existing) return mapRun(existing);

    const runId = randomUUID();
    const speakerCount = new Set(messages.map((message) => message.userId).filter(Boolean)).size;
    this.database.prepare(`
      insert into summary_runs (
        run_id, group_id, start_cursor, end_cursor, status, message_count,
        speaker_count, created_at, updated_at
      ) values (?, ?, ?, ?, 'generating', ?, ?, ?, ?)
    `).run(runId, String(groupId), startCursor, endCursor, messages.length, speakerCount, nowMs, nowMs);
    return this.getRun(runId);
  }

  getRun(runId) {
    const row = this.database.prepare("select * from summary_runs where run_id = ?").get(String(runId));
    return row ? mapRun(row) : null;
  }

  markGenerating(runId, nowMs = Date.now()) {
    this.#updateRunStatus(runId, "generating", { error: null, nowMs });
  }

  markReady(runId, { outputJson, renderedText, outputHash }, nowMs = Date.now()) {
    this.database.prepare(`
      update summary_runs
      set status = 'ready', output_json = @outputJson, rendered_text = @renderedText,
        output_hash = @outputHash, error = null, updated_at = @nowMs
      where run_id = @runId
    `).run({
      runId: String(runId),
      outputJson: JSON.stringify(outputJson),
      renderedText,
      outputHash,
      nowMs
    });
  }

  markSending(runId, nowMs = Date.now()) {
    this.#updateRunStatus(runId, "sending", { error: null, nowMs });
  }

  markRunFailure(runId, status, error, nowMs = Date.now()) {
    if (!["generation_failed", "delivery_failed", "delivery_unknown"].includes(status)) {
      throw new Error(`Unsupported summary failure status: ${status}`);
    }
    this.#updateRunStatus(runId, status, { error: String(error?.message || error || "unknown failure").slice(0, 4_000), nowMs });
  }

  markSent(runId, { sentMessageId = "", nextDueAt, reconciled = false }, nowMs = Date.now()) {
    const transaction = this.database.transaction(() => {
      const run = this.getRun(runId);
      if (!run) throw new Error(`Unknown summary run: ${runId}`);
      this.database.prepare(`
        update summary_runs
        set status = 'sent', sent_message_id = @sentMessageId, reconciled = @reconciled,
          error = null, updated_at = @nowMs
        where run_id = @runId
      `).run({ runId: String(runId), sentMessageId: String(sentMessageId || ""), reconciled: reconciled ? 1 : 0, nowMs });
      this.#ensureGroup(run.groupId, nowMs);
      this.database.prepare(`
        update group_state
        set last_summarized_cursor = case
              when last_summarized_cursor is null or last_summarized_cursor < @endCursor then @endCursor
              else last_summarized_cursor
            end,
            last_sent_at = @nowMs,
            next_due_at = @nextDueAt,
            updated_at = @nowMs
        where group_id = @groupId
      `).run({ groupId: run.groupId, endCursor: run.endCursor, nowMs, nextDueAt });
    });
    transaction();
  }

  findUnresolvedDelivery(groupId) {
    const row = this.database.prepare(`
      select * from summary_runs
      where group_id = ? and status in ('sending', 'delivery_unknown')
      order by created_at asc
      limit 1
    `).get(String(groupId));
    return row ? mapRun(row) : null;
  }

  findSelfMessageByContentHash(groupId, contentHash, { afterMs = 0 } = {}) {
    const row = this.database.prepare(`
      select * from group_messages
      where group_id = @groupId and is_self = 1 and content_hash = @contentHash
        and sent_at >= @afterSeconds
      order by message_cursor desc
      limit 1
    `).get({
      groupId: String(groupId),
      contentHash: String(contentHash || ""),
      afterSeconds: Math.max(0, Math.floor(afterMs / 1_000) - 60)
    });
    return row ? mapMessage(row) : null;
  }

  #ensureGroup(groupId, nowMs = Date.now()) {
    this.database.prepare(`
      insert into group_state (group_id, updated_at)
      values (?, ?)
      on conflict(group_id) do nothing
    `).run(String(groupId), nowMs);
  }

  #updateRunStatus(runId, status, { error, nowMs }) {
    this.database.prepare(`
      update summary_runs
      set status = @status, error = @error, updated_at = @nowMs
      where run_id = @runId
    `).run({ runId: String(runId), status, error, nowMs });
  }

  #migrate() {
    this.database.exec(`
      create table if not exists group_messages (
        group_id text not null,
        message_id text not null,
        message_seq text,
        message_cursor text not null,
        sent_at integer not null,
        user_id text not null,
        display_name text not null,
        content text not null,
        content_hash text not null,
        raw_hash text not null,
        is_self integer not null default 0,
        inserted_at integer not null,
        primary key (group_id, message_id)
      );
      create index if not exists idx_group_messages_cursor
        on group_messages (group_id, message_cursor);
      create index if not exists idx_group_messages_self_hash
        on group_messages (group_id, is_self, content_hash, sent_at);

      create table if not exists group_state (
        group_id text primary key,
        last_ingested_cursor text,
        last_summarized_cursor text,
        next_due_at integer,
        last_sent_at integer,
        updated_at integer not null
      );

      create table if not exists summary_runs (
        run_id text primary key,
        group_id text not null,
        start_cursor text not null,
        end_cursor text not null,
        status text not null,
        message_count integer not null,
        speaker_count integer not null,
        output_json text,
        rendered_text text,
        output_hash text,
        sent_message_id text,
        reconciled integer not null default 0,
        error text,
        created_at integer not null,
        updated_at integer not null,
        unique (group_id, start_cursor, end_cursor)
      );
      create index if not exists idx_summary_runs_status
        on summary_runs (group_id, status, created_at);
    `);
  }
}

function mapState(row) {
  return {
    groupId: row.group_id,
    lastIngestedCursor: row.last_ingested_cursor || "",
    lastSummarizedCursor: row.last_summarized_cursor || "",
    nextDueAt: row.next_due_at == null ? null : Number(row.next_due_at),
    lastSentAt: row.last_sent_at == null ? null : Number(row.last_sent_at),
    updatedAt: Number(row.updated_at)
  };
}

function mapMessage(row) {
  return {
    groupId: row.group_id,
    messageId: row.message_id,
    sequence: row.message_seq || "",
    cursor: row.message_cursor,
    sentAt: Number(row.sent_at),
    userId: row.user_id,
    displayName: row.display_name,
    content: row.content,
    contentHash: row.content_hash,
    rawHash: row.raw_hash,
    isSelf: Boolean(row.is_self)
  };
}

function mapRun(row) {
  return {
    runId: row.run_id,
    groupId: row.group_id,
    startCursor: row.start_cursor,
    endCursor: row.end_cursor,
    status: row.status,
    messageCount: Number(row.message_count),
    speakerCount: Number(row.speaker_count),
    outputJson: row.output_json ? JSON.parse(row.output_json) : null,
    renderedText: row.rendered_text || "",
    outputHash: row.output_hash || "",
    sentMessageId: row.sent_message_id || "",
    reconciled: Boolean(row.reconciled),
    error: row.error || "",
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}
