import assert from "node:assert/strict";
import test from "node:test";
import { loadGroupSummaryConfig, parseActiveHours, parseGroupIds } from "../src/group-summary/config.js";

test("loads explicit group summary configuration without targeting groups by default", () => {
  const disabled = loadGroupSummaryConfig({ env: {}, projectDir: "/tmp/project" });
  assert.deepEqual(disabled.groupIds, []);
  assert.equal(disabled.sendEnabled, false);

  const enabled = loadGroupSummaryConfig({
    projectDir: "/tmp/project",
    env: {
      QQ_SUMMARY_GROUP_IDS: "123456, 789012 123456",
      QQ_SUMMARY_DELIVERY_MODE: "private",
      QQ_SUMMARY_DELIVERY_USER_ID: "2909951742",
      QQ_SUMMARY_PROVIDER: "claude",
      QQ_SUMMARY_SEND_ENABLED: "1",
      QQ_SUMMARY_MIN_MESSAGES: "1500",
      QQ_SUMMARY_CHUNK_SIZE: "1500",
      QQ_SUMMARY_CHUNK_MAX_CHARS: "240000"
    }
  });
  assert.deepEqual(enabled.groupIds, ["123456", "789012"]);
  assert.deepEqual(enabled.delivery, { mode: "private", userId: "2909951742" });
  assert.equal(enabled.provider.type, "claude");
  assert.equal(enabled.sendEnabled, true);
  assert.equal(enabled.policy.minMessages, 1_500);
  assert.equal(enabled.policy.summaryChunkSize, 1_500);
  assert.equal(enabled.policy.summaryChunkMaxChars, 240_000);
});

test("rejects invalid identifiers and active hour ranges", () => {
  assert.throws(() => parseGroupIds("not-a-group"), /Invalid QQ group id/);
  assert.deepEqual(parseActiveHours("08:30-23:00"), {
    startMinute: 510,
    endMinute: 1_380,
    source: "08:30-23:00"
  });
  assert.throws(() => parseActiveHours("25:00-26:00"), /invalid time/);
  assert.throws(() => loadGroupSummaryConfig({
    env: { QQ_SUMMARY_DELIVERY_MODE: "private" },
    projectDir: "/tmp/project"
  }), /QQ_SUMMARY_DELIVERY_USER_ID is required/);
});
