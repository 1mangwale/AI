'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Phone, ArrowRight, ShieldCheck } from 'lucide-react'
import { nestjsAuth } from '@/lib/api/nestjs/auth'
import { useNestjsAuth } from '@/hooks/useNestjsAuth'
import { useToast } from '@/components/shared/Toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'

type Step = 'phone' | 'otp'

export default function LoginPage() {
  const router = useRouter()
  const { customerLogin } = useNestjsAuth()
  const toast = useToast()

  const [step, setStep] = useState<Step>('phone')
  const [phone, setPhone] = useState('')
  const [otp, setOtp] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSendOtp = useCallback(async () => {
    const trimmed = phone.trim()
    if (!trimmed || trimmed.length < 10) {
      toast.warning('Please enter a valid phone number')
      return
    }
    setLoading(true)
    try {
      const res = await nestjsAuth.sendOtp(trimmed)
      if (res.success) {
        toast.success('OTP sent to your phone')
        setStep('otp')
      } else {
        toast.error('Failed to send OTP')
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to send OTP'
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }, [phone, toast])

  const handleVerifyOtp = useCallback(async () => {
    if (!otp || otp.length < 4) {
      toast.warning('Please enter the OTP')
      return
    }
    setLoading(true)
    try {
      await customerLogin(phone.trim(), otp.trim())
      toast.success('Login successful!')
      router.push('/shop')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Invalid OTP'
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }, [phone, otp, customerLogin, toast, router])

  const handleKeyDown = (e: React.KeyboardEvent, action: () => void) => {
    if (e.key === 'Enter') action()
  }

  return (
    <div className="min-h-[calc(100vh-120px)] flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-[#059211]/10 rounded-full flex items-center justify-center mx-auto mb-4">
            {step === 'phone' ? (
              <Phone size={28} className="text-[#059211]" />
            ) : (
              <ShieldCheck size={28} className="text-[#059211]" />
            )}
          </div>
          <h1 className="text-2xl font-bold text-gray-900 mb-1">
            {step === 'phone' ? 'Welcome Back' : 'Verify OTP'}
          </h1>
          <p className="text-sm text-gray-500">
            {step === 'phone'
              ? 'Enter your phone number to get started'
              : `We sent a code to +91 ${phone}`}
          </p>
        </div>

        {/* Phone Step */}
        {step === 'phone' && (
          <div className="space-y-4">
            <div>
              <label htmlFor="phone" className="block text-sm font-medium text-gray-700 mb-1.5">
                Phone Number
              </label>
              <div className="flex gap-2">
                <div className="flex items-center px-3 bg-gray-100 border border-gray-200 rounded-md text-sm text-gray-600 shrink-0">
                  +91
                </div>
                <Input
                  id="phone"
                  type="tel"
                  placeholder="Enter phone number"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
                  onKeyDown={(e) => handleKeyDown(e, handleSendOtp)}
                  maxLength={10}
                  autoFocus
                />
              </div>
            </div>

            <Button
              onClick={handleSendOtp}
              disabled={loading || phone.length < 10}
              className="w-full bg-[#059211] hover:bg-[#047a0e] text-white"
            >
              {loading ? (
                <LoadingSpinner size="sm" />
              ) : (
                <>
                  Send OTP
                  <ArrowRight size={16} className="ml-2" />
                </>
              )}
            </Button>
          </div>
        )}

        {/* OTP Step */}
        {step === 'otp' && (
          <div className="space-y-4">
            <div>
              <label htmlFor="otp" className="block text-sm font-medium text-gray-700 mb-1.5">
                Enter OTP
              </label>
              <Input
                id="otp"
                type="text"
                inputMode="numeric"
                placeholder="Enter 4-6 digit OTP"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                onKeyDown={(e) => handleKeyDown(e, handleVerifyOtp)}
                maxLength={6}
                autoFocus
                className="text-center text-lg tracking-widest"
              />
            </div>

            <Button
              onClick={handleVerifyOtp}
              disabled={loading || otp.length < 4}
              className="w-full bg-[#059211] hover:bg-[#047a0e] text-white"
            >
              {loading ? (
                <LoadingSpinner size="sm" />
              ) : (
                'Verify & Login'
              )}
            </Button>

            <div className="flex items-center justify-between text-sm">
              <button
                onClick={() => {
                  setStep('phone')
                  setOtp('')
                }}
                className="text-gray-500 hover:text-gray-700"
              >
                Change number
              </button>
              <button
                onClick={handleSendOtp}
                disabled={loading}
                className="text-[#059211] hover:underline font-medium"
              >
                Resend OTP
              </button>
            </div>
          </div>
        )}

        {/* Register Link */}
        <div className="mt-8 text-center">
          <p className="text-sm text-gray-500">
            {"Don't have an account? "}
            <Link href="/shop/register" className="text-[#059211] font-medium hover:underline">
              Register
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
