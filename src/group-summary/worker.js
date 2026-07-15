import { normalizeOneBotHistoryMessage } from "./message-normalizer.js";
import { decideSummarySchedule, randomDueAt } from "./schedule-policy.js";
import { renderSummaryForQq, validateSummaryOutput } from "./summary-schema.js";

export async function runGroupSummaryPass({
  groupId,
  config,
  store,
  oneBot,
  provider,
  force = false,
  now = () => Date.now(),
  random = Math.random
}) {
  const startedAt = now();
  const login = config.selfId ? { userId: config.selfId } : await oneBot.getLoginInfo();
  const sync = await syncGroupHistory({
    groupId,
    selfId: login.userId,
    config,
    store,
    oneBot,
    nowMs: startedAt
  });

  const unresolved = store.findUnresolvedDelivery(groupId);
  if (unresolved) {
    const match = unresolved.outputHash
      ? await findDeliveredSummary({ groupId, config, store, oneBot, unresolved, selfId: login.userId })
      : null;
    if (match) {
      const nextDueAt = randomDueAt(startedAt, config.policy.dueMinMinutes, config.policy.dueMaxMinutes, random);
      store.markSent(unresolved.runId, { sentMessageId: match.messageId, nextDueAt, reconciled: true }, startedAt);
    } else {
      if (unresolved.status === "sending") {
        store.markRunFailure(unresolved.runId, "delivery_unknown", "worker stopped while delivery was in progress", startedAt);
      }
      return {
        groupId,
        status: "delivery_unknown",
        runId: unresolved.runId,
        reason: "unable_to_reconcile_previous_send",
        syncedMessages: sync.normalizedCount
      };
    }
  }

  const state = store.getState(groupId);
  const messages = store.getPendingMessages(groupId, { limit: config.policy.maxMessagesPerRun });
  const decision = decideSummarySchedule({
    nowMs: startedAt,
    state,
    messages,
    policy: config.policy,
    force,
    random
  });

  if (decision.action !== "summarize") {
    if (decision.action === "defer") store.setNextDueAt(groupId, decision.nextDueAt, startedAt);
    return {
      groupId,
      status: decision.action,
      reason: decision.reason,
      nextDueAt: decision.nextDueAt,
      pendingMessages: messages.length,
      syncedMessages: sync.normalizedCount
    };
  }

  const run = store.getOrCreateRun(groupId, messages, startedAt);
  if (run.status === "sent") {
    return { groupId, status: "already_sent", runId: run.runId, pendingMessages: messages.length };
  }
  if (["sending", "delivery_unknown"].includes(run.status)) {
    return { groupId, status: "delivery_unknown", runId: run.runId, reason: "existing_unresolved_delivery" };
  }

  let summary = run.outputJson;
  let renderedText = run.renderedText;
  let outputHash = run.outputHash;
  const summaryBatches = chunkSummaryMessages(messages, {
    maxMessages: config.policy.summaryChunkSize,
    maxChars: config.policy.summaryChunkMaxChars
  });
  if (!summary || !renderedText || !outputHash) {
    store.markGenerating(run.runId, startedAt);
    try {
      summary = null;
      for (let batchIndex = 0; batchIndex < summaryBatches.length; batchIndex += 1) {
        const batch = summaryBatches[batchIndex];
        const rawOutput = await provider.generate({
          groupId,
          messages: batch,
          previousSummary: summary,
          batchIndex,
          batchCount: summaryBatches.length
        });
        summary = validateSummaryOutput(rawOutput, {
          allowedMessageIds: [
            ...collectEvidenceMessageIds(summary),
            ...batch.map((message) => message.messageId)
          ]
        });
      }
      ({ renderedText, outputHash } = renderSummaryForQq(summary, {
        periodStart: messages[0].sentAt * 1_000,
        periodEnd: messages.at(-1).sentAt * 1_000,
        messageCount: messages.length,
        speakerCount: new Set(messages.map((message) => message.userId).filter(Boolean)).size,
        maxChars: config.policy.maxRenderedChars
      }));
      store.markReady(run.runId, { outputJson: summary, renderedText, outputHash }, now());
    } catch (error) {
      store.markRunFailure(run.runId, "generation_failed", error, now());
      return { groupId, status: "generation_failed", runId: run.runId, error: error.message };
    }
  }

  if (!config.sendEnabled) {
    const nextDueAt = randomDueAt(startedAt, config.policy.lowActivityMinMinutes, config.policy.lowActivityMaxMinutes, random);
    store.setNextDueAt(groupId, nextDueAt, now());
    return {
      groupId,
      status: "ready_not_sent",
      runId: run.runId,
      renderedText,
      summaryBatchCount: summaryBatches.length,
      summaryChunkSize: config.policy.summaryChunkSize,
      nextDueAt
    };
  }

  store.markSending(run.runId, now());
  try {
    const sent = config.delivery?.mode === "private"
      ? await oneBot.sendPrivateMessage(config.delivery.userId, renderedText)
      : await oneBot.sendGroupMessage(groupId, renderedText);
    const completedAt = now();
    const nextDueAt = randomDueAt(completedAt, config.policy.dueMinMinutes, config.policy.dueMaxMinutes, random);
    store.markSent(run.runId, { sentMessageId: sent.messageId, nextDueAt }, completedAt);
    return {
      groupId,
      status: "sent",
      runId: run.runId,
      sentMessageId: sent.messageId,
      deliveryMode: config.delivery?.mode || "group",
      deliveryTargetId: config.delivery?.mode === "private" ? config.delivery.userId : groupId,
      summaryBatchCount: summaryBatches.length,
      summaryChunkSize: config.policy.summaryChunkSize,
      messageCount: messages.length,
      nextDueAt,
      renderedText
    };
  } catch (error) {
    const status = error?.deliveryUnknown ? "delivery_unknown" : "delivery_failed";
    store.markRunFailure(run.runId, status, error, now());
    return { groupId, status, runId: run.runId, error: error.message };
  }
}

