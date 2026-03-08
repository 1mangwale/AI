'use client'

import { useState, useEffect, useCallback } from 'react'
import { nestjsDelivery } from '@/lib/api/nestjs/delivery'
import { useToast } from '@/components/shared/Toast'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { Card, CardContent } from '@/components/ui/card'
import { DollarSign, TrendingUp, Calendar, ArrowUpRight, ArrowDownRight } from 'lucide-react'

interface EarningTransaction {
  id?: number
  amount: number
  type: string
  description?: string
  created_at?: string
  date?: string
}

interface EarningsData {
  total: number
  today: number
  transactions: EarningTransaction[]
}

export default function RiderEarningsPage() {
  const toast = useToast()

  const [earnings, setEarnings] = useState<EarningsData | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchEarnings = useCallback(async () => {
    setLoading(true)
    try {
      const res = await nestjsDelivery.rider.getEarnings()
      if (res.success && res.data) {
        setEarnings(res.data as EarningsData)
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load earnings'
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    fetchEarnings()
  }, [fetchEarnings])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <LoadingSpinner text="Loading earnings..." />
      </div>
    )
  }

  const weekTotal = earnings?.total || 0
  const todayTotal = earnings?.today || 0
  const transactions = (earnings?.transactions || []) as EarningTransaction[]

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-xl font-bold text-gray-900">Earnings</h1>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-3">
        <Card className="bg-gradient-to-br from-[#059211] to-[#047a0e] text-white border-0">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <DollarSign size={18} className="opacity-80" />
              <span className="text-xs font-medium opacity-80">Today</span>
            </div>
            <p className="text-2xl font-bold">{todayTotal.toFixed(0)}</p>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-blue-600 to-blue-700 text-white border-0">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp size={18} className="opacity-80" />
              <span className="text-xs font-medium opacity-80">This Week</span>
            </div>
            <p className="text-2xl font-bold">{weekTotal.toFixed(0)}</p>
          </CardContent>
        </Card>
      </div>

      {/* Transaction History */}
      <div>
        <h2 className="text-sm font-semibold text-gray-700 mb-3">
          Transaction History
        </h2>
        {transactions.length === 0 ? (
          <Card>
            <CardContent className="p-8 text-center">
              <Calendar size={40} className="mx-auto text-gray-300 mb-3" />
              <p className="text-sm text-gray-500">No transactions yet</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {transactions.map((txn, index) => (
              <Card key={txn.id || index}>
                <CardContent className="p-3 flex items-center gap-3">
                  <div
                    className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
                      txn.type === 'credit' || txn.type === 'earning'
                        ? 'bg-green-100'
                        : 'bg-red-100'
                    }`}
                  >
                    {txn.type === 'credit' || txn.type === 'earning' ? (
                      <ArrowUpRight size={16} className="text-green-600" />
                    ) : (
                      <ArrowDownRight size={16} className="text-red-600" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">
                      {txn.description || txn.type}
                    </p>
                    <p className="text-xs text-gray-500">
                      {txn.created_at
                        ? new Date(txn.created_at).toLocaleString()
                        : txn.date || ''}
                    </p>
                  </div>
                  <span
                    className={`text-sm font-semibold ${
                      txn.type === 'credit' || txn.type === 'earning'
                        ? 'text-green-600'
                        : 'text-red-600'
                    }`}
                  >
                    {txn.type === 'credit' || txn.type === 'earning' ? '+' : '-'}
                    {Math.abs(txn.amount).toFixed(0)}
                  </span>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
