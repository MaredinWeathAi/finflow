import { create } from 'zustand'
import { api } from '@/lib/api'
import type { User } from '@/types'

interface AuthState {
  user: User | null
  isLoading: boolean
  isAuthenticated: boolean
  isAdmin: boolean
  login: (identifier: string, password: string) => Promise<void>
  register: (name: string, email: string, password: string, username?: string) => Promise<void>
  logout: () => void
  checkAuth: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: true,
  isAuthenticated: false,
  isAdmin: false,

  login: async (identifier, password) => {
    const res = await api.post<{ token: string; user: User }>('/auth/login', { email: identifier, password })
    localStorage.setItem('finbudget_token', res.token)
    set({ user: res.user, isAuthenticated: true, isAdmin: res.user.role === 'admin' })
  },

  register: async (name, email, password, username) => {
    const res = await api.post<{ token: string; user: User }>('/auth/register', { name, email, password, username })
    localStorage.setItem('finbudget_token', res.token)
    set({ user: res.user, isAuthenticated: true, isAdmin: res.user.role === 'admin' })
  },

  logout: () => {
    localStorage.removeItem('finbudget_token')
    set({ user: null, isAuthenticated: false, isAdmin: false })
  },

  checkAuth: async () => {
    const token = localStorage.getItem('finbudget_token')
    if (!token) {
      set({ isLoading: false, isAuthenticated: false })
      return
    }
    try {
      const user = await api.get<User>('/auth/me')
      set({ user, isAuthenticated: true, isAdmin: user.role === 'admin', isLoading: false })
    } catch {
      localStorage.removeItem('finbudget_token')
      set({ user: null, isAuthenticated: false, isAdmin: false, isLoading: false })
    }
  },
}))
