# AGENTS.md — aichatt 工作流规则

UI 审美细则见 DESIGN.md;两者冲突时以 DESIGN.md 为准。

## UI 改动流程(硬性)

1. **先原型后落码**:可见 UI 改动,先在 `design/` 下出 HTML 多方案原型(同一 DOM 切方案类,参照 outline-redesign-v2.html / preview-*.html 的做法)给用户挑稿,禁止直接改码。
2. **落 3456 验收**:挑中的方案直接落正式项目(dev 端口 3456)给用户验收。纯文档 / 构建脚本改动免走此流程。
3. **截图自检**:任何 UI 交付前,开浏览器对 3456 截图,浅 / 深双态 + 桌面 / 移动端,自己挑刺修完再报完成;没有截图自检不许说「已完成」。

## 环境红线

- 端口:3456 = 正式 dev。**build 会杀运行中的 dev server**,build 前先停 dev。
- 改 prisma schema 后 `prisma generate` 必须重启 dev server。
- dev server 用 PowerShell 分离进程启动(挂在会话后台任务里的 npm 会被回收)。
- **部署必须用户发起或确认**,禁止自行部署 VPS。
