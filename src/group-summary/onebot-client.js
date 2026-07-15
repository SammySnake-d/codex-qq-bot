export class OneBotClient {
  constructor({ baseUrl, accessToken = "", timeoutMs = 10_000, fetchImpl = fetch }) {
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.accessToken = String(accessToken || "").trim();
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async call(action, params = {}, { signal } = {}) {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const headers = new Headers({ "content-type": "application/json" });
    if (this.accessToken) headers.set("authorization", `Bearer ${this.accessToken}`);

    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/${String(action).replace(/^\/+/, "")}`, {
        method: "POST",
        headers,
        body: JSON.stringify(params),
        signal: mergeSignals(signal, timeoutSignal)
      });
    } catch (error) {
      const timeout = timeoutSignal.aborted || error?.name === "TimeoutError";
      throw new OneBotError(
        timeout ? "ONEBOT_TIMEOUT" : "ONEBOT_NETWORK",
        `${action} ${timeout ? "timed out" : "network request failed"}: ${error.message}`,
        { action, cause: error, deliveryUnknown: isSendAction(action) }
      );
    }

    const text = await response.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch (error) {
      throw new OneBotError("ONEBOT_RESPONSE_INVALID", `${action} returned invalid JSON`, {
        action,
        status: response.status,
        cause: error,
        deliveryUnknown: isSendAction(action)
      });
    }

    const rejected = !response.ok
      || body?.status === "failed"
      || body?.status === "error"
      || (body?.retcode != null && Number(body.retcode) !== 0);
    if (rejected) {
      throw new OneBotError("ONEBOT_REJECTED", `${action} was rejected: ${body?.message || body?.wording || response.status}`, {
        action,
        status: response.status,
        responseBody: body,
        deliveryUnknown: false
      });
    }
    return body?.data ?? body;
  }

  async getLoginInfo(options) {
    const data = await this.call("get_login_info", {}, options);
    const userId = String(data?.user_id ?? data?.userId ?? "").trim();
    if (!userId) throw new OneBotError("ONEBOT_RESPONSE_INVALID", "get_login_info did not return user_id");
    return { userId, nickname: String(data?.nickname || "") };
  }

  async getGroupHistory(groupId, {
    messageSeq = 0,
    count = 200,
    reverseOrder = true,
    signal
  } = {}) {
    const params = {
      group_id: String(groupId),
      count,
      reverse_order: reverseOrder
    };
    if (messageSeq != null && String(messageSeq).trim() && String(messageSeq) !== "0") {
      params.message_seq = String(messageSeq);
    }
    let data;
    try {
      data = await this.call("get_group_msg_history", params, { signal });
    } catch (error) {
      if (isEmptyHistoryResponse(error)) return [];
      throw error;
    }
    const messages = Array.isArray(data?.messages)
      ? data.messages
      : Array.isArray(data)
        ? data
        : [];
    return messages;
  }

  async getFriendHistory(userId, {
    messageSeq = 0,
    count = 200,
    reverseOrder = true,
    signal
  } = {}) {
    const params = {
      user_id: String(userId),
      count,
      reverse_order: reverseOrder
    };
    if (messageSeq != null && String(messageSeq).trim() && String(messageSeq) !== "0") {
      params.message_seq = String(messageSeq);
    }
    let data;
    try {
      data = await this.call("get_friend_msg_history", params, { signal });
    } catch (error) {
      if (isEmptyHistoryResponse(error)) return [];
      throw error;
    }
    return Array.isArray(data?.messages)
      ? data.messages
      : Array.isArray(data)
        ? data
        : [];
  }

  async sendGroupMessage(groupId, message, options = {}) {
    const data = await this.call("send_group_msg", {
      group_id: String(groupId),
      message: String(message || "")
    }, options);
    return {
      messageId: String(data?.message_id ?? data?.messageId ?? ""),
      raw: data
    };
  }

  async sendPrivateMessage(userId, message, options = {}) {
    const data = await this.call("send_private_msg", {
      user_id: String(userId),
      message: String(message || "")
    }, options);
    return {
      messageId: String(data?.message_id ?? data?.messageId ?? ""),
      raw: data
    };
  }
}

function isEmptyHistoryResponse(error) {
  if (error?.code !== "ONEBOT_REJECTED" || !["get_group_msg_history", "get_friend_msg_history"].includes(error?.action)) return false;
  const body = error.responseBody || {};
  const message = String(body.message || body.wording || error.message || "");
  return /消息.*不存在|message.*(?:does not exist|not found)/i.test(message);
}

function isSendAction(action) {
  return ["send_group_msg", "send_private_msg"].includes(String(action || ""));
}

export class OneBotError extends Error {
  constructor(code, message, details = {}) {
    super(message, { cause: details.cause });
    this.name = "OneBotError";
    this.code = code;
    this.action = details.action || "";
    this.status = details.status ?? null;
    this.responseBody = details.responseBody;
    this.deliveryUnknown = Boolean(details.deliveryUnknown);
  }
}

function mergeSignals(...signals) {
  const active = signals.filter(Boolean);
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(active);
  const controller = new AbortController();
  const abort = (event) => controller.abort(event?.target?.reason);
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}
