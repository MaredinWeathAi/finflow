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
  // cost_basis is stored PER SHARE. Summing it directly treated each share
  // price as a whole position cost, which reported the sample portfolio's
  // return as +3,366.8% instead of +10.5% — and disagreed with the per-holding
  // gain/loss figures rendered directly beneath the card.
  const totalCostBasis = investments.reduce((sum, i) => sum + (i.total_cost ?? i.shares * i.cost_basis), 0)
  const totalGainLoss = totalValue - totalCostBasis
  const totalGainLossPercent = totalCostBasis > 0 ? (totalGainLoss / totalCostBasis) * 100 : 0

  return { investments, isLoading, refetch: fetchInvestments, totalValue, totalCostBasis, totalGainLoss, totalGainLossPercent }
}
