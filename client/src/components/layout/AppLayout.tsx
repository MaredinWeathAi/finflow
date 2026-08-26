import { Outlet, useLocation } from 'react-router-dom'
import { ErrorBoundary } from '@/components/shared/ErrorBoundary'
import { Sidebar } from './Sidebar'
import { MobileNav } from './MobileNav'
import { QuickAddFAB } from '../shared/QuickAddFAB'

export function AppLayout() {
  const { pathname } = useLocation()
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 min-w-0">
        <div className="max-w-[1100px] mx-auto px-4 sm:px-6 lg:px-8 py-6 pb-24 lg:pb-6">
          {/* Per-page boundary: a render error on one screen must not unmount
              the whole app. Keyed on the path so navigating away resets it. */}
          <ErrorBoundary key={pathname}>
            <Outlet />
          </ErrorBoundary>
        </div>
      </main>
      <MobileNav />
      <QuickAddFAB />
    </div>
  )
}
