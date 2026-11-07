"use client";

import NextImage from "next/image";
import { useState } from "react";
import { Image as ImageIcon } from "@phosphor-icons/react";
import type { ChatAttachment } from "@/lib/chat-contract";

export function ChatAttachmentImage({ attachment, threadId }: { attachment: ChatAttachment; threadId: string }) {
  const [failed, setFailed] = useState(false);
  const extension = attachment.name.split(".").pop()?.toLowerCase();
  if (failed || !extension || !/^(png|jpe?g|gif|webp)$/.test(extension)) return <ImageIcon size={16} />;
  const url = `/api/threads/${encodeURIComponent(threadId)}/documents/${encodeURIComponent(attachment.id)}/preview/preview.${extension}`;
  return <a href={url} target="_blank" rel="noreferrer" aria-label={`Ver ${attachment.name}`}>
    <NextImage unoptimized src={url} width={96} height={72} alt={attachment.name} className="max-h-18 w-24 rounded object-contain" onError={() => setFailed(true)} />
  </a>;
}
