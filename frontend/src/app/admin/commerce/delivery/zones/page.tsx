'use client'

import { useState, useEffect, useCallback } from 'react'
import { nestjsDelivery } from '@/lib/api/nestjs/delivery'
import { useToast } from '@/components/shared/Toast'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import type { Zone } from '@/types/nestjs/api'
import {
  MapPin,
  Plus,
  Pencil,
  Trash2,
  Loader2,
} from 'lucide-react'

interface ZoneFormData {
  name: string
  minimum_delivery_charge: string
  maximum_delivery_charge: string
  per_km_delivery_charge: string
  status: boolean
}

const emptyForm: ZoneFormData = {
  name: '',
  minimum_delivery_charge: '',
  maximum_delivery_charge: '',
  per_km_delivery_charge: '',
  status: true,
}

export default function AdminCommerceDeliveryZonesPage() {
  const toast = useToast()

  const [zones, setZones] = useState<Zone[]>([])
  const [loading, setLoading] = useState(true)
  const [showDialog, setShowDialog] = useState(false)
  const [editingZone, setEditingZone] = useState<Zone | null>(null)
  const [formData, setFormData] = useState<ZoneFormData>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)

  const fetchZones = useCallback(async () => {
    setLoading(true)
    try {
      const res = await nestjsDelivery.admin.getZones()
      if (res.success && res.data) {
        setZones(res.data)
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load zones'
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    fetchZones()
  }, [fetchZones])

  const openCreateDialog = () => {
    setEditingZone(null)
    setFormData(emptyForm)
    setShowDialog(true)
  }

  const openEditDialog = (zone: Zone) => {
    setEditingZone(zone)
    setFormData({
      name: zone.name,
      minimum_delivery_charge: String(zone.minimum_delivery_charge),
      maximum_delivery_charge: String(zone.maximum_delivery_charge),
      per_km_delivery_charge: String(zone.per_km_delivery_charge),
      status: zone.status,
    })
    setShowDialog(true)
  }

  const handleSave = async () => {
    if (!formData.name.trim()) {
      toast.error('Zone name is required')
      return
    }

    setSaving(true)
    try {
      const payload = {
        name: formData.name,
        minimum_delivery_charge: Number(formData.minimum_delivery_charge) || 0,
        maximum_delivery_charge: Number(formData.maximum_delivery_charge) || 0,
        per_km_delivery_charge: Number(formData.per_km_delivery_charge) || 0,
        status: formData.status,
      }

      if (editingZone) {
        await nestjsDelivery.admin.updateZone(editingZone.id, payload)
        toast.success('Zone updated successfully')
      } else {
        await nestjsDelivery.admin.createZone(payload)
        toast.success('Zone created successfully')
      }
      setShowDialog(false)
      fetchZones()
    } catch {
      toast.error('Failed to save zone')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (zone: Zone) => {
    if (!confirm(`Are you sure you want to delete zone "${zone.name}"?`)) return

    setDeletingId(zone.id)
    try {
      await nestjsDelivery.admin.deleteZone(zone.id)
      toast.success('Zone deleted successfully')
      fetchZones()
    } catch {
      toast.error('Failed to delete zone')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Delivery Zones</h1>
          <p className="text-sm text-gray-500 mt-1">
            Manage delivery zones and charges ({zones.length} zones)
          </p>
        </div>
        <Button onClick={openCreateDialog} className="bg-[#059211] hover:bg-[#047a0e]">
          <Plus size={16} className="mr-2" />
          Add Zone
        </Button>
      </div>

      {/* Zone Cards */}
      {loading ? (
        <div className="flex justify-center py-12">
          <LoadingSpinner text="Loading zones..." />
        </div>
      ) : zones.length === 0 ? (
        <div className="bg-white rounded-xl border p-12 text-center">
          <MapPin size={48} className="mx-auto text-gray-300 mb-3" />
          <p className="text-gray-500 mb-4">No delivery zones configured</p>
          <Button onClick={openCreateDialog} className="bg-[#059211] hover:bg-[#047a0e]">
            <Plus size={16} className="mr-2" />
            Create First Zone
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {zones.map((zone) => (
            <Card key={zone.id} className="hover:shadow-md transition-shadow">
              <CardContent className="p-5">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div className="w-9 h-9 bg-[#059211]/10 rounded-lg flex items-center justify-center">
                      <MapPin size={18} className="text-[#059211]" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-gray-900">{zone.name}</h3>
                      <Badge
                        className={
                          zone.status
                            ? 'bg-green-100 text-green-700'
                            : 'bg-red-100 text-red-700'
                        }
                      >
                        {zone.status ? 'Active' : 'Inactive'}
                      </Badge>
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={() => openEditDialog(zone)}
                      className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors text-gray-400 hover:text-gray-600"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => handleDelete(zone)}
                      disabled={deletingId === zone.id}
                      className="p-1.5 rounded-lg hover:bg-red-50 transition-colors text-gray-400 hover:text-red-600 disabled:opacity-50"
                    >
                      {deletingId === zone.id ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Trash2 size={14} />
                      )}
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="bg-gray-50 rounded-lg p-2">
                    <p className="text-xs text-gray-500">Min Charge</p>
                    <p className="text-sm font-semibold text-gray-900">
                      {zone.minimum_delivery_charge}
                    </p>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-2">
                    <p className="text-xs text-gray-500">Max Charge</p>
                    <p className="text-sm font-semibold text-gray-900">
                      {zone.maximum_delivery_charge}
                    </p>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-2">
                    <p className="text-xs text-gray-500">Per Km</p>
                    <p className="text-sm font-semibold text-gray-900">
                      {zone.per_km_delivery_charge}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create/Edit Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingZone ? 'Edit Zone' : 'Create Zone'}
            </DialogTitle>
            <DialogDescription>
              {editingZone
                ? 'Update the delivery zone details and charges.'
                : 'Configure a new delivery zone with charges.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <label className="text-sm font-medium text-gray-700 mb-1 block">
                Zone Name
              </label>
              <Input
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g., Downtown, South Bangalore"
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-sm font-medium text-gray-700 mb-1 block">
                  Min Charge
                </label>
                <Input
                  type="number"
                  step="0.01"
                  value={formData.minimum_delivery_charge}
                  onChange={(e) =>
                    setFormData({ ...formData, minimum_delivery_charge: e.target.value })
                  }
                  placeholder="0"
                />
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700 mb-1 block">
                  Max Charge
                </label>
                <Input
                  type="number"
                  step="0.01"
                  value={formData.maximum_delivery_charge}
                  onChange={(e) =>
                    setFormData({ ...formData, maximum_delivery_charge: e.target.value })
                  }
                  placeholder="0"
                />
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700 mb-1 block">
                  Per Km
                </label>
                <Input
                  type="number"
                  step="0.01"
                  value={formData.per_km_delivery_charge}
                  onChange={(e) =>
                    setFormData({ ...formData, per_km_delivery_charge: e.target.value })
                  }
                  placeholder="0"
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="zone-status"
                checked={formData.status}
                onChange={(e) => setFormData({ ...formData, status: e.target.checked })}
                className="rounded border-gray-300 text-[#059211] focus:ring-[#059211]"
              />
              <label htmlFor="zone-status" className="text-sm text-gray-700">
                Active
              </label>
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
              {editingZone ? 'Update Zone' : 'Create Zone'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
