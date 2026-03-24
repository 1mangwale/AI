'use client'

import { useState, useEffect } from 'react'
import { X, Phone, Lock, User, Mail } from 'lucide-react'
import { api } from '@/lib/api'
import { useAuthStore } from '@/store/authStore'
import Script from 'next/script'

// Google OAuth types
declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: any) => void
          renderButton: (element: HTMLElement, config: any) => void
          prompt: () => void
        }
      }
    }
    FB?: {
      init: (params: any) => void
      login: (callback: (response: any) => void, options?: any) => void
      api: (path: string, callback: (response: any) => void) => void
    }
  }
}

interface InlineLoginProps {
  onClose: () => void
  onSuccess: (data: { phone: string; token: string; userId: number; userName?: string }) => void
}

type ApiError = {
  response?: {
    data?: {
      message?: string
    }
  }
}

const getErrorMessage = (err: unknown, fallback: string) => {
  if (typeof err === 'object' && err !== null) {
    const apiError = err as ApiError
    return apiError.response?.data?.message ?? fallback
  }
  return fallback
}

// JWT decode helper - extract payload from Google ID token
function parseJwt(token: string) {
  try {
    const base64Url = token.split('.')[1]
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/')
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    )
    return JSON.parse(jsonPayload)
  } catch {
    return null
  }
}

