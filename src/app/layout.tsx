import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Providers } from "@/components/Providers";
import { TauriVisualFX } from "@/components/TauriVisualFX";
import "./globals.css";
// katex 样式已并入 globals.css 顶部 @import(见该文件),
// 单独在此 import 会让 root layout 挂两个 css chunk —— 触发 Next 14.2 的
// css-entry 关联 bug: 后一个 chunk 挤掉 globals.css, HTML 拿不到 Tailwind 全站裸奔。

// MiSans 不走 next/font(全量 woff2 会被 preload ~18MB):
// 改用 public 静态分片 + :root --font-sans 系统栈,
// 全平台统一 MiSans 观感(免费商用), 设备装有 MiSans 时命中本地零下载。
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "aichatt",
  description: "个人生活助手:多模型对话打底,出行、闲鱼行情、待办、写作与学习闭环全内置。",
  // PWA 清单: 添加到主屏幕后 standalone 全屏运行,
  // 配合 viewport-fit=cover + globals.css 的 --sat/--sab 安全区变量
  manifest: "/manifest.json",
  icons: {
    icon: "/icons/icon-192.png",
    apple: "/icons/icon-180.png",
  },
  // iOS 添加到主屏幕后,以 standalone 模式运行,顶部状态栏样式(translucent 需要配合 viewport-fit=cover)
  appleWebApp: {
    capable: true,
    title: "aichatt",
    statusBarStyle: "black-translucent",
  },
  formatDetection: {
    telephone: false,
  },
};

