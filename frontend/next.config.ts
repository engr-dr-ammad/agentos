import type { NextConfig } from "next";

const browserEdition = process.env.NEXT_PUBLIC_EDITION === "browser";
const backend = process.env.BACKEND_URL ?? "http://localhost:8000";

/** Server edition: Next.js server proxying /api to FastAPI. */
const server: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    // Same-origin API: the session cookie never leaves the app's origin.
    return [{ source: "/api/:path*", destination: `${backend}/api/:path*` }];
  },
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ],
    }];
  },
};

/** Browser edition: fully static export for GitHub Pages; the backend runs in the browser. */
const browser: NextConfig = {
  output: "export",
  reactStrictMode: true,
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
  trailingSlash: true,
  images: { unoptimized: true },
};

export default browserEdition ? browser : server;