export function InlineLogin({ onClose, onSuccess }: InlineLoginProps) {
  const [step, setStep] = useState<'phone' | 'otp' | 'register'>('phone')
  const [phone, setPhone] = useState('')
  const [otp, setOtp] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [googleScriptLoaded, setGoogleScriptLoaded] = useState(false)
  const [googleInitialized, setGoogleInitialized] = useState(false)
  const [fbLoaded, setFbLoaded] = useState(false)

  const { setAuth } = useAuthStore()

  // Initialize Google OAuth after script loads
  useEffect(() => {
    if (googleScriptLoaded && !googleInitialized && window.google?.accounts?.id) {
      try {
        window.google.accounts.id.initialize({
          client_id: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || '',
          callback: handleGoogleLoginCallback,
        })
        setGoogleInitialized(true)
      } catch (err) {
        console.error('Failed to initialize Google OAuth:', err)
      }
    }
  }, [googleScriptLoaded, googleInitialized])

  // Helper: handle social login result (shared by Google and Facebook)
  const handleSocialLoginResult = (data: any) => {
    const { token, user } = data

    if (token && user && user.is_personal_info !== 0) {
      // Existing user with complete profile — login success
      console.log('✅ Social login successful:', { userId: user?.id })
      setAuth(user, token)
      onSuccess({ phone: user?.phone || '', token, userId: user?.id, userName: user?.f_name })
    } else if (data.is_personal_info === 0 || user?.is_personal_info === 0 || data.needs_phone) {
      // New user — needs phone + OTP to complete registration
      console.log('👤 New user from social login - needs phone registration')
      if (user?.f_name) setFirstName(user.f_name)
      if (user?.l_name) setLastName(user.l_name)
      if (user?.email) setEmail(user.email)
      setStep('phone')
      setError('Please enter your phone number to complete registration.')
    } else if (token && user) {
      // User with token but is_personal_info check passed
      setAuth(user, token)
      onSuccess({ phone: user?.phone || '', token, userId: user?.id, userName: user?.f_name })
    } else {
      setError('Login failed. Please try with phone number instead.')
    }
  }

  const handleGoogleLoginCallback = async (response: any) => {
    setLoading(true)
    setError('')

    try {
      // Decode JWT to get user's unique Google ID (sub claim)
      const payload = parseJwt(response.credential)
      if (!payload) {
        setError('Failed to parse Google response. Please try again.')
        setLoading(false)
        return
      }

      const result = await api.auth.socialLogin({
        token: response.credential,
        unique_id: payload.sub,
        email: payload.email || '',
        medium: 'google'
      })

      // Pre-fill name from Google if available
      if (payload.given_name && !firstName) setFirstName(payload.given_name)
      if (payload.family_name && !lastName) setLastName(payload.family_name)
      if (payload.email && !email) setEmail(payload.email)

      handleSocialLoginResult(result.data)
    } catch (err: unknown) {
      console.error('❌ Google login failed:', err)
      setError(getErrorMessage(err, 'Google login failed. Please try again.'))
    } finally {
      setLoading(false)
    }
  }

  const handleGoogleButtonClick = () => {
    if (!window.google?.accounts?.id) {
      setError('Google Sign-In is loading. Please try again in a moment.')
      return
    }

    try {
      // Re-initialize with fresh callback to avoid stale closures
      window.google.accounts.id.initialize({
        client_id: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || '',
        callback: handleGoogleLoginCallback,
      })
      window.google.accounts.id.prompt()
    } catch (err) {
      console.error('Failed to trigger Google Sign-In:', err)
      setError('Failed to open Google Sign-In. Please try again.')
    }
  }

  const handleFacebookLogin = async () => {
    if (!window.FB) {
      setError('Facebook login is loading. Please try again in a moment.')
      return
    }

    setLoading(true)
    setError('')

    try {
      window.FB.login((response) => {
        if (response.authResponse) {
          const { accessToken, userID } = response.authResponse

          window.FB?.api('/me?fields=id,name,email', async (userInfo) => {
            try {
              const result = await api.auth.socialLogin({
                token: accessToken,
                unique_id: userID,
                email: userInfo.email || '',
                medium: 'facebook'
              })

              handleSocialLoginResult(result.data)
            } catch (err: unknown) {
              console.error('❌ Facebook login failed:', err)
              setError(getErrorMessage(err, 'Facebook login failed. Please try again.'))
            } finally {
              setLoading(false)
            }
          })
        } else {
          setError('Facebook login was cancelled.')
          setLoading(false)
        }
      }, { scope: 'public_profile,email' })
    } catch (err: unknown) {
      console.error('❌ Facebook login error:', err)
      setError('Facebook login failed. Please try again.')
      setLoading(false)
    }
  }

  const handleSendOtp = async () => {
    if (phone.length !== 10) {
      setError('Please enter a valid 10-digit phone number')
      return
    }

    setLoading(true)
    setError('')

    try {
      await api.auth.sendOtp(phone)
      setStep('otp')
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Failed to send OTP. Please try again.'))
    } finally {
      setLoading(false)
    }
  }

  const handleVerifyOtp = async () => {
    if (otp.length !== 6) {
      setError('Please enter a valid 6-digit OTP')
      return
    }

    setLoading(true)
    setError('')

    try {
      const response = await api.auth.verifyOtp(phone, otp)
      const { token, user } = response.data

      if (user?.is_personal_info === 0) {
        console.log('👤 New user - needs registration')
        setStep('register')
      } else {
        console.log('✅ Existing user - logging in')
        setAuth(user, token)
        onSuccess({ phone, token, userId: user?.id, userName: user?.f_name })
      }
    } catch (err: unknown) {
      console.error('❌ OTP verification failed:', err)
      setError(getErrorMessage(err, 'Invalid OTP. Please try again.'))
    } finally {
      setLoading(false)
    }
  }

  const handleRegister = async () => {
    if (!firstName || !email) {
      setError('Please fill in all required fields')
      return
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      setError('Please enter a valid email address')
      return
    }

    setLoading(true)
    setError('')

    try {
      const response = await api.auth.updateUserInfo({
        phone: phone,
        f_name: firstName.trim(),
        l_name: lastName?.trim() || '',
        email: email.trim()
      })

      const { token, user } = response.data
      setAuth(user, token)
      onSuccess({ phone, token, userId: user?.id, userName: user?.f_name })
    } catch (err: unknown) {
      console.error('❌ Registration failed:', err)
      setError(getErrorMessage(err, 'Failed to complete registration. Please try again.'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      {/* Load Google OAuth Script */}
      <Script
        src="https://accounts.google.com/gsi/client"
        strategy="lazyOnload"
        onLoad={() => setGoogleScriptLoaded(true)}
      />
      {/* Load Facebook SDK */}
      <Script
        src="https://connect.facebook.net/en_US/sdk.js"
        strategy="lazyOnload"
        onLoad={() => {
          window.FB?.init({
            appId: process.env.NEXT_PUBLIC_FACEBOOK_APP_ID || '',
            cookie: true,
            xfbml: true,
            version: 'v18.0'
          })
          setFbLoaded(true)
        }}
      />

      <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-[200]">
      <div className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl max-w-md w-full p-6 relative animate-slide-up max-h-[90vh] overflow-y-auto">
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-400 hover:text-gray-600"
        >
          <X className="w-6 h-6" />
        </button>

        {/* Header */}
        <div className="text-center mb-6">
          <h2 className="text-2xl font-bold text-gray-900">
            {step === 'phone' && 'Login to Continue'}
            {step === 'otp' && 'Verify OTP'}
            {step === 'register' && 'Complete Your Profile'}
          </h2>
          <p className="text-gray-500 mt-2">
            {step === 'phone' && 'Enter your phone number to get started'}
            {step === 'otp' && `We sent a code to ${phone}`}
            {step === 'register' && 'Just a few more details'}
          </p>
        </div>

        {/* Error Message */}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4">
            {error}
          </div>
        )}

        {/* Phone Step */}
        {step === 'phone' && (
          <div className="space-y-4">
            {/* OAuth Providers */}
            <div className="space-y-3">
              <button
                onClick={handleGoogleButtonClick}
                disabled={loading}
                className="w-full flex items-center justify-center gap-3 px-4 py-3 border-2 border-gray-300 rounded-lg hover:bg-gray-50 transition-colors font-medium text-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
                {loading ? 'Connecting...' : 'Continue with Google'}
              </button>

              <button
                onClick={handleFacebookLogin}
                disabled={loading || !fbLoaded}
                className="w-full flex items-center justify-center gap-3 px-4 py-3 border-2 border-gray-300 rounded-lg hover:bg-gray-50 transition-colors font-medium text-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <svg className="w-5 h-5" fill="#1877F2" viewBox="0 0 24 24">
                  <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
                </svg>
                {fbLoaded ? 'Continue with Facebook' : 'Loading Facebook...'}
              </button>
            </div>

            {/* Divider */}
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-gray-300"></div>
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="px-2 bg-white text-gray-500">Or continue with phone</span>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Phone Number
              </label>
              <div className="relative">
                <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
                  placeholder="10-digit mobile number"
                  className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  maxLength={10}
                />
              </div>
            </div>

            <button
              onClick={handleSendOtp}
              disabled={loading || phone.length !== 10}
              className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? 'Sending...' : 'Send OTP'}
            </button>
          </div>
        )}

        {/* OTP Step */}
        {step === 'otp' && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Enter OTP
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input
                  type="text"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="6-digit OTP"
                  className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-center text-2xl tracking-widest"
                  maxLength={6}
                />
              </div>
            </div>

            <button
              onClick={handleVerifyOtp}
              disabled={loading || otp.length !== 6}
              className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? 'Verifying...' : 'Verify OTP'}
            </button>

            <div className="flex gap-3">
              <button
                onClick={handleSendOtp}
                disabled={loading}
                className="flex-1 text-blue-600 py-2 text-sm hover:text-blue-800 font-medium border border-blue-200 rounded-lg hover:bg-blue-50 transition-colors"
              >
                Resend OTP
              </button>
              <button
                onClick={() => setStep('phone')}
                className="flex-1 text-gray-600 py-2 text-sm hover:text-gray-800 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Change Number
              </button>
            </div>
          </div>
        )}

        {/* Registration Step */}
        {step === 'register' && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                First Name <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  placeholder="Enter your first name"
                  className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Last Name
              </label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  placeholder="Enter your last name (optional)"
                  className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Email <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="your@email.com"
                  className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
            </div>

            <button
              onClick={handleRegister}
              disabled={loading || !firstName || !email}
              className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? 'Completing...' : 'Complete Registration'}
            </button>
          </div>
        )}
      </div>
    </div>
    </>
  )
}
