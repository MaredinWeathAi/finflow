import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { Clarification } from '@/types'

export function useClarifications() {
  const [clarifications, setClarifications] = useState<Clarification[]>([])
  const [count, setCount] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchClarifications = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const res = await api.get<Clarification[]>('/clarifications')
      setClarifications(res)
    } catch (err: any) {
      console.error('Failed to fetch clarifications:', err)
      setError(err.message || 'Failed to fetch clarifications')
    } finally {
      setIsLoading(false)
    }
  }, [])

  const fetchCount = useCallback(async () => {
    try {
      const res = await api.get<{ count: number }>('/clarifications/count')
      setCount(res.count)
      return res.count
    } catch (err: any) {
      console.error('Failed to fetch clarification count:', err)
      return 0
    }
  }, [])

  const resolve = useCallback(async (id: string, resolution: Record<string, any>) => {
    setError(null)
    try {
      await api.put(`/clarifications/${id}`, { status: 'resolved', resolution })
      // Refresh list and count after resolving
      await fetchClarifications()
      await fetchCount()
    } catch (err: any) {
      console.error('Failed to resolve clarification:', err)
      setError(err.message || 'Failed to resolve clarification')
    }
  }, [fetchClarifications, fetchCount])

  const dismiss = useCallback(async (id: string) => {
    setError(null)
    try {
      await api.delete(`/clarifications/${id}`)
      // Refresh list and count after dismissing
      await fetchClarifications()
      await fetchCount()
    } catch (err: any) {
      console.error('Failed to dismiss clarification:', err)
      setError(err.message || 'Failed to dismiss clarification')
    }
  }, [fetchClarifications, fetchCount])

  useEffect(() => {
    fetchClarifications()
    fetchCount()
  }, [fetchClarifications, fetchCount])

  return {
    clarifications,
    count,
    isLoading,
    error,
    resolve,
    dismiss,
    refetch: fetchClarifications,
  }
}
