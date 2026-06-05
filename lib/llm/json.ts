// JSON 容错 —— 移植自 copychat services/personaRefiner.ts 的 extractJSON，
// 外加 safeParseJSON 包装（copychat「容错三件套」之一）。
// 用途：LLM 常把 JSON 包在 ```json 代码块里、或前后带解释文字，直接 JSON.parse 会炸。

/**
 * 从可能"脏"的 LLM 文本里抠出 JSON 字符串。
 * 1) 优先取 ```json ... ``` 代码块；
 * 2) 否则从第一个 { 起做花括号配平，取出完整对象。
 * 移植自 copychat（COPY CHAT/copy-chat-app/src/services/personaRefiner.ts）。
 */
export function extractJSON(text: string): string {
  const block = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (block) return block[1].trim();
  const firstBrace = text.indexOf("{");
  if (firstBrace === -1) return text.trim();
  let depth = 0;
  for (let i = firstBrace; i < text.length; i++) {
    if (text[i] === "{") depth++;
    if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.substring(firstBrace, i + 1);
    }
  }
  return text.substring(firstBrace).trim();
}

/**
 * 解析 LLM 返回的 JSON，失败返回 fallback（永不抛）。
 */
export function safeParseJSON<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(extractJSON(text)) as T;
  } catch {
    return fallback;
  }
}
