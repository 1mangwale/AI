'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { nestjsDelivery } from '@/lib/api/nestjs/delivery'
import { useNestjsAuth } from '@/hooks/useNestjsAuth'
import { useNestjsAuthStore } from '@/store/nestjsAuthStore'
import { useToast } from '@/components/shared/Toast'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import {
  User,
  Phone,
  Mail,
  Truck,
  FileText,
  Building2,
  LogOut,
  Save,
  Loader2,
} from 'lucide-react'

interface RiderProfile {
  f_name: string
  l_name: string
  phone: string
  email: string
  vehicle_type?: string
  vehicle_number?: string
  identity_type?: string
  identity_number?: string
  bank_name?: string
  account_number?: string
  ifsc_code?: string
  [key: string]: unknown
}

export default function RiderProfilePage() {
  const router = useRouter()
  const { logout } = useNestjsAuth()
  const { user } = useNestjsAuthStore()
  const toast = useToast()

  const [profile, setProfile] = useState<RiderProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState(false)
  const [formData, setFormData] = useState<RiderProfile>({
    f_name: '',
    l_name: '',
    phone: '',
    email: '',
    vehicle_type: '',
    vehicle_number: '',
    identity_type: '',
    identity_number: '',
    bank_name: '',
    account_number: '',
    ifsc_code: '',
  })

  const fetchProfile = useCallback(async () => {
    setLoading(true)
    try {
      const res = await nestjsDelivery.rider.getProfile()
      if (res.success && res.data) {
        const data = res.data as RiderProfile
        setProfile(data)
        setFormData({
          f_name: data.f_name || '',
          l_name: data.l_name || '',
          phone: data.phone || '',
          email: data.email || '',
          vehicle_type: data.vehicle_type || '',
          vehicle_number: data.vehicle_number || '',
          identity_type: data.identity_type || '',
          identity_number: data.identity_number || '',
          bank_name: data.bank_name || '',
          account_number: data.account_number || '',
          ifsc_code: data.ifsc_code || '',
        })
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load profile'
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    fetchProfile()
  }, [fetchProfile])

  const handleSave = async () => {
    setSaving(true)
    try {
      const res = await nestjsDelivery.rider.updateProfile(formData)
      if (res.success) {
        setProfile(res.data as RiderProfile)
        setEditing(false)
        toast.success('Profile updated successfully')
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to update profile'
      toast.error(message)
    } finally {
      setSaving(false)
    }
  }

  const handleLogout = async () => {
    await logout('/rider/login')
  }

  const handleChange = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }))
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <LoadingSpinner text="Loading profile..." />
      </div>
    )
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">Profile</h1>
        {!editing ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setEditing(true)}
          >
            Edit Profile
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEditing(false)
                if (profile) {
                  setFormData({
                    f_name: profile.f_name || '',
                    l_name: profile.l_name || '',
                    phone: profile.phone || '',
                    email: profile.email || '',
                    vehicle_type: profile.vehicle_type || '',
                    vehicle_number: profile.vehicle_number || '',
                    identity_type: profile.identity_type || '',
                    identity_number: profile.identity_number || '',
                    bank_name: profile.bank_name || '',
                    account_number: profile.account_number || '',
                    ifsc_code: profile.ifsc_code || '',
                  })
                }
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={saving}
              className="bg-[#059211] hover:bg-[#047a0e]"
            >
              {saving ? (
                <Loader2 className="animate-spin mr-1" size={14} />
              ) : (
                <Save size={14} className="mr-1" />
              )}
              Save
            </Button>
          </div>
        )}
      </div>

      {/* Avatar */}
      <div className="flex flex-col items-center py-4">
        <div className="w-20 h-20 bg-[#059211]/10 rounded-full flex items-center justify-center mb-2">
          <User size={36} className="text-[#059211]" />
        </div>
        <p className="text-lg font-semibold text-gray-900">
          {user?.f_name} {user?.l_name}
        </p>
        <p className="text-sm text-gray-500">{user?.phone}</p>
      </div>

      {/* Personal Info */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
            <User size={14} /> Personal Information
          </h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">First Name</label>
              {editing ? (
                <Input
                  value={formData.f_name}
                  onChange={(e) => handleChange('f_name', e.target.value)}
                  className="h-9 text-sm"
                />
              ) : (
                <p className="text-sm font-medium text-gray-900">{profile?.f_name || '-'}</p>
              )}
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Last Name</label>
              {editing ? (
                <Input
                  value={formData.l_name}
                  onChange={(e) => handleChange('l_name', e.target.value)}
                  className="h-9 text-sm"
                />
              ) : (
                <p className="text-sm font-medium text-gray-900">{profile?.l_name || '-'}</p>
              )}
            </div>
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block flex items-center gap-1">
              <Phone size={10} /> Phone
            </label>
            <p className="text-sm font-medium text-gray-900">{profile?.phone || '-'}</p>
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block flex items-center gap-1">
              <Mail size={10} /> Email
            </label>
            {editing ? (
              <Input
                type="email"
                value={formData.email}
                onChange={(e) => handleChange('email', e.target.value)}
                className="h-9 text-sm"
              />
            ) : (
              <p className="text-sm font-medium text-gray-900">{profile?.email || '-'}</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Vehicle Info */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
            <Truck size={14} /> Vehicle Information
          </h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Vehicle Type</label>
              {editing ? (
                <Input
                  value={formData.vehicle_type}
                  onChange={(e) => handleChange('vehicle_type', e.target.value)}
                  className="h-9 text-sm"
                  placeholder="e.g., Bike, Scooter"
                />
              ) : (
                <p className="text-sm font-medium text-gray-900">{profile?.vehicle_type || '-'}</p>
              )}
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Vehicle Number</label>
              {editing ? (
                <Input
                  value={formData.vehicle_number}
                  onChange={(e) => handleChange('vehicle_number', e.target.value)}
                  className="h-9 text-sm"
                  placeholder="e.g., KA-01-AB-1234"
                />
              ) : (
                <p className="text-sm font-medium text-gray-900">{profile?.vehicle_number || '-'}</p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Documents */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
            <FileText size={14} /> Documents
          </h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">ID Type</label>
              {editing ? (
                <Input
                  value={formData.identity_type}
                  onChange={(e) => handleChange('identity_type', e.target.value)}
                  className="h-9 text-sm"
                  placeholder="e.g., Aadhaar, PAN"
                />
              ) : (
                <p className="text-sm font-medium text-gray-900">{profile?.identity_type || '-'}</p>
              )}
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">ID Number</label>
              {editing ? (
                <Input
                  value={formData.identity_number}
                  onChange={(e) => handleChange('identity_number', e.target.value)}
                  className="h-9 text-sm"
                />
              ) : (
                <p className="text-sm font-medium text-gray-900">{profile?.identity_number || '-'}</p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Bank Details */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
            <Building2 size={14} /> Bank Details
          </h3>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Bank Name</label>
            {editing ? (
              <Input
                value={formData.bank_name}
                onChange={(e) => handleChange('bank_name', e.target.value)}
                className="h-9 text-sm"
              />
            ) : (
              <p className="text-sm font-medium text-gray-900">{profile?.bank_name || '-'}</p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Account Number</label>
              {editing ? (
                <Input
                  value={formData.account_number}
                  onChange={(e) => handleChange('account_number', e.target.value)}
                  className="h-9 text-sm"
                />
              ) : (
                <p className="text-sm font-medium text-gray-900">{profile?.account_number || '-'}</p>
              )}
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">IFSC Code</label>
              {editing ? (
                <Input
                  value={formData.ifsc_code}
                  onChange={(e) => handleChange('ifsc_code', e.target.value)}
                  className="h-9 text-sm"
                />
              ) : (
                <p className="text-sm font-medium text-gray-900">{profile?.ifsc_code || '-'}</p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Logout */}
      <Button
        variant="destructive"
        onClick={handleLogout}
        className="w-full h-12"
      >
        <LogOut size={18} className="mr-2" />
        Logout
      </Button>

      <div className="h-4" />
    </div>
  )
}
