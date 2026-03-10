import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { Goal } from '@/types'

export function useGoals() {
  const [goals, setGoals] = useState<Goal[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const fetchGoals = useCallback(async () => {
    setIsLoading(true)
    try {
      const res = await api.get<Goal[]>('/goals')
      setGoals(res)
    } catch (err) {
      console.error('Failed to fetch goals:', err)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchGoals()
  }, [fetchGoals])

  return { goals, isLoading, refetch: fetchGoals }
}
