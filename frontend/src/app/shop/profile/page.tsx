'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  User, MapPin, Wallet, Heart, LogOut, ChevronRight, HelpCircle,
  FileText, Shield,
} from 'lucide-react'
import { nestjsAuth } from '@/lib/api/nestjs/auth'
import { useNestjsAuth } from '@/hooks/useNestjsAuth'
import { useToast } from '@/components/shared/Toast'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import type { NestjsUser } from '@/types/nestjs/api'

interface ProfileForm {
  f_name: string
  l_name: string
  email: string
  phone: string
}

export default function ProfilePage() {
  const router = useRouter()
  const { user, isAuthenticated, logout } = useNestjsAuth()
  const toast = useToast()

  const [form, setForm] = useState<ProfileForm>({
    f_name: '',
    l_name: '',
    email: '',
    phone: '',
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    if (!isAuthenticated) {
      setLoading(false)
      return
    }
    nestjsAuth
      .getProfile()
      .then((res) => {
        if (res.data) {
          const u = res.data
          setForm({
            f_name: u.f_name || '',
            l_name: u.l_name || '',
            email: u.email || '',
            phone: u.phone || '',
          })
        }
      })
      .catch(() => {
        // Use local data if API fails
        if (user) {
          setForm({
            f_name: user.f_name || '',
            l_name: user.l_name || '',
            email: user.email || '',
            phone: user.phone || '',
          })
        }
      })
      .finally(() => setLoading(false))
  }, [isAuthenticated, user])

  const handleSave = useCallback(async () => {
    if (!form.f_name.trim() || !form.l_name.trim()) {
      toast.warning('Name is required')
      return
    }
    setSaving(true)
    try {
      await nestjsAuth.updateProfile({
        f_name: form.f_name.trim(),
        l_name: form.l_name.trim(),
        email: form.email.trim(),
      } as Partial<NestjsUser>)
      toast.success('Profile updated')
      setEditing(false)
    } catch {
      toast.error('Failed to update profile')
    } finally {
      setSaving(false)
    }
  }, [form, toast])

  const handleLogout = useCallback(async () => {
    await logout('/shop/login')
  }, [logout])

  if (!isAuthenticated) {
    return (
      <div className="flex flex-col items-center justify-center py-20 px-4">
        <User size={48} className="text-gray-300 mb-4" />
        <p className="text-gray-500 mb-4">Please login to view your profile</p>
        <Link href="/shop/login">
          <Button className="bg-[#059211] hover:bg-[#047a0e] text-white">Login</Button>
        </Link>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <LoadingSpinner size="lg" text="Loading profile..." />
      </div>
    )
  }

  const menuItems = [
    { href: '/shop/orders', label: 'My Orders', icon: FileText },
    { href: '/shop/addresses', label: 'My Addresses', icon: MapPin },
    { href: '/shop/wallet', label: 'Wallet', icon: Wallet },
  ]

  return (
    <div className="px-4 py-4 pb-24">
      {/* Profile Header */}
      <div className="flex items-center gap-4 mb-6">
        <div className="w-16 h-16 bg-[#059211]/10 rounded-full flex items-center justify-center shrink-0">
          <User size={28} className="text-[#059211]" />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold text-gray-900 truncate">
            {form.f_name} {form.l_name}
          </h1>
          <p className="text-sm text-gray-500">{form.phone}</p>
        </div>
        <button
          onClick={() => setEditing(!editing)}
          className="text-sm text-[#059211] font-medium hover:underline"
        >
          {editing ? 'Cancel' : 'Edit'}
        </button>
      </div>

      {/* Edit Profile Form */}
      {editing && (
        <Card className="mb-6">
          <CardContent className="p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  First Name
                </label>
                <Input
                  value={form.f_name}
                  onChange={(e) => setForm((p) => ({ ...p, f_name: e.target.value }))}
                  placeholder="First name"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Last Name
                </label>
                <Input
                  value={form.l_name}
                  onChange={(e) => setForm((p) => ({ ...p, l_name: e.target.value }))}
                  placeholder="Last name"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Email
              </label>
              <Input
                type="email"
                value={form.email}
                onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
                placeholder="Email"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Phone
              </label>
              <Input value={form.phone} disabled className="bg-gray-50" />
              <p className="text-[10px] text-gray-400 mt-1">Phone number cannot be changed</p>
            </div>
            <Button
              onClick={handleSave}
              disabled={saving}
              className="w-full bg-[#059211] hover:bg-[#047a0e] text-white"
            >
              {saving ? <LoadingSpinner size="sm" /> : 'Save Changes'}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Menu Items */}
      <div className="space-y-1 mb-6">
        {menuItems.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <Icon size={20} className="text-gray-500" />
            <span className="flex-1 text-sm font-medium text-gray-800">{label}</span>
            <ChevronRight size={16} className="text-gray-400" />
          </Link>
        ))}
      </div>

      {/* Divider */}
      <div className="border-t border-gray-100 my-4" />

      {/* Info Links */}
      <div className="space-y-1 mb-6">
        <Link
          href="/shop/search"
          className="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-50 transition-colors"
        >
          <Heart size={20} className="text-gray-500" />
          <span className="flex-1 text-sm font-medium text-gray-800">Search Items</span>
          <ChevronRight size={16} className="text-gray-400" />
        </Link>
        <button
          className="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-50 transition-colors w-full text-left"
        >
          <HelpCircle size={20} className="text-gray-500" />
          <span className="flex-1 text-sm font-medium text-gray-800">Help & Support</span>
          <ChevronRight size={16} className="text-gray-400" />
        </button>
        <button
          className="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-50 transition-colors w-full text-left"
        >
          <Shield size={20} className="text-gray-500" />
          <span className="flex-1 text-sm font-medium text-gray-800">Privacy Policy</span>
          <ChevronRight size={16} className="text-gray-400" />
        </button>
      </div>

      {/* Logout */}
      <Button
        onClick={handleLogout}
        variant="outline"
        className="w-full border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
      >
        <LogOut size={16} className="mr-2" />
        Logout
      </Button>
    </div>
  )
}
