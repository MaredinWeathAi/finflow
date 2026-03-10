import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { RecurringExpense } from '@/types'

export function useRecurring() {
  const [recurring, setRecurring] = useState<RecurringExpense[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const fetchRecurring = useCallback(async () => {
    setIsLoading(true)
    try {
      const res = await api.get<RecurringExpense[]>('/recurring')
      setRecurring(res)
    } catch (err) {
      console.error('Failed to fetch recurring:', err)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchRecurring()
  }, [fetchRecurring])

  const totalMonthly = recurring
    .filter(r => r.is_active)
    .reduce((sum, r) => {
      switch (r.frequency) {
        case 'weekly': return sum + r.amount * 4.33
        case 'biweekly': return sum + r.amount * 2.17
        case 'monthly': return sum + r.amount
        case 'quarterly': return sum + r.amount / 3
        case 'annually': return sum + r.amount / 12
        default: return sum + r.amount
      }
    }, 0)

  const totalAnnual = totalMonthly * 12

  return { recurring, isLoading, refetch: fetchRecurring, totalMonthly, totalAnnual }
}
