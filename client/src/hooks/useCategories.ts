import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { Category } from '@/types'

export function useCategories() {
  const [categories, setCategories] = useState<Category[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const fetchCategories = useCallback(async () => {
    setIsLoading(true)
    try {
      // Ensure system categories (Gas, CC PMT) exist, then fetch
      const ensureRes = await api.post<{ categories: Category[]; created: number }>('/categories/ensure-defaults')
      if (ensureRes?.categories) {
        setCategories(ensureRes.categories)
      } else {
        const res = await api.get<Category[]>('/categories')
        setCategories(res)
      }
    } catch (err) {
      // Fallback: just fetch
      try {
        const res = await api.get<Category[]>('/categories')
        setCategories(res)
      } catch { /* ignore */ }
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchCategories()
  }, [fetchCategories])

  const incomeCategories = categories.filter(c => c.is_income)
  const expenseCategories = categories.filter(c => !c.is_income)

  return { categories, incomeCategories, expenseCategories, isLoading, refetch: fetchCategories }
}
