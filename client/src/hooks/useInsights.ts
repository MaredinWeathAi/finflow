import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { InsightsData } from '@/types'

export function useInsights() {
  const [data, setData] = useState<InsightsData | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchInsights = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const res = await api.get<InsightsData>('/insights')
      setData(res)
    } catch (err: any) {
      console.error('Failed to fetch insights:', err)
      setError(err.message || 'Failed to fetch insights')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchInsights()
  }, [fetchInsights])

  return { data, isLoading, error, refetch: fetchInsights }
}
