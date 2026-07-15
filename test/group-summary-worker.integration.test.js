import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OneBotClient } from "../src/group-summary/onebot-client.js";
import { GroupSummaryStore } from "../src/group-summary/sqlite-store.js";
import { runGroupSummaryPass } from "../src/group-summary/worker.js";

test("runs history -> SQLite -> provider -> OneBot once and suppresses a duplicate window", async () => {
  const nowMs = new Date(2026, 6, 14, 12, 0).getTime();
  const fixture = createOneBotFixture(nowMs);
  const server = await listen(fixture.handler);
  const directory = await mkdtemp(join(tmpdir(), "group-summary-e2e-"));
  const store = new GroupSummaryStore(join(directory, "summary.sqlite"));
  let providerCalls = 0;
  const provider = {
    async generate({ messages }) {
      providerCalls += 1;
      return summaryFor(messages);
    }
  };
  try {
    const config = makeConfig(server.url, { sendEnabled: true });
    const oneBot = new OneBotClient(config.oneBot);
    const first = await runGroupSummaryPass({
      groupId: "12345",
      config,
      store,
      oneBot,
      provider,
      force: true,
      now: () => nowMs,
      random: () => 0
    });
    assert.equal(first.status, "sent");
    assert.equal(fixture.sentMessages.length, 1);
    assert.equal(providerCalls, 1);
    assert.match(fixture.sentMessages[0], /群聊小结/);

    const second = await runGroupSummaryPass({
      groupId: "12345",
      config,
      store,
      oneBot,
      provider,
      force: true,
      now: () => nowMs + 60_000,
      random: () => 0
    });
    assert.equal(second.status, "defer");
    assert.equal(second.reason, "no_new_messages");
    assert.equal(fixture.sentMessages.length, 1);
    assert.equal(providerCalls, 1);
  } finally {
    store.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reads a group window but delivers the summary to a private friend", async () => {
  const nowMs = new Date(2026, 6, 14, 12, 0).getTime();
  const fixture = createOneBotFixture(nowMs);
  const server = await listen(fixture.handler);
  const directory = await mkdtemp(join(tmpdir(), "group-summary-private-"));
  const store = new GroupSummaryStore(join(directory, "summary.sqlite"));
  const provider = { async generate({ messages }) { return summaryFor(messages); } };
  try {
    const config = makeConfig(server.url, {
      sendEnabled: true,
      delivery: { mode: "private", userId: "2909951742" }
    });
    const result = await runGroupSummaryPass({
      groupId: "12345",
      config,
      store,
      oneBot: new OneBotClient(config.oneBot),
      provider,
      force: true,
      now: () => nowMs,
      random: () => 0
    });
    assert.equal(result.status, "sent");
    assert.equal(result.deliveryMode, "private");
    assert.equal(result.deliveryTargetId, "2909951742");
    assert.equal(fixture.sentMessages.length, 0);
    assert.equal(fixture.privateMessages.length, 1);
    assert.equal(fixture.privateMessages[0].userId, "2909951742");
    assert.match(fixture.privateMessages[0].message, /群聊小结/);
  } finally {
    store.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reconciles a send whose response was lost instead of sending it twice", async () => {
  const nowMs = new Date(2026, 6, 14, 12, 0).getTime();
  const fixture = createOneBotFixture(nowMs, { dropFirstSendResponse: true });
  const server = await listen(fixture.handler);
  const directory = await mkdtemp(join(tmpdir(), "group-summary-unknown-"));
  const store = new GroupSummaryStore(join(directory, "summary.sqlite"));
  const provider = { async generate({ messages }) { return summaryFor(messages); } };
  try {
    const config = makeConfig(server.url, { sendEnabled: true });
    const oneBot = new OneBotClient(config.oneBot);
    const first = await runGroupSummaryPass({
      groupId: "12345",
      config,
      store,
      oneBot,
      provider,
      force: true,
      now: () => nowMs,
      random: () => 0
    });
    assert.equal(first.status, "delivery_unknown");
    assert.equal(fixture.sentMessages.length, 1);

    const second = await runGroupSummaryPass({
      groupId: "12345",
      config,
      store,
      oneBot,
      provider,
      force: true,
      now: () => nowMs + 60_000,
      random: () => 0
    });
    assert.equal(second.status, "defer");
    assert.equal(fixture.sentMessages.length, 1);
    const run = store.getRun(first.runId);
    assert.equal(run.status, "sent");
    assert.equal(run.reconciled, true);
  } finally {
    store.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reconciles a private summary whose response was lost", async () => {
  const nowMs = new Date(2026, 6, 14, 12, 0).getTime();
  const fixture = createOneBotFixture(nowMs, { dropFirstPrivateSendResponse: true });
  const server = await listen(fixture.handler);
  const directory = await mkdtemp(join(tmpdir(), "group-summary-private-unknown-"));
  const store = new GroupSummaryStore(join(directory, "summary.sqlite"));
  const provider = { async generate({ messages }) { return summaryFor(messages); } };
  try {
    const config = makeConfig(server.url, {
      sendEnabled: true,
      delivery: { mode: "private", userId: "2909951742" }
    });
    const oneBot = new OneBotClient(config.oneBot);
    const first = await runGroupSummaryPass({
      groupId: "12345",
      config,
      store,
      oneBot,
      provider,
      force: true,
      now: () => nowMs,
      random: () => 0
    });
    assert.equal(first.status, "delivery_unknown");
    assert.equal(fixture.privateMessages.length, 1);

    const second = await runGroupSummaryPass({
      groupId: "12345",
      config,
      store,
      oneBot,
      provider,
      force: true,
      now: () => nowMs + 60_000,
      random: () => 0
    });
    assert.equal(second.status, "defer");
    assert.equal(fixture.privateMessages.length, 1);
    assert.equal(store.getRun(first.runId).status, "sent");
  } finally {
    store.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function makeConfig(baseUrl, { sendEnabled, delivery = { mode: "group", userId: "" } }) {
  return {
    selfId: "",
    sendEnabled,
    delivery,
    oneBot: {
      baseUrl,
      accessToken: "",
      timeoutMs: 2_000,
      historyBatchSize: 200,
      maxHistoryPages: 3
    },
    policy: {
      minMessages: 1,
      minSpeakers: 1,
      quietMinutes: 0,
      minIntervalMinutes: 1,
      dueMinMinutes: 120,
      dueMaxMinutes: 360,
      lowActivityMinMinutes: 30,
      lowActivityMaxMinutes: 90,
      activeChatMinMinutes: 15,
      activeChatMaxMinutes: 30,
      maxMessagesPerRun: 1_000,
      maxRenderedChars: 900,
      activeHours: { startMinute: 0, endMinute: 23 * 60 + 59 }
    }
  };
}

function summaryFor(messages) {
  return {
    overview: "大家在确认项目进度。",
    topics: [{
      title: "项目进度",
      summary: "当前正在核对实现和测试情况。",
      participants: ["A", "B"],
      evidence_message_ids: messages.slice(0, 2).map((message) => message.messageId)
    }],
    decisions: [],
    open_questions: ["最终上线时间待定"],
    action_items: []
  };
}

function createOneBotFixture(nowMs, {
  dropFirstSendResponse = false,
  dropFirstPrivateSendResponse = false
} = {}) {
  const sentMessages = [];
  const privateMessages = [];
  const privateHistory = [];
  const history = [
    rawMessage("1", 1, nowMs / 1_000 - 3_600, "1001", "A", "开始核对进度"),
    rawMessage("2", 2, nowMs / 1_000 - 3_000, "1002", "B", "测试还差一项")
  ];
  let dropped = false;
  let droppedPrivate = false;

  return {
    sentMessages,
    privateMessages,
    handler: async (req, res) => {
      const body = await readRequestJson(req);
      if (req.url === "/get_login_info") return json(res, { status: "ok", data: { user_id: 9999, nickname: "bot" } });
      if (req.url === "/get_group_msg_history") {
        return json(res, { status: "ok", data: { messages: history } });
      }
      if (req.url === "/get_friend_msg_history") {
        return json(res, { status: "ok", data: { messages: privateHistory } });
      }
      if (req.url === "/send_group_msg") {
        sentMessages.push(body.message);
        history.push(rawMessage(String(9000 + sentMessages.length), 100 + sentMessages.length, nowMs / 1_000 + sentMessages.length, "9999", "bot", body.message));
        if (dropFirstSendResponse && !dropped) {
          dropped = true;
          req.socket.destroy();
          return;
        }
        return json(res, { status: "ok", data: { message_id: 9000 + sentMessages.length } });
      }
      if (req.url === "/send_private_msg") {
        privateMessages.push({ userId: String(body.user_id), message: body.message });
        privateHistory.push(rawMessage(
          String(9500 + privateMessages.length),
          200 + privateMessages.length,
          nowMs / 1_000 + privateMessages.length,
          "9999",
          "bot",
          body.message
        ));
        if (dropFirstPrivateSendResponse && !droppedPrivate) {
          droppedPrivate = true;
          req.socket.destroy();
          return;
        }
        return json(res, { status: "ok", data: { message_id: 9500 + privateMessages.length } });
      }
      return json(res, { status: "failed", retcode: 404 }, 404);
    }
  };
}

function rawMessage(messageId, sequence, sentAt, userId, nickname, text) {
  return {
    message_id: Number(messageId),
    message_seq: sequence,
    time: Math.floor(sentAt),
    user_id: Number(userId),
    sender: { nickname },
    raw_message: text,
    message: [{ type: "text", data: { text } }]
  };
}

async function listen(handler) {
  const server = http.createServer((req, res) => void handler(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

async function readRequestJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

function json(res, body, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
