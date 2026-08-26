import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { RecurringExpense } from '@/types'
import { monthlyAmount } from '@/lib/utils'

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

  const active = recurring.filter(r => r.is_active)
  // Shared frequency table. The switch this replaces defaulted to adding the
  // full amount every month for any frequency it didn't recognise — which
  // included every value the auto-detector writes.
  const totalMonthly = active.reduce((sum, r) => sum + (monthlyAmount(r.amount, r.frequency) ?? 0), 0)
  const unknownFrequency = active.filter(r => monthlyAmount(r.amount, r.frequency) === null).length

  const totalAnnual = totalMonthly * 12

  return { recurring, isLoading, refetch: fetchRecurring, totalMonthly, totalAnnual, unknownFrequency }
}
