'use client'

import { useState, useEffect, useCallback } from 'react'
import { nestjsAdmin } from '@/lib/api/nestjs/admin'
import { useToast } from '@/components/shared/Toast'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import type { Subscription } from '@/types/nestjs/api'
import {
  Crown,
  Plus,
  Pencil,
  Loader2,
  CheckCircle,
  XCircle,
} from 'lucide-react'

interface SubscriptionFormData {
  title: string
  price: string
  validity: string
  max_stores: string
  max_items: string
  max_orders: string
  pos: boolean
  mobile_app: boolean
  chat: boolean
  review: boolean
  self_delivery: boolean
  status: boolean
}

const emptyForm: SubscriptionFormData = {
  title: '',
  price: '',
  validity: '',
  max_stores: '',
  max_items: '',
  max_orders: '',
  pos: false,
  mobile_app: false,
  chat: false,
  review: false,
  self_delivery: false,
  status: true,
}

export default function AdminCommerceSubscriptionsPage() {
  const toast = useToast()

  const [subscriptions, setSubscriptions] = useState<Subscription[]>([])
  const [loading, setLoading] = useState(true)
  const [showDialog, setShowDialog] = useState(false)
  const [editingSub, setEditingSub] = useState<Subscription | null>(null)
  const [formData, setFormData] = useState<SubscriptionFormData>(emptyForm)
  const [saving, setSaving] = useState(false)

  const fetchSubscriptions = useCallback(async () => {
    setLoading(true)
    try {
      const res = await nestjsAdmin.getSubscriptions()
      if (res.success && res.data) {
        setSubscriptions(res.data)
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load subscriptions'
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    fetchSubscriptions()
  }, [fetchSubscriptions])

  const openCreateDialog = () => {
    setEditingSub(null)
    setFormData(emptyForm)
    setShowDialog(true)
  }

  const openEditDialog = (sub: Subscription) => {
    setEditingSub(sub)
    setFormData({
      title: sub.title,
      price: String(sub.price),
      validity: String(sub.validity),
      max_stores: String(sub.max_stores),
      max_items: String(sub.max_items),
      max_orders: String(sub.max_orders),
      pos: sub.pos,
      mobile_app: sub.mobile_app,
      chat: sub.chat,
      review: sub.review,
      self_delivery: sub.self_delivery,
      status: sub.status,
    })
    setShowDialog(true)
  }

  const handleSave = async () => {
    if (!formData.title.trim()) {
      toast.error('Title is required')
      return
    }

    setSaving(true)
    try {
      const payload: Partial<Subscription> = {
        title: formData.title,
        price: Number(formData.price) || 0,
        validity: Number(formData.validity) || 30,
        max_stores: Number(formData.max_stores) || 1,
        max_items: Number(formData.max_items) || 100,
        max_orders: Number(formData.max_orders) || 1000,
        pos: formData.pos,
        mobile_app: formData.mobile_app,
        chat: formData.chat,
        review: formData.review,
        self_delivery: formData.self_delivery,
        status: formData.status,
      }

      if (editingSub) {
        await nestjsAdmin.updateSubscription(editingSub.id, payload)
        toast.success('Subscription updated successfully')
      } else {
        await nestjsAdmin.createSubscription(payload)
        toast.success('Subscription created successfully')
      }
      setShowDialog(false)
      fetchSubscriptions()
    } catch {
      toast.error('Failed to save subscription')
    } finally {
      setSaving(false)
    }
  }

  const FeatureIcon = ({ enabled }: { enabled: boolean }) =>
    enabled ? (
      <CheckCircle size={14} className="text-green-500" />
    ) : (
      <XCircle size={14} className="text-gray-300" />
    )

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Subscription Plans</h1>
          <p className="text-sm text-gray-500 mt-1">
            Manage vendor subscription plans ({subscriptions.length} plans)
          </p>
        </div>
        <Button onClick={openCreateDialog} className="bg-[#059211] hover:bg-[#047a0e]">
          <Plus size={16} className="mr-2" />
          Add Plan
        </Button>
      </div>

      {/* Plans Table */}
      {loading ? (
        <div className="flex justify-center py-12">
          <LoadingSpinner text="Loading subscriptions..." />
        </div>
      ) : subscriptions.length === 0 ? (
        <div className="bg-white rounded-xl border p-12 text-center">
          <Crown size={48} className="mx-auto text-gray-300 mb-3" />
          <p className="text-gray-500 mb-4">No subscription plans configured</p>
          <Button onClick={openCreateDialog} className="bg-[#059211] hover:bg-[#047a0e]">
            <Plus size={16} className="mr-2" />
            Create First Plan
          </Button>
        </div>
      ) : (
        <div className="bg-white rounded-xl border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Title</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-500">Price</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-500 hidden md:table-cell">Validity</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-500 hidden lg:table-cell">Limits</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-500 hidden lg:table-cell">Features</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Status</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {subscriptions.map((sub) => (
                  <tr key={sub.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Crown size={16} className="text-yellow-500" />
                        <span className="font-medium text-gray-900">{sub.title}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-gray-900">
                      {sub.price.toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-600 hidden md:table-cell">
                      {sub.validity} days
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell">
                      <div className="flex items-center justify-center gap-3 text-xs text-gray-500">
                        <span>{sub.max_stores} stores</span>
                        <span>{sub.max_items} items</span>
                        <span>{sub.max_orders} orders</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell">
                      <div className="flex items-center justify-center gap-2">
                        <span className="flex items-center gap-0.5 text-xs">
                          <FeatureIcon enabled={sub.pos} /> POS
                        </span>
                        <span className="flex items-center gap-0.5 text-xs">
                          <FeatureIcon enabled={sub.chat} /> Chat
                        </span>
                        <span className="flex items-center gap-0.5 text-xs">
                          <FeatureIcon enabled={sub.self_delivery} /> Delivery
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        className={
                          sub.status
                            ? 'bg-green-100 text-green-700'
                            : 'bg-red-100 text-red-700'
                        }
                      >
                        {sub.status ? 'Active' : 'Inactive'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => openEditDialog(sub)}
                        className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors text-gray-400 hover:text-gray-600"
                      >
                        <Pencil size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Create/Edit Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingSub ? 'Edit Subscription' : 'Create Subscription'}
            </DialogTitle>
            <DialogDescription>
              {editingSub
                ? 'Update the subscription plan details.'
                : 'Create a new vendor subscription plan.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2 max-h-[60vh] overflow-y-auto">
            <div>
              <label className="text-sm font-medium text-gray-700 mb-1 block">Title</label>
              <Input
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                placeholder="e.g., Basic, Premium, Enterprise"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium text-gray-700 mb-1 block">Price</label>
                <Input
                  type="number"
                  step="0.01"
                  value={formData.price}
                  onChange={(e) => setFormData({ ...formData, price: e.target.value })}
                  placeholder="0"
                />
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700 mb-1 block">Validity (days)</label>
                <Input
                  type="number"
                  value={formData.validity}
                  onChange={(e) => setFormData({ ...formData, validity: e.target.value })}
                  placeholder="30"
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-sm font-medium text-gray-700 mb-1 block">Max Stores</label>
                <Input
                  type="number"
                  value={formData.max_stores}
                  onChange={(e) => setFormData({ ...formData, max_stores: e.target.value })}
                  placeholder="1"
                />
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700 mb-1 block">Max Items</label>
                <Input
                  type="number"
                  value={formData.max_items}
                  onChange={(e) => setFormData({ ...formData, max_items: e.target.value })}
                  placeholder="100"
                />
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700 mb-1 block">Max Orders</label>
                <Input
                  type="number"
                  value={formData.max_orders}
                  onChange={(e) => setFormData({ ...formData, max_orders: e.target.value })}
                  placeholder="1000"
                />
              </div>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-700 mb-2 block">Features</label>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { key: 'pos', label: 'POS System' },
                  { key: 'mobile_app', label: 'Mobile App' },
                  { key: 'chat', label: 'Chat Support' },
                  { key: 'review', label: 'Review System' },
                  { key: 'self_delivery', label: 'Self Delivery' },
                  { key: 'status', label: 'Active' },
                ].map(({ key, label }) => (
                  <label key={key} className="flex items-center gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={formData[key as keyof SubscriptionFormData] as boolean}
                      onChange={(e) =>
                        setFormData({ ...formData, [key]: e.target.checked })
                      }
                      className="rounded border-gray-300 text-[#059211] focus:ring-[#059211]"
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)} disabled={saving}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving}
              className="bg-[#059211] hover:bg-[#047a0e]"
            >
              {saving && <Loader2 className="animate-spin mr-2" size={16} />}
              {editingSub ? 'Update' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
