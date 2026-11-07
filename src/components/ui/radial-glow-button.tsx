"use client";
import { useUiText } from "@/i18n/provider";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface RadialGlowButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children?: ReactNode;
  active?: boolean;
}

/** Retain the existing button API while using the shared native surface. */
export function RadialGlowButton({ children, className, active = true, ...props }: RadialGlowButtonProps) {
  const t = useUiText();
  return (
    <button type="button" className={cn(active && "rg-button", className)} {...props}>
      {children ?? t("Get Extension")}
    </button>
  );
}

export default RadialGlowButton;
