"use client";

import { Dithering, type DitheringProps } from "@paper-design/shaders-react";

/** 21st Wave demo API, backed by the official Paper Shaders renderer. */
export type DitheringShaderProps = Omit<DitheringProps, "pxSize"> & { pxSize?: number };

export function DitheringShader({ pxSize = 3, size = pxSize, ...props }: DitheringShaderProps) {
  return <Dithering width="100%" height="100%" {...props} size={size} />;
}
