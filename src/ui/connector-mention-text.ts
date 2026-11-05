import type { ConnectorMention } from "@/connectors/mentions-contract";
export function mentionQueryAt(text: string, caret: number) {
  const prefix = text.slice(0, caret);
  const match = prefix.match(/(?:^|\s)@([^\s@]*)$/u);
  return match ? { query: match[1].toLocaleLowerCase("es"), start: caret - match[1].length - 1, end: caret } : null;
}
export function mentionTextParts(text: string, mentions: readonly Pick<ConnectorMention, "id" | "label">[]) {
  const sorted = [...mentions].sort((a, b) => b.label.length - a.label.length);
  const parts: Array<{ text: string; id?: string }> = [];
  let plain = "";
  for (let i = 0; i < text.length;) {
    const mention = text[i] === "@" && (i === 0 || /\s/u.test(text[i - 1]))
      ? sorted.find(m => text.startsWith(`@${m.label}`, i) && (i + m.label.length + 1 === text.length || /[\s.,;:!?)]/u.test(text[i + m.label.length + 1]))) : undefined;
    if (mention) {
      if (plain) parts.push({ text: plain });
      plain = "";
      const token = `@${mention.label}`;
      parts.push({ text: token, id: mention.id });
      i += token.length;
    } else plain += text[i++];
  }
  if (plain) parts.push({ text: plain });
  return parts;
}
