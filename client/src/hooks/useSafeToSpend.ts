import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'

export interface SafeToSpendIncome {
  date: string
  amount: number
  name: string
  cadence: string
  confidence: number
}

export interface SafeToSpendCommittedItem {
  name: string
  amount: number
  dueDate: string
  source: 'detected' | 'manual'
  cadence: string
}

export interface SafeToSpendData {
  safeToSpend: number
  perDay: number
  daysUntilNextIncome: number
  asOf: string
  window: { start: string; end: string; days: number }
  balance: {
    total: number
    accounts: Array<{ id: string; name: string; type: string; balance: number }>
  }
  nextIncome: SafeToSpendIncome | null
  committed: { total: number; items: SafeToSpendCommittedItem[] }
  buffer: {
    total: number
    floor: number
    volatility: number
    quantile: number
    windowDays: number
    sampleCount: number
  }
  confidence: 'high' | 'medium' | 'low'
  notes: string[]
}

/**
 * Server-computed safe-to-spend: liquid balance − committed outflows before
 * the next expected paycheck − a volatility buffer. Replaces the old
 * client-side `income − spent − recurring` math.
 */
export function useSafeToSpend() {
  const [data, setData] = useState<SafeToSpendData | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const res = await api.get<SafeToSpendData>('/safe-to-spend')
      setData(res)
    } catch (err: any) {
      console.error('Failed to fetch safe-to-spend:', err)
      setError(err.message || 'Failed to fetch safe-to-spend')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  return { data, isLoading, error, refetch: fetchData }
}
