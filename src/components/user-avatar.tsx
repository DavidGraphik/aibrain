"use client";

import { useState } from "react";
import { initialsForName, validatedAvatarUrl } from "@/auth/avatar-url";

export function UserAvatar({ name, avatarUrl, className = "size-7" }: { name: string; avatarUrl: string | null; className?: string }) {
  const [failed, setFailed] = useState(false);
  const safeUrl = validatedAvatarUrl(avatarUrl);
  // Remote identity avatars are validated HTTPS URLs; do not proxy through Next image optimization.
  // eslint-disable-next-line @next/next/no-img-element
  if (safeUrl && !failed) return <img src={safeUrl} alt="" referrerPolicy="no-referrer" className={`${className} shrink-0 rounded-full object-cover`} style={safeUrl.endsWith("/branding/arnall/profile-pig.png") ? { objectPosition: "left center" } : undefined} onError={() => setFailed(true)} />;
  return <span aria-hidden="true" className={`${className} grid shrink-0 place-items-center rounded-full bg-[var(--surface-selected)] text-[10px] font-semibold text-[var(--text-secondary)]`}>{initialsForName(name)}</span>;
}
