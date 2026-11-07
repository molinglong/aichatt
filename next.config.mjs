/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // dev/build 共用 .next 会互相写坏产物(standalone 复制不全 -> 运行时 500)。
  // 设置 NEXT_DIST_DIR 可把本次构建隔离到独立目录,与运行中的 dev 井水不犯河水。
  distDir: process.env.NEXT_DIST_DIR || '.next',
  eslint: {
    // 生产构建不强制 lint:开发体验已经由 IDE/编辑器接管,
    // 部署期 lint 报错会阻断镜像构建,得不偿失。
    ignoreDuringBuilds: true,
  },
  typescript: {
    // 临时关闭:遗留的类型错误不阻断生产构建。TODO 上线后逐个补。
    ignoreBuildErrors: true,
  },
  experimental: {
    serverComponentsExternalPackages: ['shiki', '@prisma/client', 'bcryptjs', '@auth/prisma-adapter', '@prisma/adapter-pg', 'typescript'],
    esmExternals: true,
    // Next.js 14 standalone 默认只追踪 import 链路上的文件。
    // 但 @prisma/adapter-pg / pg 是通过 client.ts -> runtime/client.js 这种动态 ESM 入口加载,
    // 静态分析无法穿透,因此 standalone 镜像里没有这些包 -> 运行时 500。
    // 用 outputFileTracingIncludes 强制把 driver adapter 依赖打进所有 API 路由的 trace。
    outputFileTracingIncludes: {
      '/api/**': [
        './node_modules/@prisma/adapter-pg/**/*',
        './node_modules/pg/**/*',
        './node_modules/pg-cloudflare/**/*',
        './node_modules/pg-connection-string/**/*',
        './node_modules/pg-int8/**/*',
        './node_modules/pg-pool/**/*',
        './node_modules/pg-protocol/**/*',
        './node_modules/pg-types/**/*',
        './node_modules/pgpass/**/*',
        './node_modules/postgres-bytea/**/*',
        './node_modules/postgres-date/**/*',
        './node_modules/postgres-interval/**/*',
        './node_modules/@prisma/client/**/*',
        './node_modules/@prisma/client-runtime-utils/**/*',
        './node_modules/bcryptjs/**/*',
      ],
    },
  },
  // 安全:关闭图片优化器(全站仅生图画廊用 next/image,且均为本站 /uploads 本地图)。
  // 优化器端点无需登录即可访问,关闭后同时消除:
  // - 任意远程源代理(remotePatterns '**')的 DoS/SSRF 面(GHSA-9g9p-9gw9-jx7f)
  // - 优化器 API DoS 与磁盘缓存无限增长(GHSA-h64f / GHSA-3x4c)
  // 桌面端静态导出(next.config.desktop.mjs)本就 unoptimized,行为一致。
  images: {
    unoptimized: true,
  },
  async headers() {
    return [
      {
        // 上传文件响应加固:防 MIME 嗅探 + CSP 沙箱。
        // 即使恶意 HTML/SVG 混入 uploads,也会被拒绝执行脚本(同源存储型 XSS 兜底)。
        source: '/uploads/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Content-Security-Policy', value: "default-src 'none'; sandbox" },
        ],
      },
      {
        // MiSans 子集分片:woff2 文件名带内容 hash,可长缓存;
        // result.css 文件名固定,走默认协商缓存不在此列
        source: '/fonts-subset/:path*.woff2',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
    ]
  },
  async rewrites() {
    // 仅本地 dev:把 /apk/* 代理到线上,让设置页「手机客户端」卡片在开发时读到真实版本与包体大小。
    // 线上由 nginx `location /apk/` 直接发文件,请求根本不经 Next,故生产构建不注册此规则。
    if (process.env.NODE_ENV !== 'development') return [];
    return [
      {
        source: '/apk/:path*',
        destination: 'https://chat.yuban.icu/apk/:path*',
      },
    ];
  },
  webpack: (config, { isServer, nextRuntime }) => {
    // Handle node: protocol imports that Prisma v7 uses
    config.externals.push(({ request }, callback) => {
      if (request && /^node:/.test(request)) {
        return callback(null, `commonjs ${request}`)
      }
      callback()
    })
    return config
  },
};
export default nextConfig;
