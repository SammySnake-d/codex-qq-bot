import { hashText, normalizeOneBotContent } from "./message-normalizer.js";

export const SUMMARY_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    overview: { type: "string" },
    topics: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          participants: { type: "array", items: { type: "string" } },
          evidence_message_ids: { type: "array", items: { type: "string" }, minItems: 1 }
        },
        required: ["title", "summary", "participants", "evidence_message_ids"],
        additionalProperties: false
      }
    },
    decisions: { type: "array", items: { type: "string" } },
    open_questions: { type: "array", items: { type: "string" } },
    action_items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          item: { type: "string" },
          owner: { type: ["string", "null"] }
        },
        required: ["item", "owner"],
        additionalProperties: false
      }
    }
  },
  required: ["overview", "topics", "decisions", "open_questions", "action_items"],
  additionalProperties: false
};

export function validateSummaryOutput(value, { allowedMessageIds = [] } = {}) {
  const fail = (message) => {
    const error = new Error(`Invalid summary output: ${message}`);
    error.code = "SUMMARY_SCHEMA_INVALID";
    throw error;
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("expected an object");

  const allowed = new Set(allowedMessageIds.map(String));
  const overview = cleanRequiredString(value.overview, "overview", fail, 1_500);
  const topics = requireArray(value.topics, "topics", fail).map((topic, index) => {
    if (!topic || typeof topic !== "object" || Array.isArray(topic)) fail(`topics[${index}] must be an object`);
    const evidence = requireArray(topic.evidence_message_ids, `topics[${index}].evidence_message_ids`, fail)
      .map((id) => cleanRequiredString(id, `topics[${index}].evidence_message_ids`, fail, 256));
    if (evidence.length === 0) fail(`topics[${index}] must contain evidence_message_ids`);
    if (allowed.size && evidence.some((id) => !allowed.has(id))) fail(`topics[${index}] references an unknown message id`);
    return {
      title: cleanRequiredString(topic.title, `topics[${index}].title`, fail, 160),
      summary: cleanRequiredString(topic.summary, `topics[${index}].summary`, fail, 800),
      participants: requireArray(topic.participants, `topics[${index}].participants`, fail)
        .map((participant) => cleanRequiredString(participant, `topics[${index}].participants`, fail, 120)),
      evidence_message_ids: [...new Set(evidence)]
    };
  });

  return {
    overview,
    topics,
    decisions: cleanStringArray(value.decisions, "decisions", fail),
    open_questions: cleanStringArray(value.open_questions, "open_questions", fail),
    action_items: requireArray(value.action_items, "action_items", fail).map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) fail(`action_items[${index}] must be an object`);
      return {
        item: cleanRequiredString(item.item, `action_items[${index}].item`, fail, 400),
        owner: item.owner == null || String(item.owner).trim() === ""
          ? null
          : cleanRequiredString(item.owner, `action_items[${index}].owner`, fail, 120)
      };
    })
  };
}

export function renderSummaryForQq(summary, {
  periodStart,
  periodEnd,
  messageCount,
  speakerCount,
  maxChars = 900
}) {
  const lines = [
    `【群聊小结｜${formatLocalTime(periodStart)} 至 ${formatLocalTime(periodEnd)}】`,
    `${messageCount} 条消息，${speakerCount} 位成员参与。`,
    summary.overview
  ];

  summary.topics.forEach((topic, index) => {
    const participants = topic.participants.length ? `（${topic.participants.join("、")}）` : "";
    lines.push(`${index + 1}. ${topic.title}：${topic.summary}${participants}`);
  });
  if (summary.decisions.length) lines.push(`已形成：${joinClauses(summary.decisions)}`);
  if (summary.open_questions.length) lines.push(`待续：${joinClauses(summary.open_questions)}`);
  if (summary.action_items.length) {
    lines.push(`待办：${joinClauses(summary.action_items.map((item) => `${item.owner ? `${item.owner}：` : ""}${item.item}`))}`);
  }

  const fullText = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const renderedText = fullText.length <= maxChars ? fullText : `${fullText.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
  return { renderedText, outputHash: hashText(normalizeOneBotContent(null, renderedText)) };
}

function cleanStringArray(value, name, fail) {
  return requireArray(value, name, fail).map((item) => cleanRequiredString(item, name, fail, 500));
}

function requireArray(value, name, fail) {
  if (!Array.isArray(value)) fail(`${name} must be an array`);
  return value;
}

function cleanRequiredString(value, name, fail, maxLength) {
  if (typeof value !== "string" || !value.trim()) fail(`${name} must be a non-empty string`);
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function formatLocalTime(value) {
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return "未知时间";
  const pad = (number) => String(number).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function joinClauses(values) {
  return values.map((value) => String(value || "").trim().replace(/[。；;]+$/g, "")).filter(Boolean).join("；");
}
