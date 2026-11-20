/**
 * 蜡笔小鸡 · 蛋壳宝宝(2026-11-18 拍板 C 案):破壳而出造型,双手扒壳沿 + 蛋壳彩点。
 * 经 design/preview-chick-redesign.html 三轮挑选定稿:呆毛接顶、竖椭圆双高光眼、
 * 豆瓣小喙、对称双翅。徽章/弹层/覆盖层/过场/学习台书桌共用;
 * 壁纸 ChickSkyScene 已同步同款。身体 #fff0b8、描边 #e8a23c 不变。
 * 壳点口径(2026-11-19):用户要求监管模式统一去蓝,蓝点 #9fc3e0 → 蜡笔黄 #ffd75e;
 * 壁纸 ChickSkyScene(蜡笔蓝天空主题)的同款蓝点未动,属壁纸拟真配色。
 * 原件内嵌在 FocusLock.tsx,2026-11-18 抽出共用(学习台「小鸡书桌」主页也要用,
 * 直接 import FocusLock 会把 tauri 依赖链带进学习页,故独立成文件)。
 */
export function CrayonChick({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" fill="none" aria-hidden className={className}>
      <path d="M27 18.8 l2.4 -5.8 3 5.2" stroke="#e8a23c" strokeWidth={2.4} strokeLinecap="round" />
      <path d="M34.5 18.6 l3.4 -5.6 1.6 6" stroke="#e8a23c" strokeWidth={2.2} strokeLinecap="round" />
      <ellipse cx="32" cy="34" rx="18.5" ry="15.5" fill="#fff0b8" />
      <ellipse cx="32" cy="34" rx="18.5" ry="15.5" stroke="#e8a23c" strokeWidth={2.2} />
      <path d="M13.5 38 q-4.5 1.5 -3 5.5 q1.5 3.5 5.5 3" stroke="#e8a23c" strokeWidth={2} strokeLinecap="round" />
      <path d="M50.5 38 q4.5 1.5 3 5.5 q-1.5 3.5 -5.5 3" stroke="#e8a23c" strokeWidth={2} strokeLinecap="round" />
      <ellipse cx="26.8" cy="31.2" rx="2.2" ry="2.7" fill="#4a3a28" />
      <circle cx="27.6" cy="30.2" r=".85" fill="#ffffff" />
      <circle cx="26" cy="32.4" r=".45" fill="#ffffff" opacity={0.75} />
      <ellipse cx="37.2" cy="31.2" rx="2.2" ry="2.7" fill="#4a3a28" />
      <circle cx="38" cy="30.2" r=".85" fill="#ffffff" />
      <circle cx="36.4" cy="32.4" r=".45" fill="#ffffff" opacity={0.75} />
      <ellipse cx="20.8" cy="36.5" rx="3.9" ry="2.5" fill="#ffb3a0" />
      <ellipse cx="43.2" cy="36.5" rx="3.9" ry="2.5" fill="#ffb3a0" />
      <path d="M29.7 35.4 q2.4 -2 4.7 0 q-.85 2.5 -2.35 2.5 q-1.5 0 -2.35 -2.5 z" fill="#ff9a5c" />
      <path d="M13.5 44 q4.7 -4.2 9.6 0 q4.9 4.2 9.7 0 q4.7 -4.2 9.6 0 q4.8 4.2 9.6 0 l-.4 6.5 q-.5 6.5 -7.5 6.5 h-22.8 q-7 0 -7.5 -6.5 z" fill="#fffdf6" stroke="#e8a23c" strokeWidth={2.2} strokeLinejoin="round" />
      <circle cx="26" cy="52" r="1.5" fill="#ffb3a0" opacity={0.8} />
      <circle cx="37" cy="54" r="1.2" fill="#ffd75e" opacity={0.75} />
    </svg>
  )
}
