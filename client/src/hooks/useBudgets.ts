import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { Budget } from '@/types'
import { format, startOfMonth } from 'date-fns'

export function useBudgets(month?: Date) {
  const [budgets, setBudgets] = useState<Budget[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const monthStr = format(month || startOfMonth(new Date()), 'yyyy-MM-dd')

  const fetchBudgets = useCallback(async () => {
    setIsLoading(true)
    try {
      const res = await api.get<Budget[]>(`/budgets?month=${monthStr}`)
      setBudgets(res)
    } catch (err) {
      console.error('Failed to fetch budgets:', err)
    } finally {
      setIsLoading(false)
    }
  }, [monthStr])

  useEffect(() => {
    fetchBudgets()
  }, [fetchBudgets])

  const totalBudget = budgets.reduce((sum, b) => sum + b.amount, 0)
  const totalSpent = budgets.reduce((sum, b) => sum + (b.spent || 0), 0)
  const remaining = totalBudget - totalSpent

  return { budgets, isLoading, refetch: fetchBudgets, totalBudget, totalSpent, remaining }
}
