import { create } from 'zustand'

type Theme = 'dark' | 'light' | 'system'

interface ThemeState {
  theme: Theme
  setTheme: (theme: Theme) => void
}

function applyTheme(theme: Theme) {
  const root = document.documentElement
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches

  if (theme === 'dark' || (theme === 'system' && systemDark)) {
    root.classList.add('dark')
  } else {
    root.classList.remove('dark')
  }
}

const stored = (typeof window !== 'undefined' ? localStorage.getItem('finflow_theme') : null) as Theme | null

export const useThemeStore = create<ThemeState>((set) => {
  const initial = stored || 'dark'
  if (typeof window !== 'undefined') applyTheme(initial)

  return {
    theme: initial,
    setTheme: (theme) => {
      localStorage.setItem('finflow_theme', theme)
      applyTheme(theme)
      set({ theme })
    },
  }
})
