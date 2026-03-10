import { create } from 'zustand'
import { api } from '@/lib/api'
import type { User } from '@/types'

interface AuthState {
  user: User | null
  isLoading: boolean
  isAuthenticated: boolean
  login: (email: string, password: string) => Promise<void>
  register: (name: string, email: string, password: string) => Promise<void>
  logout: () => void
  checkAuth: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: true,
  isAuthenticated: false,

  login: async (email, password) => {
    const res = await api.post<{ token: string; user: User }>('/auth/login', { email, password })
    localStorage.setItem('finflow_token', res.token)
    set({ user: res.user, isAuthenticated: true })
  },

  register: async (name, email, password) => {
    const res = await api.post<{ token: string; user: User }>('/auth/register', { name, email, password })
    localStorage.setItem('finflow_token', res.token)
    set({ user: res.user, isAuthenticated: true })
  },

  logout: () => {
    localStorage.removeItem('finflow_token')
    set({ user: null, isAuthenticated: false })
  },

  checkAuth: async () => {
    const token = localStorage.getItem('finflow_token')
    if (!token) {
      set({ isLoading: false, isAuthenticated: false })
      return
    }
    try {
      const user = await api.get<User>('/auth/me')
      set({ user, isAuthenticated: true, isLoading: false })
    } catch {
      localStorage.removeItem('finflow_token')
      set({ user: null, isAuthenticated: false, isLoading: false })
    }
  },
}))
