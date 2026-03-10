import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { Account } from '@/types'

export function useAccounts() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const fetchAccounts = useCallback(async () => {
    setIsLoading(true)
    try {
      const res = await api.get<Account[]>('/accounts')
      setAccounts(res)
    } catch (err) {
      console.error('Failed to fetch accounts:', err)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchAccounts()
  }, [fetchAccounts])

  const totalAssets = accounts
    .filter(a => a.balance > 0 && !a.is_hidden)
    .reduce((sum, a) => sum + a.balance, 0)

  const totalLiabilities = accounts
    .filter(a => a.balance < 0 && !a.is_hidden)
    .reduce((sum, a) => sum + Math.abs(a.balance), 0)

  const netWorth = totalAssets - totalLiabilities

  return { accounts, isLoading, refetch: fetchAccounts, totalAssets, totalLiabilities, netWorth }
}
