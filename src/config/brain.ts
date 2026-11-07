export type AccentName = "graphite" | "blue" | "violet";
export type Density = "comfortable" | "compact";
export type CornerStyle = "soft" | "rounded" | "precise";
export type BrainWindowId = "chat" | "inspector" | "runtime";

export type BrainWindow = {
  id: BrainWindowId;
  label: string;
  enabled: boolean;
};

export type ComposerCapability = {
  images: boolean;
  imageGeneration: boolean;
  modelSelection: boolean;
  webSearch: boolean;
  skills: boolean;
  modes: ("agent" | "plan" | "ask")[];
};

export type BrainManifest = {
  id: string;
  version: number;
  identity: {
    productName: string;
    assistantName: string;
    role: string;
    language: "ca" | "es" | "en";
    tone: "direct" | "balanced" | "detailed";
  };
  interface: {
    welcomeTitle: string;
    welcomeMessage: string;
    accent: AccentName;
    /** Installation-owned accent used until the employee chooses a personal palette. */
    accentColor?: string;
    density: Density;
    corners: CornerStyle;
    showInspector: boolean;
    showActivityPanel: boolean;
  };
  behavior: {
    conversationMemory: boolean;
    approvalMode: "interactive" | "never";
  };
  runtime: {
    adapter: "local_demo" | "codex_app_server";
    transport: "private_websocket";
  };
  composer: ComposerCapability;
  windows: BrainWindow[];
};

export type BrainPreferences = Pick<
  BrainManifest["identity"],
  "assistantName" | "tone"
> &
  Pick<
    BrainManifest["interface"],
    "accent" | "density" | "corners" | "showInspector" | "showActivityPanel"
  > &
  Pick<BrainManifest["behavior"], "conversationMemory">;

export function preferencesFromManifest(manifest: BrainManifest): BrainPreferences {
  return {
    assistantName: manifest.identity.assistantName,
    tone: manifest.identity.tone,
    accent: manifest.interface.accent,
    density: manifest.interface.density,
    corners: manifest.interface.corners,
    showInspector: manifest.interface.showInspector,
    showActivityPanel: manifest.interface.showActivityPanel,
    conversationMemory: manifest.behavior.conversationMemory,
  };
}

export const baseBrainManifest: BrainManifest = {
  id: "aibrain-studio",
  version: 3,
  identity: {
    productName: "Example AI",
    assistantName: "Asistente",
    role: "Asistente de trabajo",
    language: "es",
    tone: "balanced",
  },
  interface: {
    welcomeTitle: "¿En qué trabajamos?",
    welcomeMessage:
      "Describe el resultado que necesitas y revisa el progreso sin salir de la conversación.",
    accent: "blue",
    density: "comfortable",
    corners: "soft",
    showInspector: true,
    showActivityPanel: true,
  },
  behavior: {
    conversationMemory: true,
    approvalMode: "interactive",
  },
  runtime: {
    adapter: "codex_app_server",
    transport: "private_websocket",
  },
  composer: {
    images: true,
    imageGeneration: true,
    modelSelection: true,
    webSearch: true,
    skills: true,
    modes: ["agent", "plan", "ask"],
  },
  windows: [
    { id: "chat", label: "Workbench", enabled: true },
    { id: "inspector", label: "Cambios y resultados", enabled: true },
    { id: "runtime", label: "Entorno", enabled: true },
  ],
};

export const operationsBrainManifest: BrainManifest = {
  id: "aibrain-operations",
  version: 3,
  identity: {
    productName: "Northwind AI",
    assistantName: "Asistente",
    role: "Asistente de operaciones",
    language: "es",
    tone: "direct",
  },
  interface: {
    welcomeTitle: "¿Qué resolvemos hoy?",
    welcomeMessage:
      "Coordina incidencias y cambios con un historial claro y decisiones explícitas.",
    accent: "blue",
    density: "compact",
    corners: "precise",
    showInspector: true,
    showActivityPanel: true,
  },
  behavior: {
    conversationMemory: true,
    approvalMode: "interactive",
  },
  runtime: {
    adapter: "codex_app_server",
    transport: "private_websocket",
  },
  composer: {
    images: true,
    imageGeneration: true,
    modelSelection: true,
    webSearch: true,
    skills: true,
    modes: ["agent", "plan", "ask"],
  },
  windows: [
    { id: "chat", label: "Trabajo", enabled: true },
    { id: "inspector", label: "Cambios y resultados", enabled: true },
    { id: "runtime", label: "Entorno", enabled: true },
  ],
};

