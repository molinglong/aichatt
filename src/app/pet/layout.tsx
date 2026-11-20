// /pet 布局:绝不能在这里渲染 <html>/<body> —— Next 嵌套 layout 会把它们嵌进
// root layout 的 body 里,浏览器解析时剥掉嵌套标签,直接水合不匹配
// (2026-11-19 实测; buddy/layout.tsx 的同款写法在它被禁用前应有同款隐患)。
// 背景复位由 page 内联 <style !important> 完成;样式全在 pet.module.css,不吃 Tailwind。
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: '桌面小鸡',
  description: '任务栏上沿的桌面小鸡',
}

export default function PetLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <>{children}</>
}
