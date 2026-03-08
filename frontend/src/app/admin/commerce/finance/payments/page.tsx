'use client'

import { useState, useEffect, useCallback } from 'react'
import { nestjsPayments } from '@/lib/api/nestjs/payments'
import { useToast } from '@/components/shared/Toast'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  ChevronLeft,
  ChevronRight,
  CreditCard,
} from 'lucide-react'

const PAYMENT_METHODS = [
  { label: 'All', value: '' },
  { label: 'Cash on Delivery', value: 'cash_on_delivery' },
  { label: 'Wallet', value: 'wallet' },
  { label: 'Stripe', value: 'stripe' },
  { label: 'Razorpay', value: 'razorpay' },
  { label: 'Offline', value: 'offline' },
]

export default function AdminCommercePaymentsPage() {
  const toast = useToast()

  const [payments, setPayments] = useState<Record<string, unknown>[]>([])
  const [loading, setLoading] = useState(true)
  const [methodFilter, setMethodFilter] = useState('')
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)

  const fetchPayments = useCallback(async () => {
    setLoading(true)
    try {
      const res = await nestjsPayments.admin.getPayments({
        page,
        limit: 15,
        method: methodFilter || undefined,
      })
      if (res.success) {
        setPayments(res.data)
        setTotalPages(res.meta.totalPages)
        setTotal(res.meta.total)
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load payments'
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }, [page, methodFilter, toast])

  useEffect(() => {
    fetchPayments()
  }, [fetchPayments])

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Payment Management</h1>
        <p className="text-sm text-gray-500 mt-1">
          View all payment transactions ({total} total)
        </p>
      </div>

      {/* Filters */}
      <div className="flex gap-1 overflow-x-auto pb-1">
        {PAYMENT_METHODS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => {
              setMethodFilter(opt.value)
              setPage(1)
            }}
            className={`px-3 py-2 text-xs rounded-lg border whitespace-nowrap transition-colors ${
              methodFilter === opt.value
                ? 'bg-[#059211] text-white border-[#059211]'
                : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex justify-center py-12">
          <LoadingSpinner text="Loading payments..." />
        </div>
      ) : payments.length === 0 ? (
        <div className="bg-white rounded-xl border p-12 text-center">
          <CreditCard size={48} className="mx-auto text-gray-300 mb-3" />
          <p className="text-gray-500">No payments found</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Transaction ID</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500">User</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-500">Amount</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Method</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 hidden md:table-cell">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {payments.map((payment, idx) => (
                  <tr key={String(payment.id || idx)} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs text-gray-900">
                        {String(payment.transaction_id || payment.id || '-')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {String(payment.user_name || payment.user_id || '-')}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-gray-900">
                      {Number(payment.amount || 0).toFixed(2)}
                    </td>
                    <td className="px-4 py-3">
                      <span className="capitalize text-gray-600 text-xs">
                        {String(payment.payment_method || payment.method || '-').replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        className={
                          String(payment.status) === 'paid' || String(payment.status) === 'completed'
                            ? 'bg-green-100 text-green-700'
                            : String(payment.status) === 'failed'
                            ? 'bg-red-100 text-red-700'
                            : 'bg-yellow-100 text-yellow-700'
                        }
                      >
                        {String(payment.status || 'pending')}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs hidden md:table-cell">
                      {payment.created_at
                        ? new Date(String(payment.created_at)).toLocaleDateString()
                        : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between px-4 py-3 border-t bg-gray-50">
            <p className="text-sm text-gray-500">
              Page {page} of {totalPages} ({total} payments)
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                <ChevronLeft size={16} />
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage(page + 1)}
              >
                <ChevronRight size={16} />
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
