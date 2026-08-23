import { create } from 'zustand'
import { api, ApiError } from '@/lib/api'
import type { User } from '@/types'

interface AuthState {
  user: User | null
  isLoading: boolean
  isAuthenticated: boolean
  isAdmin: boolean
  /** Server has flagged this account: no route works until the password changes. */
  mustChangePassword: boolean
  login: (identifier: string, password: string) => Promise<void>
  register: (name: string, email: string, password: string, username?: string) => Promise<void>
  logout: () => Promise<void>
  checkAuth: () => Promise<void>
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>
  setMustChangePassword: (v: boolean) => void
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: true,
  isAuthenticated: false,
  isAdmin: false,
  mustChangePassword: false,

  login: async (identifier, password) => {
    const res = await api.post<{ token: string; user: User }>('/auth/login', { email: identifier, password })
    localStorage.setItem('finbudget_token', res.token)
    set({
      user: res.user,
      isAuthenticated: true,
      isAdmin: res.user.role === 'admin',
      mustChangePassword: !!(res.user as any).must_change_password,
    })
  },

  register: async (name, email, password, username) => {
    const res = await api.post<{ token: string; user: User }>('/auth/register', { name, email, password, username })
    localStorage.setItem('finbudget_token', res.token)
    set({ user: res.user, isAuthenticated: true, isAdmin: res.user.role === 'admin' })
  },

  logout: async () => {
    // Tell the server to bump this account's token version so every other
    // device/session is signed out too, not just this tab.
    try { await api.post('/auth/logout') } catch { /* offline or already invalid */ }
    localStorage.removeItem('finbudget_token')
    set({ user: null, isAuthenticated: false, isAdmin: false, mustChangePassword: false })
  },

  checkAuth: async () => {
    const token = localStorage.getItem('finbudget_token')
    if (!token) {
      set({ isLoading: false, isAuthenticated: false })
      return
    }
    try {
      const user = await api.get<User>('/auth/me')
      set({
        user,
        isAuthenticated: true,
        isAdmin: user.role === 'admin',
        mustChangePassword: !!(user as any).must_change_password,
        isLoading: false,
      })
    } catch (err) {
      // A 403 PASSWORD_CHANGE_REQUIRED means the token is valid but the account
      // is gated — stay authenticated so the change-password screen can render.
      if (err instanceof ApiError && err.code === 'PASSWORD_CHANGE_REQUIRED') {
        set({ isAuthenticated: true, mustChangePassword: true, isLoading: false })
        return
      }
      localStorage.removeItem('finbudget_token')
      set({ user: null, isAuthenticated: false, isAdmin: false, mustChangePassword: false, isLoading: false })
    }
  },

  changePassword: async (currentPassword, newPassword) => {
    const res = await api.put<{ message: string; token: string }>('/auth/change-password', {
      currentPassword,
      newPassword,
    })
    // The server rotated every session; adopt the fresh token for this tab.
    if (res.token) localStorage.setItem('finbudget_token', res.token)
    set({ mustChangePassword: false })
    const user = await api.get<User>('/auth/me')
    set({ user, isAuthenticated: true, isAdmin: user.role === 'admin' })
  },

  setMustChangePassword: (v) => set({ mustChangePassword: v }),
}))