/**
 * 移动端 viewport 配置。
 * - viewportFit: 'cover' 是解锁 env(safe-area-inset-*) 的前提
 * - maximumScale: 5 保留用户缩放能力(无障碍要求)
 * - themeColor 分浅/深色,匹配系统浏览器顶部栏
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f5f7" },
    { media: "(prefers-color-scheme: dark)", color: "#0c0c0d" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {/* Chrome 新版 PWA 规范标签(仅写 apple-mobile-web-app-capable 会报 deprecated 警告);
            旧 iOS 标签仍由 metadata.appleWebApp 自动生成,两者并存 */}
        <meta name="mobile-web-app-capable" content="yes" />
        {/* MiSans 子集分片: public 静态直出, unicode-range 按需拉 woff2。
            不走 CSS @import/webpack(1500+ font-face 会拖垮 dev server);
            全平台统一 MiSans 观感, 设备装有 MiSans 时浏览器不会下载分片 */}
        {['100', '300', '400', '500', '600'].map((w) => (
          <link
            key={w}
            rel="stylesheet"
            href={`/fonts-subset/${w}/result.css`}
          />
        ))}
        {/* 数字等宽子集: 只盖 U+30-39 共 3.5KB, 治流式输出数字宽度抖动
            (生成配方与选型对比见 fonts-subset/digits/digits.css 头注释) */}
        <link rel="stylesheet" href="/fonts-subset/digits/digits.css" />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                // 1. 外观同步(与 src/lib/theme.ts 的 readAppearance/applyAppearance 等价)
                try {
                  // 样式维度(html[data-style]): 显式存 classic / google,未知值/缺省
                  // 一律 bigsur(trial 默认新样式),与 theme.ts 的 readStoredStyle 一致。
                  // 必须在首帧前写好,否则样式块会晚一拍闪成别的样子。
                  var uiStyle = localStorage.getItem('uiStyle');
                  document.documentElement.setAttribute('data-style',
                    uiStyle === 'classic' || uiStyle === 'google' ? uiStyle : 'bigsur');
                  var pal = localStorage.getItem('palette');
                  if (pal === 'dusk') pal = 'grid';          // 废弃配色,并入格子
                  if (pal === 'wallpaper') {
                    // 壁纸主题: 明暗走自己的子档(light/dark/system,缺省跟随系统),
                    // 与 theme.ts 的 readStoredWallpaperScheme 一致。
                    // data-wallpaper 是壁纸层显隐的唯一判据 —— 首帧不写会先闪一帧无壁纸。
                    var ws = localStorage.getItem('wallpaperScheme');
                    var wsDark = ws === 'dark'
                      || (ws !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
                    if (wsDark) document.documentElement.classList.add('dark');
                    document.documentElement.setAttribute('data-wallpaper', 'on');
                    pal = 'base';
                  } else if (pal === 'grid') {
                    // 四个光态里只有「晚上」是深底: 它是格子下唯一写 .dark 的态
                    // (日出/白天/暮色都是浅底,一律不写)
                    // (下游组件靠 .dark 判明暗),深底 token 由
                    // [data-pal="grid"][data-grid-tone="night"] 压制 .dark。
                    // 取值白名单与 theme.ts 的 readAppearance 保持一致(逐个列出),
                    // 漏写新光态会让它首帧回落成白天、闪一次。
                    // 'auto' = 智能选择: 这里必须把时段表照抄一遍(首帧脚本不能 import
                    // theme.ts 的 resolveAutoTone),改动务必同步两处。
                    var t = localStorage.getItem('gridTone');
                    var tone;
                    if (t === 'auto') {
                      var d = new Date(), hh = d.getHours() + d.getMinutes() / 60;
                      tone = hh >= 5 && hh < 8 ? 'dawn'
                           : hh >= 8 && hh < 17 ? 'day'
                           : hh >= 17 && hh < 19.5 ? 'dusk'
                           : 'night';
                    } else {
                      tone = (t === 'dawn' || t === 'dusk' || t === 'night') ? t : 'day';
                    }
                    document.documentElement.setAttribute('data-grid-tone', tone);
                    if (tone === 'night') document.documentElement.classList.add('dark');
                    document.documentElement.setAttribute('data-wallpaper', 'off');
                  } else {
                    var theme = localStorage.getItem('theme');
                    if (theme === 'dark' || (!theme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
                      document.documentElement.classList.add('dark');
                    }
                    if (pal === 'guihua') pal = 'base';                           // 桂花金已删除,存量值回落
                    else pal = 'base';                                            // 未知值回落
                    document.documentElement.setAttribute('data-wallpaper', 'off');
                  }
                  // 配色属性必须赶在首次绘制前写好: 配色 token 与主题专属元素
                  // (.grid-dawn/.grid-day/.grid-night/.grid-nightfall)的显隐全由它驱动,
                  // 晚一拍会看到基线配色闪一下。
                  document.documentElement.setAttribute('data-pal', pal);
                } catch (e) {}

                // 2. Tauri 桌面壳检测 + 手动注入 data-tauri 属性
                //    （Tauri 2 不会自动加这个属性到 <html>，需要我们手动写）
                //    UA 含 Android 的是手机壳：它要移动端形态，桌面专属样式
                //    （.tauri-only 红绿灯/拖拽区、html 圆角裁剪）一律不挂上。
                if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
                    && !/android/i.test(navigator.userAgent)) {
                  document.documentElement.setAttribute('data-tauri', '');
                }
              })();
            `,
          }}
        />
      </head>
      <body
        className={`${geistMono.variable} font-sans antialiased bg-background text-foreground`}
      >
        <Providers>
          {/* Tauri/Web 双端统一结构:不再渲染自定义标题栏,浏览器/原生窗口各自负责头部控件。
              app-viewport / app-viewport-body 是打印豁免链的成员(papers/composed 的
              PRINT_GLOBAL_CSS 按这些类名解除裁剪),改名/换结构前先对齐那边的名单 */}
          <div className="app-viewport flex h-screen flex-col overflow-hidden">
            <div className="app-viewport-body flex-1 overflow-hidden">{children}</div>
          </div>
          {/* 客户端专属视觉增强(失焦降饱和灰罩 + 毛玻璃同步);Web 端渲染 null */}
          <TauriVisualFX />
        </Providers>
      </body>
    </html>
  );
}
