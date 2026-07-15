import assert from "node:assert/strict";
import test from "node:test";
import { decideSummarySchedule } from "../src/group-summary/schedule-policy.js";

const policy = {
  minMessages: 3,
  minSpeakers: 2,
  quietMinutes: 20,
  minIntervalMinutes: 120,
  dueMinMinutes: 120,
  dueMaxMinutes: 360,
  lowActivityMinMinutes: 30,
  lowActivityMaxMinutes: 90,
  activeChatMinMinutes: 15,
  activeChatMaxMinutes: 30,
  activeHours: { startMinute: 8 * 60, endMinute: 23 * 60 + 30 }
};

test("initializes a persisted random due time instead of sending immediately", () => {
  const nowMs = new Date(2026, 6, 14, 12, 0).getTime();
  const decision = decideSummarySchedule({
    nowMs,
    state: { nextDueAt: null, lastSentAt: null },
    messages: [{ userId: "1", sentAt: nowMs / 1_000 - 3_600 }],
    policy,
    random: () => 0.5
  });
  assert.equal(decision.action, "defer");
  assert.equal(decision.reason, "initial_schedule");
  assert.equal(decision.nextDueAt, nowMs + 240 * 60_000);
});

test("summarizes an eligible quiet window and force bypasses thresholds", () => {
  const nowMs = new Date(2026, 6, 14, 12, 0).getTime();
  const messages = [
    { userId: "1", sentAt: nowMs / 1_000 - 3_600 },
    { userId: "2", sentAt: nowMs / 1_000 - 2_400 },
    { userId: "1", sentAt: nowMs / 1_000 - 1_800 }
  ];
  const eligible = decideSummarySchedule({
    nowMs,
    state: { nextDueAt: nowMs + 6 * 60 * 60_000, lastSentAt: nowMs - 3 * 60 * 60_000 },
    messages,
    policy
  });
  assert.deepEqual(eligible, { action: "summarize", reason: "eligible", nextDueAt: null });

  const forced = decideSummarySchedule({
    nowMs,
    state: { nextDueAt: nowMs + 999_999 },
    messages: [messages[0]],
    policy,
    force: true
  });
  assert.equal(forced.action, "summarize");
  assert.equal(forced.reason, "forced");
});

test("defers while the chat is active or outside configured hours", () => {
  const midday = new Date(2026, 6, 14, 12, 0).getTime();
  const active = decideSummarySchedule({
    nowMs: midday,
    state: { nextDueAt: midday - 1, lastSentAt: null },
    messages: [
      { userId: "1", sentAt: midday / 1_000 - 60 },
      { userId: "2", sentAt: midday / 1_000 - 120 },
      { userId: "1", sentAt: midday / 1_000 - 180 }
    ],
    policy,
    random: () => 0
  });
  assert.equal(active.reason, "chat_still_active");
  assert.equal(active.nextDueAt, midday + 15 * 60_000);

  const night = new Date(2026, 6, 14, 2, 0).getTime();
  const outside = decideSummarySchedule({
    nowMs: night,
    state: { nextDueAt: night - 1, lastSentAt: null },
    messages: [
      { userId: "1", sentAt: night / 1_000 - 3_600 },
      { userId: "2", sentAt: night / 1_000 - 3_500 },
      { userId: "1", sentAt: night / 1_000 - 3_400 }
    ],
    policy
  });
  assert.equal(outside.reason, "outside_active_hours");
  assert.equal(new Date(outside.nextDueAt).getHours(), 8);
});
