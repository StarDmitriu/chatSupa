import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone", // один бандл для запуска — не нужен второй npm ci в Docker
  // Отключено: React Compiler в связке с RSC даёт ReferenceError: returnNaN is not defined
  // reactCompiler: true,
  async headers() {
    return [
      {
        source: "/_next/static/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
    ];
  },
  async redirects() {
    return [
      { source: "/dashboard/telegram-groups", destination: "/dashboard/groups/telegram", permanent: true },
    ];
  },
  async rewrites() {
    // В Docker используем внутренний хост backend; локально — localhost
    const backendHost =
      process.env.BACKEND_INTERNAL_URL || "http://localhost:3000";
    return [
      {
        source: "/api/:path*",
        destination: `${backendHost.replace(/\/$/, "")}/:path*`,
      },
      { source: "/favicon.ico", destination: "/iconFoto.png" },
    ];
  },
};

export default nextConfig;