// Wire format used by openai.chatgpt 26.901.22334. Keep the leading newline:
// the extension uses it to distinguish annotation context from ordinary text.
export const ANNOTATION_PREFIX = "\n# Response annotations:\n";
const OPEN = "\n<response-annotations>\n";
const CLOSE = "\n</response-annotations>\n";
const REQUEST = "## My request:";
export const ANNOTATION_INSTRUCTIONS = 'Each item contains text selected from an earlier Codex response and may include a user comment. Treat items as Annotation 1, Annotation 2, and so on in array order. Use every selection as context and address every comment. For every annotation you address, include its inline directive `:codex-annotation{index="N"}`, where N is its one-based array position (for example, `:codex-annotation{index="1"}`). Do not use unstructured annotation labels.';

export function annotationWireValue(value) {
  if (!value || typeof value.text !== "string" || !value.text.trim()) throw new Error("注释缺少所选原文");
  const result = { text: value.text };
  if (typeof value.annotation === "string" && value.annotation.trim()) result.annotation = value.annotation.trim();
  if (value.source != null) {
    const { messageId, startOffset, endOffset } = value.source;
    if (typeof messageId !== "string" || !messageId || !Number.isSafeInteger(startOffset) ||
        !Number.isSafeInteger(endOffset) || startOffset < 0 || endOffset <= startOffset) {
      throw new Error("注释的原文位置无效");
    }
    result.source = { messageId, startOffset, endOffset };
  }
  return result;
}

export function encodeResponseAnnotations(prompt, annotations = []) {
  if (!annotations.length) return String(prompt || "");
  const values = annotations.map(annotationWireValue);
  return `${ANNOTATION_PREFIX}${ANNOTATION_INSTRUCTIONS}${OPEN}${JSON.stringify(values)}${CLOSE}\n${REQUEST}\n${String(prompt || "")}\n`;
}

export function decodeResponseAnnotations(text) {
  if (typeof text !== "string" || !text.startsWith(ANNOTATION_PREFIX)) return null;
  const start = text.indexOf(OPEN, ANNOTATION_PREFIX.length);
  if (start < 0) return null;
  const end = text.indexOf(CLOSE, start + OPEN.length);
  if (end < 0) return null;
  let annotations;
  try {
    const values = JSON.parse(text.slice(start + OPEN.length, end));
    if (!Array.isArray(values) || !values.length) return null;
    annotations = values.map(annotationWireValue);
  } catch { return null; }
  const tail = text.slice(end + CLOSE.length);
  const marker = /(?:^|\n)## My request(?: for Codex)?:\s*\n/.exec(tail);
  if (!marker) return null;
  return { annotations, prompt: tail.slice(marker.index + marker[0].length).trim() };
}
