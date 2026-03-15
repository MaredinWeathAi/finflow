import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { Transaction } from '@/types'

interface TransactionFilters {
  page?: number
  limit?: number
  category?: string
  account?: string
  startDate?: string
  endDate?: string
  search?: string
  minAmount?: number
  maxAmount?: number
  type?: 'income' | 'expense'
  isPending?: boolean
  sort?: string
}

interface TransactionResponse {
  transactions: Transaction[]
  total: number
  page: number
  totalPages: number
  totalIncome: number
  totalExpenses: number
}

export function useTransactions(filters: TransactionFilters = {}) {
  const [data, setData] = useState<TransactionResponse>({
    transactions: [],
    total: 0,
    page: 1,
    totalPages: 1,
    totalIncome: 0,
    totalExpenses: 0,
  })
  const [isLoading, setIsLoading] = useState(true)

  const fetchTransactions = useCallback(async () => {
    setIsLoading(true)
    try {
      const params = new URLSearchParams()
      Object.entries(filters).forEach(([key, value]) => {
        if (value !== undefined && value !== '' && value !== null) {
          params.set(key, String(value))
        }
      })
      const res = await api.get<TransactionResponse>(`/transactions?${params.toString()}`)
      setData(res)
    } catch (err) {
      console.error('Failed to fetch transactions:', err)
    } finally {
      setIsLoading(false)
    }
  }, [JSON.stringify(filters)])

  useEffect(() => {
    fetchTransactions()
  }, [fetchTransactions])

  return { ...data, isLoading, refetch: fetchTransactions }
}

export function useRecentTransactions(limit = 10) {
  return useTransactions({ limit, sort: 'date_desc' })
}
