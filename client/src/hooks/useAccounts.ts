import { useState, useEffect, useCallback, useMemo } from 'react'
import { api } from '@/lib/api'
import type { Account, Investment } from '@/types'

const LIABILITY_TYPES = ['credit', 'loan', 'mortgage']

/**
 * Rounds to 2 decimal places using banker's rounding to avoid
 * floating-point artifacts (e.g. 112791.15999999999).
 */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

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

  // Build a set of account IDs that have linked investments.
  // These accounts are "containers" whose balance mirrors portfolio value,
  // so we must NOT count their balance separately to avoid double-counting.
  const investmentAccountIds = useMemo(() => {
    const ids = new Set<string>()
    for (const inv of investments) {
      if (inv.account_id) ids.add(inv.account_id)
    }
    return ids
  }, [investments])

  // Cash & non-investment assets: checking, savings, property, crypto accounts
  // EXCLUDE investment-type accounts that have linked holdings (avoid double-count)
  const totalAccountAssets = useMemo(() => {
    return round2(
      accounts
        .filter(a =>
          !a.is_hidden &&
          !LIABILITY_TYPES.includes(a.type) &&
          !investmentAccountIds.has(a.id)
        )
        .reduce((sum, a) => sum + a.balance, 0)
    )
  }, [accounts, investmentAccountIds])

  // Liabilities: credit cards, loans, mortgages
  const totalLiabilities = useMemo(() => {
    return round2(
      accounts
        .filter(a => !a.is_hidden && LIABILITY_TYPES.includes(a.type))
        .reduce((sum, a) => sum + Math.abs(a.balance), 0)
    )
  }, [accounts])

  // Investment portfolio value from individual holdings (shares × price)
  // This is the single source of truth for investment value
  const investmentPortfolioValue = useMemo(() => {
    return round2(
      investments.reduce((sum, inv) => {
        return sum + (inv.current_value || inv.shares * inv.current_price)
      }, 0)
    )
  }, [investments])

  const totalAssets = round2(totalAccountAssets + investmentPortfolioValue)
  const netWorth = round2(totalAssets - totalLiabilities)

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