export const defaultPreferences = preferencesFromManifest(baseBrainManifest);

export const accentTokens: Record<
  AccentName,
  { solid: string; soft: string; contrast: string }
> = {
  graphite: { solid: "#171717", soft: "#ecebea", contrast: "#ffffff" },
  blue: { solid: "#315ee7", soft: "#e9efff", contrast: "#ffffff" },
  violet: { solid: "#7656d8", soft: "#f0ebff", contrast: "#ffffff" },
};

type Rgb = readonly [number, number, number];

function hexToRgb(color: string): Rgb {
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ];
}

function rgbToHex(channels: Rgb) {
  return `#${channels.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

function relativeLuminance(channels: Rgb) {
  return channels
    .map((channel) => channel / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
}

function contrastRatio(foreground: Rgb, background: Rgb) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

function mixRgb(from: Rgb, to: Rgb, amount: number): Rgb {
  return [
    from[0] + (to[0] - from[0]) * amount,
    from[1] + (to[1] - from[1]) * amount,
    from[2] + (to[2] - from[2]) * amount,
  ];
}

function ensureContrast(color: Rgb, backgrounds: readonly Rgb[], target: Rgb, minimum = 4.65) {
  const meetsMinimum = (candidate: Rgb) => backgrounds.every((background) => contrastRatio(candidate, background) >= minimum);
  if (meetsMinimum(color)) return rgbToHex(color);
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 16; iteration += 1) {
    const amount = (low + high) / 2;
    if (meetsMinimum(mixRgb(color, target, amount))) high = amount;
    else low = amount;
  }
  return rgbToHex(mixRgb(color, target, high));
}

function readableText(background: Rgb) {
  const light = hexToRgb("#ffffff");
  const dark = hexToRgb("#111827");
  const lightRatio = contrastRatio(light, background);
  const darkRatio = contrastRatio(dark, background);
  if (lightRatio >= 4.5 && lightRatio >= darkRatio) return "#ffffff";
  if (darkRatio >= 4.5) return "#111827";
  return "#000000";
}

export function customAccentTokens(color: string) {
  const normalized = color.toLocaleLowerCase("en-US");
  if (!/^#[0-9a-f]{6}$/u.test(normalized)) return null;
  const channels = hexToRgb(normalized);
  const lightSurfaces = ["#ffffff", "#f9f9f9", "#fcfcfc", "#f4f4f4", "#ececec", "#e7e7e7", "#f1f1f1"].map(hexToRgb);
  const darkSurfaces = ["#000000", "#202020", "#2a2a2a", "#303030", "#353535", "#2f2f2f"].map(hexToRgb);
  const onLight = ensureContrast(channels, lightSurfaces, hexToRgb("#000000"));
  const onDark = ensureContrast(channels, darkSurfaces, hexToRgb("#ffffff"));
  const onLightRgb = hexToRgb(onLight);
  const onDarkRgb = hexToRgb(onDark);
  const lightSoftSurfaces = [
    ...lightSurfaces.map((surface) => mixRgb(surface, onLightRgb, 0.12)),
    mixRgb(hexToRgb("#ffffff"), onLightRgb, 0.1),
  ];
  const darkSoftSurfaces = [
    ...darkSurfaces.map((surface) => mixRgb(surface, onDarkRgb, 0.12)),
    mixRgb(hexToRgb("#000000"), onDarkRgb, 0.26),
  ];
  const onLightSoft = ensureContrast(onLightRgb, lightSoftSurfaces, hexToRgb("#000000"));
  const onDarkSoft = ensureContrast(onDarkRgb, darkSoftSurfaces, hexToRgb("#ffffff"));
  return Object.freeze({
    solid: normalized,
    soft: `color-mix(in srgb, ${normalized} 12%, white)`,
    contrast: readableText(channels),
    onLight,
    onDark,
    onLightSoft,
    onDarkSoft,
    onLightContrast: readableText(onLightRgb),
    onDarkContrast: readableText(onDarkRgb),
  });
}

export const cornerTokens: Record<CornerStyle, string> = {
  soft: "12px",
  rounded: "20px",
  precise: "5px",
};
