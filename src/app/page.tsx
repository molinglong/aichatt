'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function HomePage() {
  const router = useRouter()

  useEffect(() => {
    // 重定向到学习台(首页 = student 学习台)。replace 而非 push:留着 '/' 这条历史等于给「返回」挖坑
    // (返回到 '/' 又立刻被推回 /study,表现为返回键失灵)
    router.replace('/study')
  }, [router])

  return null
}
