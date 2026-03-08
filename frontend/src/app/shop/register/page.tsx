'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { UserPlus } from 'lucide-react'
import { useNestjsAuth } from '@/hooks/useNestjsAuth'
import { useToast } from '@/components/shared/Toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'

interface FormData {
  f_name: string
  l_name: string
  email: string
  phone: string
}

interface FormErrors {
  f_name?: string
  l_name?: string
  email?: string
  phone?: string
}

export default function RegisterPage() {
  const router = useRouter()
  const { register } = useNestjsAuth()
  const toast = useToast()

  const [form, setForm] = useState<FormData>({
    f_name: '',
    l_name: '',
    email: '',
    phone: '',
  })
  const [errors, setErrors] = useState<FormErrors>({})
  const [loading, setLoading] = useState(false)

  const validate = (): boolean => {
    const newErrors: FormErrors = {}
    if (!form.f_name.trim()) newErrors.f_name = 'First name is required'
    if (!form.l_name.trim()) newErrors.l_name = 'Last name is required'
    if (!form.email.trim()) {
      newErrors.email = 'Email is required'
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      newErrors.email = 'Enter a valid email'
    }
    if (!form.phone.trim()) {
      newErrors.phone = 'Phone is required'
    } else if (form.phone.length < 10) {
      newErrors.phone = 'Enter a valid 10-digit phone number'
    }
    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleChange = (field: keyof FormData, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }))
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: undefined }))
    }
  }

  const handleSubmit = useCallback(async () => {
    if (!validate()) return
    setLoading(true)
    try {
      await register({
        f_name: form.f_name.trim(),
        l_name: form.l_name.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
      })
      toast.success('Registration successful!')
      router.push('/shop')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Registration failed'
      toast.error(message)
    } finally {
      setLoading(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, register, toast, router])

  return (
    <div className="min-h-[calc(100vh-120px)] flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-[#059211]/10 rounded-full flex items-center justify-center mx-auto mb-4">
            <UserPlus size={28} className="text-[#059211]" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 mb-1">Create Account</h1>
          <p className="text-sm text-gray-500">Join Mangwale to start ordering</p>
        </div>

        {/* Form */}
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="f_name" className="block text-sm font-medium text-gray-700 mb-1">
                First Name
              </label>
              <Input
                id="f_name"
                placeholder="First name"
                value={form.f_name}
                onChange={(e) => handleChange('f_name', e.target.value)}
                className={errors.f_name ? 'border-red-400' : ''}
              />
              {errors.f_name && (
                <p className="text-xs text-red-500 mt-1">{errors.f_name}</p>
              )}
            </div>
            <div>
              <label htmlFor="l_name" className="block text-sm font-medium text-gray-700 mb-1">
                Last Name
              </label>
              <Input
                id="l_name"
                placeholder="Last name"
                value={form.l_name}
                onChange={(e) => handleChange('l_name', e.target.value)}
                className={errors.l_name ? 'border-red-400' : ''}
              />
              {errors.l_name && (
                <p className="text-xs text-red-500 mt-1">{errors.l_name}</p>
              )}
            </div>
          </div>

          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
              Email
            </label>
            <Input
              id="email"
              type="email"
              placeholder="you@example.com"
              value={form.email}
              onChange={(e) => handleChange('email', e.target.value)}
              className={errors.email ? 'border-red-400' : ''}
            />
            {errors.email && (
              <p className="text-xs text-red-500 mt-1">{errors.email}</p>
            )}
          </div>

          <div>
            <label htmlFor="phone" className="block text-sm font-medium text-gray-700 mb-1">
              Phone Number
            </label>
            <div className="flex gap-2">
              <div className="flex items-center px-3 bg-gray-100 border border-gray-200 rounded-md text-sm text-gray-600 shrink-0">
                +91
              </div>
              <Input
                id="phone"
                type="tel"
                placeholder="10-digit number"
                value={form.phone}
                onChange={(e) => handleChange('phone', e.target.value.replace(/\D/g, '').slice(0, 10))}
                maxLength={10}
                className={errors.phone ? 'border-red-400' : ''}
              />
            </div>
            {errors.phone && (
              <p className="text-xs text-red-500 mt-1">{errors.phone}</p>
            )}
          </div>

          <Button
            onClick={handleSubmit}
            disabled={loading}
            className="w-full bg-[#059211] hover:bg-[#047a0e] text-white"
          >
            {loading ? <LoadingSpinner size="sm" /> : 'Create Account'}
          </Button>
        </div>

        {/* Login Link */}
        <div className="mt-8 text-center">
          <p className="text-sm text-gray-500">
            Already have an account?{' '}
            <Link href="/shop/login" className="text-[#059211] font-medium hover:underline">
              Login
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
