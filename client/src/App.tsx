import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Toaster, toast } from 'sonner'
import { useAuthStore } from '@/stores/authStore'
import { onAuthEvent } from '@/lib/api'
import { ForcePasswordChange } from '@/components/auth/ForcePasswordChange'
import { AppLayout } from '@/components/layout/AppLayout'
import { StatementPrintPage } from '@/pages/StatementPrintPage'
import { LoginPage } from '@/pages/LoginPage'
import { ForgotPasswordPage } from '@/pages/ForgotPasswordPage'
import { DashboardPage } from '@/pages/DashboardPage'
import { TransactionsPage } from '@/pages/TransactionsPage'
import { BudgetsPage } from '@/pages/BudgetsPage'
import { AccountsPage } from '@/pages/AccountsPage'
import { RecurringPage } from '@/pages/RecurringPage'
import { CashFlowPage } from '@/pages/CashFlowPage'
import { GoalsPage } from '@/pages/GoalsPage'
import { ReportsPage } from '@/pages/ReportsPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { InsightsPage } from '@/pages/InsightsPage'
import { UploadPage } from '@/pages/UploadPage'
import { CategoriesPage } from '@/pages/CategoriesPage'
import { RulesPage } from '@/pages/RulesPage'
import { AdminDashboardPage } from '@/pages/AdminDashboardPage'
import { InvestmentsPage } from '@/pages/InvestmentsPage'
import { AdminClientsPage } from '@/pages/AdminClientsPage'
import { AdminClientDetailPage } from '@/pages/AdminClientDetailPage'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading, mustChangePassword } = useAuthStore()

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (!isAuthenticated) return <Navigate to="/login" replace />

  // The server blocks every route for a flagged account; render the only screen
  // that will actually work rather than a wall of failed requests.
  if (mustChangePassword) return <ForcePasswordChange />

  return <>{children}</>
}

function AdminRoute({ children }: { children: React.ReactNode }) {
  const { isAdmin, isLoading } = useAuthStore()

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (!isAdmin) return <Navigate to="/" replace />
  return <>{children}</>
}

export default function App() {
  const checkAuth = useAuthStore(s => s.checkAuth)
  const setMustChangePassword = useAuthStore(s => s.setMustChangePassword)

  useEffect(() => {
    checkAuth()
  }, [checkAuth])

  // React to auth transitions raised by any in-flight request, so a revoked
  // session or a newly-flagged account takes effect immediately instead of on
  // the next full page load.
  useEffect(() => {
    return onAuthEvent(event => {
      if (event === 'SESSION_REVOKED') {
        toast.error('Your session ended. Please sign in again.')
        void checkAuth()
      } else if (event === 'PASSWORD_CHANGE_REQUIRED') {
        setMustChangePassword(true)
      }
    })
  }, [checkAuth, setMustChangePassword])

  return (
    <BrowserRouter>
      <Toaster
        position="top-right"
        toastOptions={{
          style: {
            background: 'hsl(240 25% 9%)',
            border: '1px solid hsl(240 10% 18%)',
            color: 'hsl(0 0% 95%)',
          },
        }}
      />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        {/* Printable statement: deliberately outside AppLayout — it is a
            document, not a screen, so it gets no sidebar and no dark theme. */}
        <Route
          path="/reports/print"
          element={<ProtectedRoute><StatementPrintPage /></ProtectedRoute>}
        />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route
          element={
            <ProtectedRoute>
              <AppLayout />
            </ProtectedRoute>
          }
        >
          <Route path="/" element={<DashboardPage />} />
          <Route path="/insights" element={<InsightsPage />} />
          <Route path="/upload" element={<UploadPage />} />
          <Route path="/transactions" element={<TransactionsPage />} />
          <Route path="/categories" element={<CategoriesPage />} />
          <Route path="/rules" element={<RulesPage />} />
          <Route path="/budgets" element={<BudgetsPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/investments" element={<InvestmentsPage />} />
          <Route path="/recurring" element={<RecurringPage />} />
          <Route path="/cashflow" element={<CashFlowPage />} />
          <Route path="/goals" element={<GoalsPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          {/* Admin Routes */}
          <Route path="/admin" element={<AdminRoute><AdminDashboardPage /></AdminRoute>} />
          <Route path="/admin/clients" element={<AdminRoute><AdminClientsPage /></AdminRoute>} />
          <Route path="/admin/clients/:clientId" element={<AdminRoute><AdminClientDetailPage /></AdminRoute>} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
