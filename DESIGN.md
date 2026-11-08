# DESIGN.md — aichatt UI 审美准则

> UI 决策最高依据,工作流程规则见 AGENTS.md。改本文档需用户确认。
> 颜色体系为 RGB 三元组,一律写 `rgb(var(--token) / alpha)`。

## 一、禁令(违反 = 返工)

1. **禁 emoji 当图标**。图标用 SVG / 项目现有 icon 体系。
2. **禁裸 hex / rgba 颜色**,一律走 token(`rgb(var(--token) / α)`)。例外仅限已有定稿:代码块 hljs 主题、`--slider-grad` 渐变、`--glow-rgb`。
3. **禁新造色相**。强调色只用 `--accent` 组,危险色只用 `--danger` 组。想加新颜色 = 先停下来问用户。
4. **禁装饰性渐变**(廉价感最大公约数)。渐变仅限已有定稿(如推理档位滑杆)。
5. **禁 accent 大面积平铺**(廉价感来源①)。accent 只给主 CTA、选中态、交互态,不满屏。
6. **禁随手圆角**。桌面走 `--radius-control/card/panel/sheet` 四档;手机端收敛 12 / 20 / 全圆 三档。出现档位之外的值 = 错(廉价感来源③)。
7. **禁内容层阴影**。环与影只给真浮层:composer 输入岛、右滑面板、弹窗、上下文菜单。
8. **灰阶至少三级**:主文本 `--content-primary` / 次要 `--content-secondary` / 弱化 `--content-muted`。元信息不许比 secondary 更浅(廉价感来源④:60% 灰元信息)。
9. **禁 !important 压覆盖链**,用特异性组织(踩坑定案:特异性 0,2,0 足够压 Tailwind 工具类)。
10. **禁停靠面板实心化**:「不悬浮」压的是外形(margin / 圆角卡 / 投影),半透明 + blur 材质必须保留。
11. **禁半透明灰面叠白纸**(必偏浅,已三连踩)。通铺灰面/玻璃卡一律纯 `--surface-muted` 不透明;半透明口径仅限壁纸模式。

## 二、定案(已验收口径,动手前先对表)

- 正文是白纸(`--surface`),chrome 是灰(`--surface-muted`);分界只靠 1px `--line` 发丝线,不叠装饰。
- 停靠面板(侧栏 / 设置导航 / 资料面板):贴边、无 margin、无环无影、纯 muted;可留右缘 1px 发丝线。
- 双环 `--glass-ring` + 双层窗影 `--shadow-window` 仅 bigsur、仅真浮层。
- 结构级分歧用组件分流(TopbarShell / useUiStyle 模式),禁 CSS 套壳硬拗。
- 动效只有四档时长 `--motion-micro/fast/base/slow` + 两条曲线 `--ease`(切换/出场)、`--ease-enter`(入场);新动画从这六项里选。
- 数字宽度抖动已由 'Noto Sans Digits' 子集接管(在 `--font-sans`),禁为此引新字体;新字体需求先问。
- 手机输入框 font-size ≥ 16px(防 iOS 聚焦缩放);设置面板按钮命中区 ≥ 40px、常规交互 ≥ 44px。
- 设置页组件统一出自 settings/primitives.tsx,禁在页面里另写一套卡/开关/分段控件。
- data-style 三维度 classic / bigsur / google 各有 accent 与圆角档;动 accent 或圆角必须三维度全验证。
- 每个视觉改动浅色 / 深色双态都要验证。

## 三、Token 对照(只许引用存在的;想加新的先问)

| 用途 | token |
|---|---|
| 页面底 / 正文 | `--background` / `--foreground` |
| 面板层级 | `--surface`(白纸) / `--surface-muted`(通铺灰) / `--surface-subtle`(深一档) |
| 边线 | `--line`(发丝) / `--line-strong` |
| 文本三级 | `--content-primary` / `--content-secondary` / `--content-muted` |
| 强调 | `--accent` / `--accent-hover` / `--accent-foreground` / `--accent-soft` |
| 危险 | `--danger` / `--danger-soft` |
| 圆角 | `--radius-control` / `--radius-card` / `--radius-panel` / `--radius-sheet` |
| 浮层(仅 bigsur) | `--shadow-window` / `--glass-ring` / `--glass-ring-float` |
| 动效 | `--motion-micro` 150ms / `--motion-fast` 180ms / `--motion-base` 260ms / `--motion-slow` 420ms;曲线 `--ease` / `--ease-enter` |
| 专用色板(禁挪用) | `--note-*`(便利贴) / `--exam-*`(试卷标注) / `--sent-*`(成分分析) / `--fest-gold`(节日点缀) |

圆角默认档:classic 12/16/28、bigsur 14/18/32、google 8/8/16(control 4)——token 名不变,值随 data-style 走。

## 四、交付自检清单

- [ ] 浅色 + 深色截图各一张
- [ ] classic / bigsur / google 三维度无串样式
- [ ] ≤767px 移动端过一眼
- [ ] 新 hex = 0,新圆角档 = 0,新阴影 = 0,新字体 = 0
