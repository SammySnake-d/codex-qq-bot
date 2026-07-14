import assert from "node:assert/strict";
import test from "node:test";
import { renderSummaryForQq, validateSummaryOutput } from "../src/group-summary/summary-schema.js";

const validOutput = {
  overview: "大家主要在确认发布计划。",
  topics: [{
    title: "发布",
    summary: "决定先完成测试再上线。",
    participants: ["A", "B"],
    evidence_message_ids: ["1", "2"]
  }],
  decisions: ["通过测试后上线"],
  open_questions: ["上线时间尚未确定"],
  action_items: [{ item: "补齐测试", owner: "A" }]
};

test("validates evidence ids and renders deterministic QQ text", () => {
  const summary = validateSummaryOutput(validOutput, { allowedMessageIds: ["1", "2"] });
  const rendered = renderSummaryForQq(summary, {
    periodStart: new Date(2026, 6, 14, 10, 0).getTime(),
    periodEnd: new Date(2026, 6, 14, 12, 0).getTime(),
    messageCount: 12,
    speakerCount: 4,
    maxChars: 900
  });
  assert.match(rendered.renderedText, /群聊小结/);
  assert.match(rendered.renderedText, /12 条消息，4 位成员参与/);
  assert.match(rendered.renderedText, /待办：A：补齐测试/);
  assert.doesNotMatch(rendered.renderedText, /。；/);
  assert.match(rendered.outputHash, /^[a-f0-9]{64}$/);
});

test("rejects provider evidence that is not present in the transcript", () => {
  assert.throws(
    () => validateSummaryOutput(validOutput, { allowedMessageIds: ["1"] }),
    (error) => error.code === "SUMMARY_SCHEMA_INVALID" && /unknown message id/.test(error.message)
  );
});
