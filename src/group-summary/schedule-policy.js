export function decideSummarySchedule({
  nowMs = Date.now(),
  state,
  messages,
  policy,
  force = false,
  random = Math.random
}) {
  const pendingMessages = Array.isArray(messages) ? messages : [];
  if (pendingMessages.length === 0) {
    return defer("no_new_messages", nowMs, policy.lowActivityMinMinutes, policy.lowActivityMaxMinutes, random);
  }
  if (force) return summarize("forced");

  if (!Number(state?.nextDueAt)) {
    return defer("initial_schedule", nowMs, policy.dueMinMinutes, policy.dueMaxMinutes, random);
  }
  if (nowMs < state.nextDueAt) {
    return { action: "not_due", reason: "before_next_due", nextDueAt: state.nextDueAt };
  }

  if (!isWithinActiveHours(nowMs, policy.activeHours)) {
    return {
      action: "defer",
      reason: "outside_active_hours",
      nextDueAt: nextActiveStart(nowMs, policy.activeHours)
    };
  }

  const minIntervalMs = policy.minIntervalMinutes * 60_000;
  if (Number(state?.lastSentAt) && nowMs - state.lastSentAt < minIntervalMs) {
    return {
      action: "defer",
      reason: "minimum_interval",
      nextDueAt: state.lastSentAt + minIntervalMs
    };
  }

  if (pendingMessages.length < policy.minMessages) {
    return defer("too_few_messages", nowMs, policy.lowActivityMinMinutes, policy.lowActivityMaxMinutes, random);
  }

  const speakerCount = new Set(pendingMessages.map((message) => message.userId).filter(Boolean)).size;
  if (speakerCount < policy.minSpeakers) {
    return defer("too_few_speakers", nowMs, policy.lowActivityMinMinutes, policy.lowActivityMaxMinutes, random);
  }

  const newestSentAtMs = Math.max(...pendingMessages.map((message) => Number(message.sentAt || 0))) * 1_000;
  if (policy.quietMinutes > 0 && nowMs - newestSentAtMs < policy.quietMinutes * 60_000) {
    return defer("chat_still_active", nowMs, policy.activeChatMinMinutes, policy.activeChatMaxMinutes, random);
  }

  return summarize("eligible");
}

export function randomDueAt(nowMs, minMinutes, maxMinutes, random = Math.random) {
  const low = Math.min(minMinutes, maxMinutes);
  const high = Math.max(minMinutes, maxMinutes);
  const ratio = Math.max(0, Math.min(0.999999999, Number(random()) || 0));
  return nowMs + Math.round(low + (high - low) * ratio) * 60_000;
}

export function isWithinActiveHours(nowMs, activeHours) {
  const date = new Date(nowMs);
  const minute = date.getHours() * 60 + date.getMinutes();
  const { startMinute, endMinute } = activeHours;
  return startMinute < endMinute
    ? minute >= startMinute && minute < endMinute
    : minute >= startMinute || minute < endMinute;
}

export function nextActiveStart(nowMs, activeHours) {
  const date = new Date(nowMs);
  const currentMinute = date.getHours() * 60 + date.getMinutes();
  const target = new Date(date);
  target.setSeconds(0, 0);
  target.setHours(Math.floor(activeHours.startMinute / 60), activeHours.startMinute % 60, 0, 0);

  if (activeHours.startMinute < activeHours.endMinute) {
    if (currentMinute >= activeHours.startMinute) target.setDate(target.getDate() + 1);
  } else if (currentMinute >= activeHours.startMinute || currentMinute < activeHours.endMinute) {
    return nowMs;
  } else if (currentMinute > activeHours.startMinute) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime();
}

function defer(reason, nowMs, minMinutes, maxMinutes, random) {
  return {
    action: "defer",
    reason,
    nextDueAt: randomDueAt(nowMs, minMinutes, maxMinutes, random)
  };
}

function summarize(reason) {
  return { action: "summarize", reason, nextDueAt: null };
}
