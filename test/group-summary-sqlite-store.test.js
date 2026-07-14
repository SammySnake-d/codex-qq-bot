import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GroupSummaryStore } from "../src/group-summary/sqlite-store.js";
import { buildMessageCursor, hashText } from "../src/group-summary/message-normalizer.js";

test("persists cursors, excludes self messages, and advances only after sent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "group-summary-store-"));
  const store = new GroupSummaryStore(join(directory, "summary.sqlite"));
  try {
    const messages = [
      makeMessage("1", 100, "u1", "第一条"),
      makeMessage("2", 101, "u2", "第二条"),
      { ...makeMessage("3", 102, "bot", "旧总结"), isSelf: true }
    ];
    store.upsertMessages("1234", messages, 1_000);
    store.upsertMessages("1234", messages, 2_000);

    const pending = store.getPendingMessages("1234");
    assert.deepEqual(pending.map((message) => message.messageId), ["1", "2"]);

    const run = store.getOrCreateRun("1234", pending, 3_000);
    store.markReady(run.runId, {
      outputJson: { overview: "ok" },
      renderedText: "summary text",
      outputHash: hashText("summary text")
    }, 4_000);
    assert.equal(store.getState("1234").lastSummarizedCursor, "");

    store.markSent(run.runId, { sentMessageId: "99", nextDueAt: 999_000 }, 5_000);
    const state = store.getState("1234");
    assert.equal(state.lastSummarizedCursor, pending.at(-1).cursor);
    assert.equal(state.nextDueAt, 999_000);
    assert.deepEqual(store.getPendingMessages("1234"), []);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("finds a matching self message for delivery reconciliation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "group-summary-reconcile-"));
  const store = new GroupSummaryStore(join(directory, "summary.sqlite"));
  try {
    const pending = [makeMessage("10", 200, "u1", "需要总结")];
    store.upsertMessages("5678", pending, 1_000);
    const run = store.getOrCreateRun("5678", pending, 2_000);
    const summaryText = "已经发送但响应超时";
    store.markReady(run.runId, {
      outputJson: { overview: "ok" },
      renderedText: summaryText,
      outputHash: hashText(summaryText)
    }, 3_000);
    store.markRunFailure(run.runId, "delivery_unknown", new Error("timeout"), 4_000);
    store.upsertMessages("5678", [{ ...makeMessage("11", 201, "bot", summaryText), isSelf: true }], 5_000);

    const unresolved = store.findUnresolvedDelivery("5678");
    const match = store.findSelfMessageByContentHash("5678", unresolved.outputHash, { afterMs: unresolved.createdAt });
    assert.equal(match.messageId, "11");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function makeMessage(messageId, sentAt, userId, content) {
  return {
    groupId: "1234",
    messageId,
    sequence: messageId,
    cursor: buildMessageCursor({ sentAt, sequence: messageId, messageId }),
    sentAt,
    userId,
    displayName: userId,
    content,
    contentHash: hashText(content),
    rawHash: hashText(JSON.stringify({ messageId, content })),
    isSelf: false
  };
}
