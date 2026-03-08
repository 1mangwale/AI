'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { Wallet, ArrowDownRight, ArrowUpRight, Gift, ChevronLeft, ChevronRight } from 'lucide-react'
import { nestjsPayments } from '@/lib/api/nestjs/payments'
import { useNestjsAuth } from '@/hooks/useNestjsAuth'
import { useToast } from '@/components/shared/Toast'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { WalletTransaction } from '@/types/nestjs/api'

export default function WalletPage() {
  const { isAuthenticated } = useNestjsAuth()
  const toast = useToast()

  const [balance, setBalance] = useState(0)
  const [loyaltyPoints, setLoyaltyPoints] = useState(0)
  const [transactions, setTransactions] = useState<WalletTransaction[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)

  // Add funds
  const [addAmount, setAddAmount] = useState('')
  const [addingFunds, setAddingFunds] = useState(false)

  // Transfer loyalty
  const [transferPoints, setTransferPoints] = useState('')
  const [transferring, setTransferring] = useState(false)

  const fetchData = useCallback(async () => {
    if (!isAuthenticated) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const [balanceRes, loyaltyRes, txRes] = await Promise.all([
        nestjsPayments.getWalletBalance(),
        nestjsPayments.getLoyaltyBalance(),
        nestjsPayments.getWalletTransactions({ page, limit: 10 }),
      ])
      if (balanceRes.data) setBalance(balanceRes.data.balance)
      if (loyaltyRes.data) setLoyaltyPoints(loyaltyRes.data.points)
      setTransactions(txRes.data)
      setTotalPages(txRes.meta?.totalPages ?? 1)
    } catch {
      toast.error('Failed to load wallet data')
    } finally {
      setLoading(false)
    }
  }, [isAuthenticated, page, toast])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleAddFunds = useCallback(async () => {
    const amount = parseFloat(addAmount)
    if (!amount || amount <= 0) {
      toast.warning('Enter a valid amount')
      return
    }
    setAddingFunds(true)
    try {
      await nestjsPayments.addFundsToWallet(amount, 'digital_payment')
      toast.success(`₹${amount} added to wallet`)
      setAddAmount('')
      fetchData()
    } catch {
      toast.error('Failed to add funds')
    } finally {
      setAddingFunds(false)
    }
  }, [addAmount, toast, fetchData])

  const handleTransferLoyalty = useCallback(async () => {
    const points = parseInt(transferPoints)
    if (!points || points <= 0) {
      toast.warning('Enter valid points')
      return
    }
    if (points > loyaltyPoints) {
      toast.warning('Insufficient loyalty points')
      return
    }
    setTransferring(true)
    try {
      const res = await nestjsPayments.transferLoyaltyToWallet(points)
      if (res.data) {
        toast.success(`Converted to ₹${res.data.wallet_amount.toFixed(2)}`)
      }
      setTransferPoints('')
      fetchData()
    } catch {
      toast.error('Failed to transfer loyalty points')
    } finally {
      setTransferring(false)
    }
  }, [transferPoints, loyaltyPoints, toast, fetchData])

  if (!isAuthenticated) {
    return (
      <div className="flex flex-col items-center justify-center py-20 px-4">
        <Wallet size={48} className="text-gray-300 mb-4" />
        <p className="text-gray-500 mb-4">Please login to access your wallet</p>
        <Link href="/shop/login">
          <Button className="bg-[#059211] hover:bg-[#047a0e] text-white">Login</Button>
        </Link>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <LoadingSpinner size="lg" text="Loading wallet..." />
      </div>
    )
  }

  return (
    <div className="px-4 py-4 pb-24">
      <h1 className="text-lg font-bold text-gray-900 mb-4">Wallet</h1>

      {/* Balance Card */}
      <Card className="mb-4 bg-gradient-to-br from-[#059211] to-[#047a0e] text-white border-none">
        <CardContent className="p-5">
          <div className="flex items-center gap-3 mb-3">
            <Wallet size={24} />
            <span className="text-sm font-medium opacity-90">Wallet Balance</span>
          </div>
          <p className="text-3xl font-bold">₹{balance.toFixed(2)}</p>
        </CardContent>
      </Card>

      {/* Add Funds */}
      <Card className="mb-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Add Funds</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Input
              type="number"
              placeholder="Enter amount"
              value={addAmount}
              onChange={(e) => setAddAmount(e.target.value)}
              min="1"
              className="flex-1"
            />
            <Button
              onClick={handleAddFunds}
              disabled={addingFunds || !addAmount}
              className="bg-[#059211] hover:bg-[#047a0e] text-white"
            >
              {addingFunds ? <LoadingSpinner size="sm" /> : 'Add'}
            </Button>
          </div>
          <div className="flex gap-2 mt-2">
            {[100, 200, 500, 1000].map((amt) => (
              <button
                key={amt}
                onClick={() => setAddAmount(String(amt))}
                className="flex-1 py-1.5 text-xs font-medium bg-gray-100 hover:bg-gray-200 rounded-md text-gray-700 transition-colors"
              >
                ₹{amt}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Loyalty Points */}
      <Card className="mb-6">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Gift size={16} className="text-[#059211]" />
            Loyalty Points
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold text-gray-900 mb-3">{loyaltyPoints} points</p>
          <div className="flex gap-2">
            <Input
              type="number"
              placeholder="Points to transfer"
              value={transferPoints}
              onChange={(e) => setTransferPoints(e.target.value)}
              min="1"
              max={loyaltyPoints}
              className="flex-1"
            />
            <Button
              onClick={handleTransferLoyalty}
              disabled={transferring || !transferPoints || loyaltyPoints <= 0}
              variant="outline"
              className="border-[#059211] text-[#059211] hover:bg-[#059211]/5"
            >
              {transferring ? <LoadingSpinner size="sm" /> : 'Transfer to Wallet'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Transactions */}
      <h2 className="text-sm font-semibold text-gray-900 mb-3">Transaction History</h2>
      {transactions.length === 0 ? (
        <div className="text-center py-8">
          <p className="text-gray-500 text-sm">No transactions yet</p>
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {transactions.map((tx) => {
              const isCredit = tx.credit > 0
              return (
                <div
                  key={tx.id}
                  className="bg-white rounded-lg border border-gray-100 p-3 flex items-center gap-3"
                >
                  <div
                    className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
                      isCredit ? 'bg-green-50' : 'bg-red-50'
                    }`}
                  >
                    {isCredit ? (
                      <ArrowDownRight size={16} className="text-green-600" />
                    ) : (
                      <ArrowUpRight size={16} className="text-red-500" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate capitalize">
                      {tx.transaction_type.replace(/_/g, ' ')}
                    </p>
                    <p className="text-xs text-gray-400">
                      {new Date(tx.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <span
                    className={`text-sm font-semibold ${
                      isCredit ? 'text-green-600' : 'text-red-500'
                    }`}
                  >
                    {isCredit ? '+' : '-'}₹{(isCredit ? tx.credit : tx.debit).toFixed(2)}
                  </span>
                </div>
              )
            })}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-4 mt-4">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="p-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ChevronLeft size={18} />
              </button>
              <span className="text-sm text-gray-600">
                Page {page} of {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="p-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ChevronRight size={18} />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