export function chunkSummaryMessages(messages, { maxMessages = 1_500, maxChars = 240_000 } = {}) {
  const chunks = [];
  let current = [];
  let currentChars = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    const messageChars = estimatePromptChars(message);
    if (current.length && (current.length >= maxMessages || currentChars + messageChars > maxChars)) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(message);
    currentChars += messageChars;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function collectEvidenceMessageIds(summary) {
  if (!summary?.topics) return [];
  return summary.topics.flatMap((topic) => topic.evidence_message_ids || []);
}

function estimatePromptChars(message) {
  return JSON.stringify({
    message_id: message?.messageId || "",
    time: message?.sentAt || 0,
    sender: message?.displayName || "",
    sender_id: message?.userId || "",
    text: message?.content || ""
  }).length;
}

async function findDeliveredSummary({ groupId, config, store, oneBot, unresolved, selfId }) {
  if (config.delivery?.mode !== "private") {
    return store.findSelfMessageByContentHash(groupId, unresolved.outputHash, { afterMs: unresolved.createdAt });
  }
  const rawMessages = await oneBot.getFriendHistory(config.delivery.userId, {
    count: config.oneBot.historyBatchSize,
    reverseOrder: true
  });
  const afterSeconds = Math.max(0, Math.floor(unresolved.createdAt / 1_000) - 60);
  return rawMessages
    .map((message) => normalizeOneBotHistoryMessage(message, {
      groupId: `private:${config.delivery.userId}`,
      selfId
    }))
    .filter(Boolean)
    .find((message) => message.isSelf && message.contentHash === unresolved.outputHash && message.sentAt >= afterSeconds) || null;
}

export async function syncGroupHistory({ groupId, selfId, config, store, oneBot, nowMs = Date.now() }) {
  const stateBefore = store.getState(groupId);
  let messageSeq = 0;
  let previousOldestSequence = "";
  let normalizedCount = 0;
  let pages = 0;

  for (let pageIndex = 0; pageIndex < config.oneBot.maxHistoryPages; pageIndex += 1) {
    pages = pageIndex + 1;
    const rawMessages = await oneBot.getGroupHistory(groupId, {
      messageSeq,
      count: config.oneBot.historyBatchSize,
      reverseOrder: true
    });
    if (!rawMessages.length) break;

    const messages = rawMessages
      .map((message) => normalizeOneBotHistoryMessage(message, { groupId, selfId }))
      .filter(Boolean)
      .sort((left, right) => left.cursor.localeCompare(right.cursor));
    if (!messages.length) break;
    normalizedCount += messages.length;
    store.upsertMessages(groupId, messages, nowMs);

    const oldest = messages[0];
    if (stateBefore.lastIngestedCursor && oldest.cursor <= stateBefore.lastIngestedCursor) break;
    if (!oldest.sequence || oldest.sequence === previousOldestSequence) break;
    previousOldestSequence = oldest.sequence;
    messageSeq = oldest.sequence;
    if (rawMessages.length < config.oneBot.historyBatchSize) break;
  }

  return { pages, normalizedCount };
}
