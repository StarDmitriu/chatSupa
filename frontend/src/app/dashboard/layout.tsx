'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { DashboardHeader } from '@/components/DashboardHeader'
import './dashboard-layout.css'

function DashboardHeaderGate() {
  const sp = useSearchParams()
  const embed = (sp.get('embed') || '').trim() === '1'
  return embed ? null : <DashboardHeader />
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
      <div className="dashboard-layout">
        <Suspense fallback={null}>
          <DashboardHeaderGate />
        </Suspense>
        {children}
      </div>
  )
}
