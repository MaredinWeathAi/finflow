import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { Account, Investment } from '@/types'

export function useAccounts() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [investments, setInvestments] = useState<Investment[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const fetchAccounts = useCallback(async () => {
    setIsLoading(true)
    try {
      const [accountRes, investmentRes] = await Promise.all([
        api.get<Account[]>('/accounts'),
        api.get<Investment[]>('/investments').catch(() => [] as Investment[]),
      ])
      setAccounts(accountRes)
      setInvestments(investmentRes)
    } catch (err) {
      console.error('Failed to fetch accounts:', err)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchAccounts()
  }, [fetchAccounts])

  // Determine assets vs liabilities by account TYPE, not balance sign
  const liabilityTypes = ['credit', 'loan', 'mortgage']

  const totalAccountAssets = accounts
    .filter(a => !a.is_hidden && !liabilityTypes.includes(a.type))
    .reduce((sum, a) => sum + a.balance, 0)

  const totalLiabilities = accounts
    .filter(a => !a.is_hidden && liabilityTypes.includes(a.type))
    .reduce((sum, a) => sum + Math.abs(a.balance), 0)

  // Investment portfolio value
  const investmentPortfolioValue = investments.reduce((sum, inv) => {
    return sum + (inv.current_value || inv.shares * inv.current_price)
  }, 0)

  const totalAssets = totalAccountAssets + investmentPortfolioValue
  const netWorth = totalAssets - totalLiabilities

  return {
    accounts,
    investments,
    isLoading,
    refetch: fetchAccounts,
    totalAssets,
    totalAccountAssets,
    totalLiabilities,
    investmentPortfolioValue,
    netWorth,
  }
}
