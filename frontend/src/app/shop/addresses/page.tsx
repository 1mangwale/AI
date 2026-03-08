'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import {
  MapPin, Plus, Pencil, Trash2, Home, Briefcase, MapPinned, ArrowLeft,
} from 'lucide-react'
import { nestjsDelivery } from '@/lib/api/nestjs/delivery'
import { useNestjsAuth } from '@/hooks/useNestjsAuth'
import { useToast } from '@/components/shared/Toast'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import type { DeliveryAddress } from '@/types/nestjs/api'

const addressTypeIcons: Record<string, React.ReactNode> = {
  home: <Home size={16} />,
  office: <Briefcase size={16} />,
  other: <MapPinned size={16} />,
}

interface AddressForm {
  address_type: 'home' | 'office' | 'other'
  contact_person_name: string
  contact_person_number: string
  address: string
  house: string
  road: string
  floor: string
  latitude: number
  longitude: number
}

const emptyForm: AddressForm = {
  address_type: 'home',
  contact_person_name: '',
  contact_person_number: '',
  address: '',
  house: '',
  road: '',
  floor: '',
  latitude: 0,
  longitude: 0,
}

export default function AddressesPage() {
  const { isAuthenticated, user } = useNestjsAuth()
  const toast = useToast()

  const [addresses, setAddresses] = useState<DeliveryAddress[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState<AddressForm>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)

  const fetchAddresses = useCallback(async () => {
    if (!isAuthenticated) {
      setLoading(false)
      return
    }
    try {
      const res = await nestjsDelivery.getAddresses()
      if (res.data) setAddresses(res.data)
    } catch {
      toast.error('Failed to load addresses')
    } finally {
      setLoading(false)
    }
  }, [isAuthenticated, toast])

  useEffect(() => {
    fetchAddresses()
  }, [fetchAddresses])

  const handleOpenAdd = () => {
    setEditingId(null)
    setForm({
      ...emptyForm,
      contact_person_name: user ? `${user.f_name} ${user.l_name}` : '',
      contact_person_number: user?.phone || '',
    })
    setShowForm(true)
  }

  const handleOpenEdit = (addr: DeliveryAddress) => {
    setEditingId(addr.id ?? null)
    setForm({
      address_type: addr.address_type,
      contact_person_name: addr.contact_person_name,
      contact_person_number: addr.contact_person_number,
      address: addr.address,
      house: addr.house || '',
      road: addr.road || '',
      floor: addr.floor || '',
      latitude: addr.latitude,
      longitude: addr.longitude,
    })
    setShowForm(true)
  }

  const handleGetLocation = () => {
    if (!navigator.geolocation) {
      toast.warning('Geolocation is not supported by your browser')
      return
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setForm((prev) => ({
          ...prev,
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        }))
        toast.success('Location captured')
      },
      () => {
        toast.error('Unable to get your location')
      }
    )
  }

  const handleSave = useCallback(async () => {
    if (!form.contact_person_name.trim()) {
      toast.warning('Contact name is required')
      return
    }
    if (!form.contact_person_number.trim()) {
      toast.warning('Contact number is required')
      return
    }
    if (!form.address.trim()) {
      toast.warning('Address is required')
      return
    }

    setSaving(true)
    try {
      const payload = {
        address_type: form.address_type,
        contact_person_name: form.contact_person_name.trim(),
        contact_person_number: form.contact_person_number.trim(),
        address: form.address.trim(),
        house: form.house.trim() || undefined,
        road: form.road.trim() || undefined,
        floor: form.floor.trim() || undefined,
        latitude: form.latitude,
        longitude: form.longitude,
      }

      if (editingId) {
        await nestjsDelivery.updateAddress(editingId, payload)
        toast.success('Address updated')
      } else {
        await nestjsDelivery.addAddress(payload as Omit<DeliveryAddress, 'id'>)
        toast.success('Address added')
      }
      setShowForm(false)
      fetchAddresses()
    } catch {
      toast.error('Failed to save address')
    } finally {
      setSaving(false)
    }
  }, [form, editingId, toast, fetchAddresses])

  const handleDelete = useCallback(async (id: number) => {
    setDeletingId(id)
    try {
      await nestjsDelivery.deleteAddress(id)
      toast.success('Address deleted')
      fetchAddresses()
    } catch {
      toast.error('Failed to delete address')
    } finally {
      setDeletingId(null)
    }
  }, [toast, fetchAddresses])

  const handleFieldChange = (field: keyof AddressForm, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  if (!isAuthenticated) {
    return (
      <div className="flex flex-col items-center justify-center py-20 px-4">
        <MapPin size={48} className="text-gray-300 mb-4" />
        <p className="text-gray-500 mb-4">Please login to manage addresses</p>
        <Link href="/shop/login">
          <Button className="bg-[#059211] hover:bg-[#047a0e] text-white">Login</Button>
        </Link>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <LoadingSpinner size="lg" text="Loading addresses..." />
      </div>
    )
  }

  return (
    <div className="px-4 py-4 pb-24">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <Link
          href="/shop/profile"
          className="w-9 h-9 flex items-center justify-center rounded-full bg-gray-100 hover:bg-gray-200"
        >
          <ArrowLeft size={18} className="text-gray-700" />
        </Link>
        <h1 className="text-lg font-bold text-gray-900 flex-1">My Addresses</h1>
        <Button
          onClick={handleOpenAdd}
          size="sm"
          className="bg-[#059211] hover:bg-[#047a0e] text-white"
        >
          <Plus size={14} className="mr-1" />
          Add
        </Button>
      </div>

      {/* Address List */}
      {addresses.length === 0 ? (
        <div className="text-center py-12">
          <MapPin size={40} className="text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500 text-sm mb-4">No addresses saved yet</p>
          <Button
            onClick={handleOpenAdd}
            className="bg-[#059211] hover:bg-[#047a0e] text-white"
          >
            Add Your First Address
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {addresses.map((addr) => (
            <div
              key={addr.id}
              className="bg-white rounded-xl border border-gray-100 shadow-sm p-4"
            >
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 bg-gray-100 rounded-full flex items-center justify-center text-gray-500 shrink-0 mt-0.5">
                  {addressTypeIcons[addr.address_type] || <MapPin size={16} />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-900 capitalize">
                    {addr.address_type}
                  </p>
                  <p className="text-xs text-gray-600 mt-0.5 line-clamp-2">{addr.address}</p>
                  {(addr.house || addr.road || addr.floor) && (
                    <p className="text-xs text-gray-400 mt-0.5">
                      {[addr.house, addr.floor, addr.road].filter(Boolean).join(', ')}
                    </p>
                  )}
                  <p className="text-xs text-gray-400 mt-1">
                    {addr.contact_person_name} - {addr.contact_person_number}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => handleOpenEdit(addr)}
                    className="p-2 text-gray-400 hover:text-[#059211] transition-colors"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    onClick={() => addr.id && handleDelete(addr.id)}
                    disabled={deletingId === addr.id}
                    className="p-2 text-gray-400 hover:text-red-500 transition-colors"
                  >
                    {deletingId === addr.id ? (
                      <LoadingSpinner size="sm" />
                    ) : (
                      <Trash2 size={14} />
                    )}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add/Edit Dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit Address' : 'Add New Address'}</DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            {/* Address Type */}
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1.5">
                Address Type
              </label>
              <div className="flex gap-2">
                {(['home', 'office', 'other'] as const).map((type) => (
                  <button
                    key={type}
                    onClick={() => setForm((p) => ({ ...p, address_type: type }))}
                    className={`flex-1 py-2 rounded-lg border text-xs font-medium capitalize transition-colors ${
                      form.address_type === type
                        ? 'border-[#059211] bg-[#059211]/5 text-[#059211]'
                        : 'border-gray-200 text-gray-600 hover:border-gray-300'
                    }`}
                  >
                    {type}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Contact Name
              </label>
              <Input
                value={form.contact_person_name}
                onChange={(e) => handleFieldChange('contact_person_name', e.target.value)}
                placeholder="Full name"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Contact Number
              </label>
              <Input
                type="tel"
                value={form.contact_person_number}
                onChange={(e) => handleFieldChange('contact_person_number', e.target.value.replace(/\D/g, '').slice(0, 10))}
                placeholder="Phone number"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Full Address
              </label>
              <Input
                value={form.address}
                onChange={(e) => handleFieldChange('address', e.target.value)}
                placeholder="Street address, area, city"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  House / Flat
                </label>
                <Input
                  value={form.house}
                  onChange={(e) => handleFieldChange('house', e.target.value)}
                  placeholder="e.g. 12B"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Floor
                </label>
                <Input
                  value={form.floor}
                  onChange={(e) => handleFieldChange('floor', e.target.value)}
                  placeholder="e.g. 3rd"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Road / Landmark
              </label>
              <Input
                value={form.road}
                onChange={(e) => handleFieldChange('road', e.target.value)}
                placeholder="Road name or nearby landmark"
              />
            </div>

            {/* Location */}
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Location
              </label>
              <div className="flex items-center gap-2">
                <div className="flex-1 text-xs text-gray-500 bg-gray-50 rounded-md p-2">
                  {form.latitude !== 0 && form.longitude !== 0 ? (
                    <span>
                      {form.latitude.toFixed(6)}, {form.longitude.toFixed(6)}
                    </span>
                  ) : (
                    <span className="text-gray-400">No location set</span>
                  )}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleGetLocation}
                >
                  <MapPin size={14} className="mr-1" />
                  Get
                </Button>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving}
              className="bg-[#059211] hover:bg-[#047a0e] text-white"
            >
              {saving ? <LoadingSpinner size="sm" /> : editingId ? 'Update' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
