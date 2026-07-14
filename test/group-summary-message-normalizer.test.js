import assert from "node:assert/strict";
import test from "node:test";
import { normalizeOneBotContent, normalizeOneBotHistoryMessage } from "../src/group-summary/message-normalizer.js";

test("normalizes OneBot segments into stable summary text", () => {
  const content = normalizeOneBotContent([
    { type: "reply", data: { id: "88" } },
    { type: "text", data: { text: " 看这个 " } },
    { type: "image", data: { file: "secret-path" } },
    { type: "record", data: { file: "voice.amr" } }
  ]);
  assert.equal(content, "[回复 88] 看这个 [图片] [语音]");
});

test("creates a sortable message record and marks the logged-in account", () => {
  const normalized = normalizeOneBotHistoryMessage({
    message_id: 9001,
    message_seq: 44,
    time: 1_784_041_200,
    user_id: 123456,
    sender: { card: "群友 A" },
    message: [{ type: "text", data: { text: "进度怎么样" } }]
  }, { groupId: "55555", selfId: "123456" });

  assert.equal(normalized.messageId, "9001");
  assert.equal(normalized.sequence, "44");
  assert.equal(normalized.displayName, "群友 A");
  assert.equal(normalized.content, "进度怎么样");
  assert.equal(normalized.isSelf, true);
  assert.match(normalized.cursor, /^0+1784041200:0+44:9001$/);
  assert.match(normalized.contentHash, /^[a-f0-9]{64}$/);
});
