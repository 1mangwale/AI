'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useNestjsAuth } from '@/hooks/useNestjsAuth'
import { nestjsAuth } from '@/lib/api/nestjs/auth'
import { useToast } from '@/components/shared/Toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Bike, ArrowRight, ArrowLeft, Loader2 } from 'lucide-react'

export default function RiderLoginPage() {
  const router = useRouter()
  const { riderLogin } = useNestjsAuth()
  const toast = useToast()

  const [step, setStep] = useState<'phone' | 'otp'>('phone')
  const [phone, setPhone] = useState('')
  const [otp, setOtp] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSendOtp = async () => {
    if (!phone || phone.length < 10) {
      toast.error('Please enter a valid phone number')
      return
    }

    setLoading(true)
    try {
      const res = await nestjsAuth.riderSendOtp(phone)
      if (res.success) {
        toast.success('OTP sent successfully')
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
  }

  const handleVerifyOtp = async () => {
    if (!otp || otp.length < 4) {
      toast.error('Please enter a valid OTP')
      return
    }

    setLoading(true)
    try {
      await riderLogin(phone, otp)
      toast.success('Login successful')
      router.push('/rider/dashboard')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Invalid OTP'
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#059211]/5 to-white flex flex-col items-center justify-center px-6">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex flex-col items-center mb-10">
          <div className="w-16 h-16 bg-[#059211] rounded-2xl flex items-center justify-center mb-4 shadow-lg shadow-[#059211]/20">
            <Bike size={32} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Rider Login</h1>
          <p className="text-sm text-gray-500 mt-1">Sign in with your phone number</p>
        </div>

        {step === 'phone' ? (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Phone Number
              </label>
              <Input
                type="tel"
                placeholder="Enter your phone number"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="h-12 text-base"
                maxLength={15}
              />
            </div>
            <Button
              onClick={handleSendOtp}
              disabled={loading || !phone}
              className="w-full h-12 bg-[#059211] hover:bg-[#047a0e] text-base font-medium"
            >
              {loading ? (
                <Loader2 className="animate-spin mr-2" size={20} />
              ) : null}
              Send OTP
              {!loading && <ArrowRight size={18} className="ml-2" />}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <button
              onClick={() => setStep('phone')}
              className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-2"
            >
              <ArrowLeft size={14} />
              Change number
            </button>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Enter OTP
              </label>
              <p className="text-xs text-gray-500 mb-2">
                Sent to {phone}
              </p>
              <Input
                type="text"
                inputMode="numeric"
                placeholder="Enter OTP"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                className="h-12 text-base text-center tracking-[0.5em] font-mono"
                maxLength={6}
              />
            </div>
            <Button
              onClick={handleVerifyOtp}
              disabled={loading || !otp}
              className="w-full h-12 bg-[#059211] hover:bg-[#047a0e] text-base font-medium"
            >
              {loading ? (
                <Loader2 className="animate-spin mr-2" size={20} />
              ) : null}
              Verify & Login
            </Button>
            <button
              onClick={handleSendOtp}
              disabled={loading}
              className="w-full text-sm text-[#059211] font-medium hover:underline"
            >
              Resend OTP
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
