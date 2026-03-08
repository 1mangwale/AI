'use client'

import { useState, useEffect, useCallback } from 'react'
import { nestjsPayments } from '@/lib/api/nestjs/payments'
import { useToast } from '@/components/shared/Toast'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  ChevronLeft,
  ChevronRight,
  Receipt,
  CheckCircle,
  XCircle,
  Loader2,
} from 'lucide-react'

const STATUS_OPTIONS = [
  { label: 'All', value: '' },
  { label: 'Pending', value: 'pending' },
  { label: 'Approved', value: 'approved' },
  { label: 'Rejected', value: 'rejected' },
]

export default function AdminCommerceOfflinePaymentsPage() {
  const toast = useToast()

  const [payments, setPayments] = useState<Record<string, unknown>[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('')
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [verifying, setVerifying] = useState(false)
  const [showDialog, setShowDialog] = useState(false)
  const [selectedPayment, setSelectedPayment] = useState<Record<string, unknown> | null>(null)
  const [verifyAction, setVerifyAction] = useState<'approve' | 'reject'>('approve')
  const [verifyNote, setVerifyNote] = useState('')

  const fetchPayments = useCallback(async () => {
    setLoading(true)
    try {
      const res = await nestjsPayments.admin.getOfflinePayments({
        page,
        limit: 15,
        status: statusFilter || undefined,
      })
      if (res.success) {
        setPayments(res.data)
        setTotalPages(res.meta.totalPages)
        setTotal(res.meta.total)
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load offline payments'
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }, [page, statusFilter, toast])

  useEffect(() => {
    fetchPayments()
  }, [fetchPayments])

  const openVerifyDialog = (payment: Record<string, unknown>, action: 'approve' | 'reject') => {
    setSelectedPayment(payment)
    setVerifyAction(action)
    setVerifyNote('')
    setShowDialog(true)
  }

  const handleVerify = async () => {
    if (!selectedPayment) return
    setVerifying(true)
    try {
      await nestjsPayments.admin.verifyOfflinePayment(
        Number(selectedPayment.id),
        verifyAction === 'approve',
        verifyNote || undefined
      )
      toast.success(
        verifyAction === 'approve'
          ? 'Payment approved successfully'
          : 'Payment rejected'
      )
      setShowDialog(false)
      fetchPayments()
    } catch {
      toast.error('Failed to verify payment')
    } finally {
      setVerifying(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Offline Payment Approval</h1>
        <p className="text-sm text-gray-500 mt-1">
          Review and approve offline payment submissions ({total} total)
        </p>
      </div>

      {/* Filters */}
      <div className="flex gap-2">
        {STATUS_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => {
              setStatusFilter(opt.value)
              setPage(1)
            }}
            className={`px-3 py-2 text-sm rounded-lg border transition-colors ${
              statusFilter === opt.value
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
          <Receipt size={48} className="mx-auto text-gray-300 mb-3" />
          <p className="text-gray-500">No offline payments found</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Customer</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-500">Amount</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 hidden md:table-cell">Reference</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 hidden md:table-cell">Date</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {payments.map((payment, idx) => {
                  const status = String(payment.status || 'pending')
                  const isPending = status === 'pending'

                  return (
                    <tr key={String(payment.id || idx)} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3">
                        <span className="font-medium text-gray-900">
                          {String(payment.customer_name || payment.user_id || '-')}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-gray-900">
                        {Number(payment.amount || 0).toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-gray-600 text-xs font-mono hidden md:table-cell">
                        {String(payment.reference || payment.transaction_reference || '-')}
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          className={
                            status === 'approved'
                              ? 'bg-green-100 text-green-700'
                              : status === 'rejected'
                              ? 'bg-red-100 text-red-700'
                              : 'bg-yellow-100 text-yellow-700'
                          }
                        >
                          {status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs hidden md:table-cell">
                        {payment.created_at
                          ? new Date(String(payment.created_at)).toLocaleDateString()
                          : '-'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {isPending && (
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={() => openVerifyDialog(payment, 'approve')}
                              className="p-1.5 rounded-lg bg-green-50 text-green-600 hover:bg-green-100 transition-colors"
                              title="Approve"
                            >
                              <CheckCircle size={16} />
                            </button>
                            <button
                              onClick={() => openVerifyDialog(payment, 'reject')}
                              className="p-1.5 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 transition-colors"
                              title="Reject"
                            >
                              <XCircle size={16} />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
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

      {/* Verify Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {verifyAction === 'approve' ? 'Approve Payment' : 'Reject Payment'}
            </DialogTitle>
            <DialogDescription>
              {verifyAction === 'approve'
                ? 'Are you sure you want to approve this offline payment?'
                : 'Are you sure you want to reject this offline payment?'}
            </DialogDescription>
          </DialogHeader>
          {selectedPayment && (
            <div className="py-2">
              <div className="bg-gray-50 rounded-lg p-3 text-sm space-y-1">
                <p>
                  <span className="text-gray-500">Amount:</span>{' '}
                  <span className="font-semibold">{Number(selectedPayment.amount || 0).toFixed(2)}</span>
                </p>
                <p>
                  <span className="text-gray-500">Reference:</span>{' '}
                  {String(selectedPayment.reference || selectedPayment.transaction_reference || '-')}
                </p>
              </div>
              <div className="mt-3">
                <label className="text-sm font-medium text-gray-700 mb-1 block">
                  Note (optional)
                </label>
                <Input
                  value={verifyNote}
                  onChange={(e) => setVerifyNote(e.target.value)}
                  placeholder="Add a note..."
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDialog(false)}
              disabled={verifying}
            >
              Cancel
            </Button>
            <Button
              onClick={handleVerify}
              disabled={verifying}
              className={
                verifyAction === 'approve'
                  ? 'bg-[#059211] hover:bg-[#047a0e]'
                  : 'bg-red-600 hover:bg-red-700'
              }
            >
              {verifying && <Loader2 className="animate-spin mr-2" size={16} />}
              {verifyAction === 'approve' ? 'Approve' : 'Reject'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
