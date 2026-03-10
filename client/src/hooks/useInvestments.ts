import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { Investment } from '@/types'

export function useInvestments() {
  const [investments, setInvestments] = useState<Investment[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const fetchInvestments = useCallback(async () => {
    setIsLoading(true)
    try {
      const res = await api.get<Investment[]>('/investments')
      setInvestments(res)
    } catch (err) {
      console.error('Failed to fetch investments:', err)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchInvestments()
  }, [fetchInvestments])

  const totalValue = investments.reduce((sum, i) => sum + (i.current_value || i.shares * i.current_price), 0)
  const totalCostBasis = investments.reduce((sum, i) => sum + i.cost_basis, 0)
  const totalGainLoss = totalValue - totalCostBasis
  const totalGainLossPercent = totalCostBasis > 0 ? (totalGainLoss / totalCostBasis) * 100 : 0

  return { investments, isLoading, refetch: fetchInvestments, totalValue, totalCostBasis, totalGainLoss, totalGainLossPercent }
}
