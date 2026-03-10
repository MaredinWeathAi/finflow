import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { MobileNav } from './MobileNav'
import { QuickAddFAB } from '../shared/QuickAddFAB'

export function AppLayout() {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 min-w-0">
        <div className="max-w-[1100px] mx-auto px-4 sm:px-6 lg:px-8 py-6 pb-24 lg:pb-6">
          <Outlet />
        </div>
      </main>
      <MobileNav />
      <QuickAddFAB />
    </div>
  )
}
