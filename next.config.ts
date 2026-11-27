import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // 통합 2단계: 프런트 임시 정책 경로 → 백엔드 정책 라우트(링크·북마크 보존, 임시 리다이렉트)
  async redirects() {
    return [
      { source: "/policies/terms", destination: "/terms", permanent: false },
      { source: "/policies/privacy", destination: "/privacy", permanent: false },
      { source: "/policies/refund", destination: "/refund-policy", permanent: false },
    ];
  },
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
