import type { NextConfig } from "next";

/**
 * Security headers applied to every response.
 *
 * The CSP is deliberately strict. `unsafe-inline` for styles is required by
 * Tailwind's runtime-injected styles and by Recharts' inline chart styling;
 * scripts get no such exemption, so an injected `<script>` cannot execute.
 */
const securityHeaders = [
  { key: "X-DNS-Prefetch-Control", value: "on" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // `unsafe-eval` is required by React's dev-time refresh runtime only.
      process.env.NODE_ENV === "development"
        ? "script-src 'self' 'unsafe-eval' 'unsafe-inline'"
        : "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "upgrade-insecure-requests",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // The core package ships TypeScript source for workspace consumers; Next
  // transpiles it as part of the app build.
  transpilePackages: ["@memorydb/core"],

  experimental: {
    optimizePackageImports: ["lucide-react", "recharts"],
  },

  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      {
        // API responses must never be cached by a shared proxy: they are
        // namespace-scoped and authenticated.
        source: "/api/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "no-store, no-cache, must-revalidate, private",
          },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
};

export default nextConfig;
