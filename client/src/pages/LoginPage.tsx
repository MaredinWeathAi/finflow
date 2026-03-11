import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'

export function LoginPage() {
  const navigate = useNavigate()
  const [isRegister, setIsRegister] = useState(false)
  const [name, setName] = useState('')
  const [username, setUsername] = useState('')
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const { login, register } = useAuthStore()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      if (isRegister) {
        await register(name, identifier, password, username || undefined)
      } else {
        await login(identifier, password)
      }
      navigate('/', { replace: true })
    } catch (err: any) {
      setError(err.message || 'Authentication failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-primary flex items-center justify-center mx-auto mb-4">
            <span className="text-primary-foreground font-bold text-2xl">F</span>
          </div>
          <h1 className="text-3xl font-bold tracking-tight">FinBudget</h1>
          <p className="text-muted-foreground mt-2">Smart Budget Management</p>
        </div>

        <div className="bg-card rounded-2xl border border-border/50 p-6">
          <h2 className="text-lg font-semibold mb-4">
            {isRegister ? 'Create an account' : 'Welcome back'}
          </h2>

          {error && (
            <div className="mb-4 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {isRegister && (
              <>
                <div>
                  <label className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                    Full Name
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    className="mt-1.5 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                    placeholder="John Doe"
                    required
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                    Username (optional)
                  </label>
                  <input
                    type="text"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    className="mt-1.5 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                    placeholder="johndoe"
                  />
                </div>
              </>
            )}

            <div>
              <label className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                {isRegister ? 'Email' : 'Email or Username'}
              </label>
              <input
                type={isRegister ? 'email' : 'text'}
                value={identifier}
                onChange={e => setIdentifier(e.target.value)}
                className="mt-1.5 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                placeholder={isRegister ? 'you@example.com' : 'Email or username'}
                required
              />
            </div>

            <div>
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                  Password
                </label>
                {!isRegister && (
                  <Link
                    to="/forgot-password"
                    className="text-xs text-primary hover:text-primary/80 transition-colors"
                  >
                    Forgot password?
                  </Link>
                )}
              </div>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="mt-1.5 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                placeholder="••••••••"
                required
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full h-10 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {loading ? 'Please wait...' : isRegister ? 'Create Account' : 'Sign In'}
            </button>
          </form>

          <div className="mt-4 text-center">
            <button
              onClick={() => { setIsRegister(!isRegister); setError(''); setPassword(''); setIdentifier(''); setName(''); setUsername('') }}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              {isRegister
                ? 'Already have an account? Sign in'
                : "Don't have an account? Register"}
            </button>
          </div>
        </div>

        <p className="text-center text-xs text-muted-foreground mt-4">
          Secure budget management for you and your advisor
        </p>
      </div>
    </div>
  )
}
