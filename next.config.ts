import { APP_CSP } from "./src/g03-products/sandbox";
import type { NextConfig } from "next";

const scriptSource = process.env.NODE_ENV === "development"
  ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
  : "script-src 'self' 'unsafe-inline'";

const nextConfig: NextConfig = {
  // The full project (including tests/tools) remains checked by typecheck.
  typescript: { tsconfigPath: "tsconfig.build.json" },
  // Keep the default bundler; the hook compresses explicit Webpack builds only.
  turbopack: {},
  experimental: { webpackBuildWorker: true },
  webpack(config, { dev }) {
    if (!dev && config.cache && typeof config.cache === "object" && config.cache.type === "filesystem") {
      config.cache.compression = "gzip";
    }
    return config;
  },
  outputFileTracingIncludes: {
    "/*": ["./config/installations/vercel-preview.example.json", "./skills/**/*"],
  },
  // Vercel owns the framework build output. The standalone bundle is only for
  // the persistent Docker/host target where Codex App Server can run.
  ...(process.env.VERCEL === "1" ? {} : { output: "standalone" as const }),
  // The private worker gateway needs the real Node `ws` implementation at
  // runtime. Keeping it external avoids framework bundlers substituting their
  // own WebSocket shim in API-route chunks.
  serverExternalPackages: ["ws"],
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "base-uri 'self'",
              "connect-src 'self'",
              "font-src 'self'",
              "form-action 'self'",
              "frame-ancestors 'none'",
              "frame-src 'self' blob:",
              "img-src 'self' data: blob:",
              "media-src 'self' blob:",
              "object-src 'none'",
              scriptSource,
              "style-src 'self' 'unsafe-inline'",
              "worker-src 'self' blob:",
            ].join("; "),
          },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=(), payment=(), usb=()" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
      {
        source: "/auth/recovery",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "private, no-store" },
        ],
      },
      {
        source: "/api/g03/apps/preview",
        headers: [
          { key: "Content-Security-Policy", value: APP_CSP },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
      // The owner-authorized CMS is embedded by this same Brain origin only.
      // Next's framework headers override route Response headers, so the
      // exception must follow the global framing denial here as well.
      {
        source: "/api/insijets/cms/:path*",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Cache-Control", value: "private, no-store" },
          {
            key: "Content-Security-Policy",
            value: "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
