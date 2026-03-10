import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { Category } from '@/types'

export function useCategories() {
  const [categories, setCategories] = useState<Category[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const fetchCategories = useCallback(async () => {
    setIsLoading(true)
    try {
      const res = await api.get<Category[]>('/categories')
      setCategories(res)
    } catch (err) {
      console.error('Failed to fetch categories:', err)
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
