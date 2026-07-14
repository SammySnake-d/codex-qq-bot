import { createHash } from "node:crypto";

export function normalizeOneBotHistoryMessage(message, { groupId, selfId = "" } = {}) {
  const messageId = normalizeMessageId(message);
  const sentAt = normalizeTimestamp(message?.time);
  if (!messageId || !sentAt) return null;

  const userId = String(message?.user_id ?? message?.sender?.user_id ?? message?.sender?.userId ?? "").trim();
  const sequence = normalizeSequence(message?.message_seq ?? message?.message_id);
  const content = normalizeOneBotContent(message?.message, message?.raw_message);
  const normalizedGroupId = String(groupId ?? message?.group_id ?? "").trim();
  if (!normalizedGroupId || !content) return null;

  return {
    groupId: normalizedGroupId,
    messageId,
    sequence,
    cursor: buildMessageCursor({ sentAt, sequence, messageId }),
    sentAt,
    userId,
    displayName: String(message?.sender?.card || message?.sender?.nickname || userId || "群友").trim().slice(0, 120),
    content: content.slice(0, 8_000),
    contentHash: hashText(content),
    rawHash: hashText(JSON.stringify(message || {})),
    isSelf: Boolean(selfId && userId && String(selfId) === userId)
  };
}

export function normalizeOneBotContent(message, rawMessage = "") {
  if (!Array.isArray(message)) return cleanText(rawMessage);
  const parts = [];
  for (const segment of message) {
    const type = String(segment?.type || "").toLowerCase();
    const data = segment?.data && typeof segment.data === "object" ? segment.data : {};
    if (type === "text") parts.push(String(data.text || ""));
    else if (type === "at") parts.push(`@${data.qq || data.id || data.uin || "群友"}`);
    else if (type === "reply") parts.push(`[回复 ${data.id || data.message_id || "消息"}]`);
    else if (type === "image") parts.push("[图片]");
    else if (["record", "voice", "audio"].includes(type)) parts.push("[语音]");
    else if (type === "video") parts.push("[视频]");
    else if (type === "file") parts.push(`[文件${data.name ? ` ${data.name}` : ""}]`);
    else if (type === "forward") parts.push("[合并转发]");
    else if (["json", "xml"].includes(type)) parts.push("[卡片]");
    else if (["face", "mface", "marketface"].includes(type)) parts.push("[表情]");
    else if (type) parts.push(`[${type}]`);
  }
  return cleanText(parts.join(" ") || rawMessage);
}

export function buildMessageCursor({ sentAt, sequence = "", messageId }) {
  const timestampPart = String(Math.max(0, Math.floor(Number(sentAt) || 0))).padStart(16, "0");
  const sequencePart = /^\d+$/.test(String(sequence || ""))
    ? String(sequence).padStart(24, "0")
    : "0".repeat(24);
  return `${timestampPart}:${sequencePart}:${String(messageId || "")}`;
}

export function hashText(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function normalizeMessageId(message) {
  const direct = message?.message_id ?? message?.id;
  if (direct != null && String(direct).trim()) return String(direct).trim().slice(0, 256);
  const sequence = normalizeSequence(message?.message_seq);
  const sentAt = normalizeTimestamp(message?.time);
  const userId = String(message?.user_id ?? message?.sender?.user_id ?? "").trim();
  if (!sequence && !sentAt) return "";
  return `fallback:${sequence || 0}:${sentAt || 0}:${userId}`;
}

function normalizeSequence(value) {
  const text = String(value ?? "").trim();
  return /^\d+$/.test(text) ? text : "";
}

function normalizeTimestamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.floor(number > 10_000_000_000 ? number / 1_000 : number);
}

function cleanText(value) {
  return String(value || "")
    .replace(/\[CQ:image[^\]]*\]/gi, "[图片]")
    .replace(/\[CQ:(?:record|voice|audio)[^\]]*\]/gi, "[语音]")
    .replace(/\[CQ:video[^\]]*\]/gi, "[视频]")
    .replace(/\[CQ:face[^\]]*\]/gi, "[表情]")
    .replace(/\s+/g, " ")
    .trim();
}
