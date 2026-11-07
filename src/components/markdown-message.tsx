"use client";
import { useUiText } from "@/i18n/provider";

import { memo, useState } from "react";
import { Check, Copy } from "@phosphor-icons/react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

function CodeBlock({ language, value }: { language: string | null; value: string }) {
  const t = useUiText();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <figure className="markdown-code">
      <figcaption>
        <span>{language ?? "texto"}</span>
        <button type="button" aria-label={t("Copiar bloque de código")} onClick={() => void copy()}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? t("Copiado") : t("Copiar")}</button>
      </figcaption>
      <pre><code>{value}</code></pre>
    </figure>
  );
}

const markdownComponents: Components = {
  a: ({ children: label, ...props }) => <a {...props} target="_blank" rel="noreferrer">{label}</a>,
  pre: ({ children: content }) => <>{content}</>,
  code: ({ className, children: content, ...props }) => {
    const value = String(content).replace(/\n$/, "");
    const language = /language-([\w-]+)/.exec(className ?? "")?.[1] ?? null;
    const block = Boolean(className) || value.includes("\n");
    return block
      ? <CodeBlock language={language} value={value} />
      : <code className={className} {...props}>{content}</code>;
  },
  table: ({ children: content }) => <div className="markdown-table-wrap"><table>{content}</table></div>,
};

// Allow only inert table line breaks; keep arbitrary HTML disabled.
function remarkTableLineBreaks() {
  return (tree: { type: string; value?: string; children?: unknown[] }) => {
    function visit(node: typeof tree, inTable = false) {
      const table = inTable || node.type === "table";
      if (table && node.type === "html" && /^<br\s*\/?\s*>$/i.test(node.value ?? "")) {
        node.type = "break";
        delete node.value;
      }
      for (const child of node.children ?? []) visit(child as typeof tree, table);
    }
    visit(tree);
  };
}
const markdownPlugins = [remarkGfm, remarkTableLineBreaks];

/**
 * Markdown is block-oriented. Once a blank line closes a block outside a
 * fenced code section, later streamed text cannot change that block. Keeping
 * those completed blocks memoized means only the live tail is parsed again.
 */
export function splitStreamingMarkdown(source: string) {
  const blocks: string[] = [];
  let blockStart = 0;
  let lineStart = 0;
  let fence: { marker: "`" | "~"; length: number } | null = null;

  while (lineStart < source.length) {
    const newline = source.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? source.length : newline;
    const line = source.slice(lineStart, lineEnd);
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]?.[0] as "`" | "~";
      const length = fenceMatch[1]?.length ?? 0;
      if (!fence) fence = { marker, length };
      else if (fence.marker === marker && length >= fence.length) fence = null;
    }

    if (!fence && line.trim() === "" && lineStart > blockStart) {
      const block = source.slice(blockStart, lineStart).trimEnd();
      if (block) blocks.push(block);
      blockStart = newline === -1 ? source.length : newline + 1;
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }

  const tail = source.slice(blockStart).trimStart();
  if (tail) blocks.push(tail);
  return blocks.length ? blocks : source.trim() ? [source] : [];
}

const MarkdownBlock = memo(function MarkdownBlock({ source }: { source: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={markdownPlugins}
      components={markdownComponents}
    >
      {source}
    </ReactMarkdown>
  );
});

// Plain paragraphs and ATX headings have no cross-block dependencies. Keep
// their already painted nodes when streaming ends instead of reparsing the
// entire answer. Complex Markdown still gets one authoritative final parse
// (reference links, loose lists, HTML, tables and code can span blocks).
function hasIndependentPlainBlocks(source: string) {
  return !/[`~*_\[\]<>|\\]/u.test(source) &&
    !/^(?: {4}|\t| {0,3}(?:[-+]\s|\d+[.)]\s|={2,}\s*$|-{2,}\s*$))/mu.test(source);
}

export const MarkdownMessage = memo(function MarkdownMessage({ children, streaming = false }: { children: string; streaming?: boolean }) {
  const blocks = streaming || hasIndependentPlainBlocks(children) ? splitStreamingMarkdown(children) : [children];
  const completedBlocks = streaming ? blocks.slice(0, -1) : blocks;
  const streamingTail = streaming ? blocks.at(-1) ?? "" : "";
  return (
    <div className={`markdown-body${streaming ? " t-stream" : ""}`}>
      {completedBlocks.map((block, index) => (
        <MarkdownBlock
          key={index}
          source={block}
        />
      ))}
      {streamingTail ? (
        <div className="markdown-stream-tail">
          {streamingTail}
          <span aria-hidden="true" className="t-stream-caret" />
        </div>
      ) : null}
    </div>
  );
});
