import { useState } from 'react'
import { ShieldAlert, Loader2 } from 'lucide-react'
import { useAuthStore } from '@/stores/authStore'
import { assessPassword } from '@/lib/passwordPolicy'
import { PasswordStrength } from './PasswordStrength'

/**
 * Full-screen gate shown when the server reports PASSWORD_CHANGE_REQUIRED.
 *
 * This fires when an account is still using a password that matched a known
 * default (the historical `demo123` / `password123` seeds). The server blocks
 * every route except this flow, so there is nothing to navigate to until the
 * password is changed.
 */
export function ForcePasswordChange() {
  const changePassword = useAuthStore(s => s.changePassword)
  const logout = useAuthStore(s => s.logout)
  const email = useAuthStore(s => s.user?.email)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const assessment = assessPassword(newPassword, email)
  const canSubmit =
    !!currentPassword && assessment.ok && newPassword === confirmPassword && !loading

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (newPassword !== confirmPassword) {
      setError('The two new passwords do not match')
      return
    }
    setLoading(true)
    try {
      await changePassword(currentPassword, newPassword)
    } catch (err: any) {
      setError(err.message || 'Could not change the password')
    } finally {
      setLoading(false)
    }
  }

  const inputClass =
    'mt-1.5 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm ' +
    'focus:outline-none focus:ring-2 focus:ring-primary/50'
  const labelClass = 'text-sm font-medium text-muted-foreground uppercase tracking-wider'

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">
        <div className="bg-card rounded-2xl border border-destructive/30 overflow-hidden">
          <div className="bg-destructive/10 border-b border-destructive/20 p-5 flex gap-3">
            <ShieldAlert className="w-6 h-6 text-destructive shrink-0 mt-0.5" aria-hidden />
            <div>
              <h1 className="font-semibold text-base">Password change required</h1>
              <p className="text-sm text-muted-foreground mt-1">
                This account is using a password that was shipped as a default in an
                earlier build, so it was publicly guessable. Access is blocked until
                you set a new one. All other sessions have already been signed out.
              </p>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="p-5 space-y-4">
            {error && (
              <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm" role="alert">
                {error}
              </div>
            )}

            <div>
              <label className={labelClass} htmlFor="fpc-current">Current password</label>
              <input
                id="fpc-current"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={e => setCurrentPassword(e.target.value)}
                className={inputClass}
                required
              />
            </div>

            <div>
              <label className={labelClass} htmlFor="fpc-new">New password</label>
              <input
                id="fpc-new"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                className={inputClass}
                required
              />
              <PasswordStrength password={newPassword} email={email} />
            </div>

            <div>
              <label className={labelClass} htmlFor="fpc-confirm">Confirm new password</label>
              <input
                id="fpc-confirm"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                className={inputClass}
                required
              />
              {confirmPassword && newPassword !== confirmPassword && (
                <p className="mt-1.5 text-xs text-destructive">Passwords do not match</p>
              )}
            </div>

            <button
              type="submit"
              disabled={!canSubmit}
              className="w-full h-10 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:bg-primary/90 transition-colors disabled:opacity-50 inline-flex items-center justify-center gap-2"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" aria-hidden />}
              {loading ? 'Updating…' : 'Set new password'}
            </button>

            <button
              type="button"
              onClick={() => { void logout() }}
              className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Sign out instead
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
