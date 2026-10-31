import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: 'class',
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // 基础
        background: "rgb(var(--background) / <alpha-value>)",
        foreground: "rgb(var(--foreground) / <alpha-value>)",
        // 面板层级
        surface: {
          DEFAULT: "rgb(var(--surface) / <alpha-value>)",
          muted: "rgb(var(--surface-muted) / <alpha-value>)",
          subtle: "rgb(var(--surface-subtle) / <alpha-value>)",
          // 毛玻璃：透明度固定烘焙在 0.72，不参与修饰符叠加
          glass: "rgb(var(--surface-glass) / 0.72)",
        },
        // 边框
        line: {
          DEFAULT: "rgb(var(--line) / <alpha-value>)",
          strong: "rgb(var(--line-strong) / <alpha-value>)",
        },
        // 文本层级
        content: {
          primary: "rgb(var(--content-primary) / <alpha-value>)",
          secondary: "rgb(var(--content-secondary) / <alpha-value>)",
          muted: "rgb(var(--content-muted) / <alpha-value>)",
        },
        // 强调色（中灰体系）
        accent: {
          DEFAULT: "rgb(var(--accent) / <alpha-value>)",
          hover: "rgb(var(--accent-hover) / <alpha-value>)",
          foreground: "rgb(var(--accent-foreground) / <alpha-value>)",
          soft: "rgb(var(--accent-soft) / <alpha-value>)",
        },
        // 危险语义色（弹窗三通道：错误卡描边 / 确认框 danger 主按钮）
        danger: {
          DEFAULT: "rgb(var(--danger) / <alpha-value>)",
          soft: "rgb(var(--danger-soft) / <alpha-value>)",
        },
        // 代码块
        code: {
          header: "rgb(var(--code-header) / <alpha-value>)",
          bg: "rgb(var(--code-bg) / <alpha-value>)",
        },
      },
      borderRadius: {
        // 语义圆角（2026-10-22 第零波，预览见 public/preview-ui-tokens.html）。
        // 只加别名，不改既有 rounded-* 的视觉：control 8 / card 12 / panel 16 / sheet 28；
        // 胶囊仍用 rounded-full。迁移时按角色替换，不按数值全局 codemod。
        // 2026-10-24 trial: 改为引用 CSS 变量(带原值兜底) —— html[data-style="bigsur"]
        // 整组抬一档圆角(globals.css),组件层零改动。
        control: "var(--radius-control, 0.5rem)",
        card: "var(--radius-card, 0.75rem)",
        panel: "var(--radius-panel, 1rem)",
        sheet: "var(--radius-sheet, 1.75rem)",
      },
      transitionDuration: {
        // 动效时长四档（2026-10-31 全站统一定稿，口径见 globals.css --motion-*）：
        // micro 颜色/透明度反馈 / fast 按压与小浮层 / base 面板与折叠 / slow 抽屉位移。
        // DEFAULT 必须是 micro：.transition-colors 等不写 duration-* 的工具类全吃 DEFAULT，
        // 这一处等于全站 400+ 处颜色过渡的时长基准。
        DEFAULT: "150ms",
        micro: "150ms",
        fast: "180ms",
        base: "260ms",
        slow: "420ms",
      },
      transitionTimingFunction: {
        // 曲线只留两条：standard 管所有状态切换与出场，enter 只管"从无到有"的入场。
        // DEFAULT 必须与 standard 同值 —— 未写 ease-* 的过渡类全部吃 DEFAULT，
        // 改这一处就把 400+ 处颜色过渡从 Tailwind 原曲线一次性归位。
        // pop 是 standard 的旧别名，保留仅为兼容存量调用点。
        DEFAULT: "cubic-bezier(0.32, 0.72, 0.28, 1)",
        standard: "cubic-bezier(0.32, 0.72, 0.28, 1)",
        enter: "cubic-bezier(0.16, 1, 0.3, 1)",
        pop: "cubic-bezier(0.32, 0.72, 0.28, 1)",
      },
      fontFamily: {
        sans: ['var(--font-sans)', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        mono: ['var(--font-geist-mono)', 'ui-monospace', 'monospace'],
      },
      keyframes: {
        // 发送按钮由禁用变为可用时的轻微弹入
        'pop-in': {
          '0%': { transform: 'scale(0.85)' },
          '60%': { transform: 'scale(1.06)' },
          '100%': { transform: 'scale(1)' },
        },
      },
      animation: {
        'pop-in': 'pop-in 240ms ease-out',
      },
    },
  },
  plugins: [],
};
export default config;
