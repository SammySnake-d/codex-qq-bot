import assert from "node:assert/strict";
import test from "node:test";
import { OneBotClient } from "../src/group-summary/onebot-client.js";

test("normalizes OneBot data envelopes and bearer authentication", async () => {
  let captured;
  const client = new OneBotClient({
    baseUrl: "http://127.0.0.1:3000",
    accessToken: "secret",
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify({ status: "ok", data: { messages: [{ message_id: 1 }] } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  const messages = await client.getGroupHistory("1234", { messageSeq: 0, count: 100 });
  assert.equal(messages[0].message_id, 1);
  assert.equal(captured.options.headers.get("authorization"), "Bearer secret");
  assert.deepEqual(JSON.parse(captured.options.body), {
    group_id: "1234",
    count: 100,
    reverse_order: true
  });

  await client.getGroupHistory("1234", { messageSeq: "9876", count: 50 });
  assert.deepEqual(JSON.parse(captured.options.body), {
    group_id: "1234",
    message_seq: "9876",
    count: 50,
    reverse_order: true
  });
});

test("treats NapCat's empty-history rejection as an empty page", async () => {
  const client = new OneBotClient({
    baseUrl: "http://127.0.0.1:3000",
    fetchImpl: async () => new Response(JSON.stringify({
      status: "failed",
      retcode: 200,
      message: "消息0不存在"
    }), { status: 200 })
  });
  assert.deepEqual(await client.getGroupHistory("1234"), []);
});

test("classifies explicit rejection separately from an unknown send outcome", async () => {
  const rejected = new OneBotClient({
    baseUrl: "http://127.0.0.1:3000",
    fetchImpl: async () => new Response(JSON.stringify({ status: "failed", retcode: 100, message: "denied" }), { status: 200 })
  });
  await assert.rejects(
    rejected.sendGroupMessage("1234", "hello"),
    (error) => error.code === "ONEBOT_REJECTED" && error.deliveryUnknown === false
  );

  const disconnected = new OneBotClient({
    baseUrl: "http://127.0.0.1:3000",
    fetchImpl: async () => { throw new TypeError("socket closed"); }
  });
  await assert.rejects(
    disconnected.sendGroupMessage("1234", "hello"),
    (error) => error.code === "ONEBOT_NETWORK" && error.deliveryUnknown === true
  );
  await assert.rejects(
    disconnected.sendPrivateMessage("2909951742", "hello"),
    (error) => error.code === "ONEBOT_NETWORK" && error.deliveryUnknown === true
  );
});

test("sends a private summary to the configured friend", async () => {
  let captured;
  const client = new OneBotClient({
    baseUrl: "http://127.0.0.1:3000",
    fetchImpl: async (url, options) => {
      captured = { url, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ status: "ok", data: { message_id: 42 } }), { status: 200 });
    }
  });
  const result = await client.sendPrivateMessage("2909951742", "summary");
  assert.equal(captured.url, "http://127.0.0.1:3000/send_private_msg");
  assert.deepEqual(captured.body, { user_id: "2909951742", message: "summary" });
  assert.equal(result.messageId, "42");
});
