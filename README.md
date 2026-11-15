<div align="center">

# aichatt

**全栈 AI 生活助手 —— 一句问起，日常有着落，学习不断线。**

多模型对话 · 出行规划 · 闲鱼行情 · 待办 · 写作画布 · 学习闭环

[![Next.js](https://img.shields.io/badge/Next.js-14-black)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)](https://www.typescriptlang.org/)
[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB)](https://tauri.app/)
[![License](https://img.shields.io/badge/license-MIT-green)](#license)

[核心功能](#核心功能) · [快速开始](#快速开始) · [部署](#部署)

</div>

<!-- 截图建议：放 2 张图——欢迎页能力入口卡 + 学习台。没有截图时，首屏说服力会少一半。 -->

## 为什么是 aichatt

普通聊天工具解决“问一句答一句”；aichatt 是一个**个人生活助手**——聊天打底，把日常里要跑腿的事接住，学习则是管得最深的一条线：

- **对话 → 行动**：出行规划（火车票 / 路线）、闲鱼行情与实时监控、待办管理、写作画布，聊完直接落成结果
- **错题 → 复习**：错题一键入库，FSRS 调度下次复习时间，真题拟卷 / 练题 / 学校成绩分析成闭环
- **模型 → 对比**：同一问题并行对比多个模型，投票记录偏好
- **数据 → 自己**：Postgres + Docker + Tauri 桌面端，数据在自己手里

## 核心功能

- **多模型接入**：OpenAI / Anthropic / Google / DeepSeek 开箱即用，另支持 13+ 服务商适配与自定义 OpenAI 兼容端点
- **生活能力**：出行规划（地图卡片）、闲鱼行情与实时价监控、待办管理、全网平台定向搜索、MCP 工具接入（如 12306）
- **学习闭环**：对话生成结构化课程，错题一键入库，FSRS 间隔复习调度；真题题库拟卷、在线做题判分、学校考试成绩记录与分析
- **面具系统**：内置精选面具库 + 用户自定义人格（系统提示词 + few-shot + 风格预设）
- **长期记忆**：对话后自动提取记忆、矛盾自动替换、bigram 相关度注入；支持从 ChatGPT / Claude / Gemini 等导出记忆一键导入
- **对比模式**：同一轮提问并行对比多个模型回答，投票记录偏好
- **临时聊天模式**：访客密码进入隔离区，服务端强制隔离，借号不暴露主账号记忆
- **写作画布**：豆包式「帮我写作」全屏工作台，划词改写 / 目标字数 / AI 落稿
- **生图工作台**：文生图 / 以图生图 / 局部重绘，支持自定义 OpenAI 兼容生图端点
- **文件上传**：PDF 与文本解析注入上下文
- **流式恢复**：生成中断后重进可恢复，进程崩溃自动兜底
- **长对话摘要压缩**：接近上下文窗口时自动分代压缩，防止失忆

## 技术栈

Next.js 14 (App Router) · React 18 · TypeScript · Prisma 7 + PostgreSQL (driver adapter) · NextAuth v5 · Tailwind CSS · AI SDK · Zustand · React Query · Tauri 2 (桌面端) · Docker

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量（复制 .env.production.example 或自行创建 .env）
#    必填：DATABASE_URL、NEXTAUTH_SECRET、NEXTAUTH_URL

# 3. 初始化数据库（PostgreSQL）
npx prisma migrate deploy

# 4. 启动开发服务器
npm run dev
# 打开 http://localhost:3456
```

## 常用脚本

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 开发服务器（端口 3456） |
| `npm run build` / `npm start` | 生产构建 / 启动 |
| `npm run db:migrate` | Prisma 迁移（开发） |
| `npm run db:studio` | Prisma Studio 数据查看 |
| `npm run tauri:dev` | Tauri 桌面端开发模式 |
| `npm run tauri:build` | 构建 Tauri 桌面端 |

## 部署

提供 Docker 部署方案，详见 [DEPLOY.md](./DEPLOY.md) 与 [deploy/](./deploy/) 目录。

## 安全披露

如果你发现安全问题，请优先通过 **GitHub Security Advisory** 私下联系，不要在公开 Issue 中贴 PoC。确认后会尽快修复并在更新说明中致谢。

## License

MIT © 2026 molilong
