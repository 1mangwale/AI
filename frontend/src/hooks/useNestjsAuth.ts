'use client'

import { useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useNestjsAuthStore } from '@/store/nestjsAuthStore'
import { nestjsAuth } from '@/lib/api/nestjs/auth'
import type { NestjsUser } from '@/types/nestjs/api'

export function useNestjsAuth() {
  const router = useRouter()
  const { user, token, isAuthenticated, userType, setAuth, clearAuth } = useNestjsAuthStore()

  const customerLogin = useCallback(async (phone: string, otp: string) => {
    const res = await nestjsAuth.verifyOtp(phone, otp)
    if (res.success && res.data) {
      setAuth(res.data.user, res.data.token)
      return res.data.user
    }
    throw new Error('Login failed')
  }, [setAuth])

  const vendorLogin = useCallback(async (email: string, password: string) => {
    const res = await nestjsAuth.vendorLogin(email, password)
    if (res.success && res.data) {
      setAuth(res.data.user, res.data.token)
      return res.data.user
    }
    throw new Error('Login failed')
  }, [setAuth])

  const riderLogin = useCallback(async (phone: string, otp: string) => {
    const res = await nestjsAuth.riderVerifyOtp(phone, otp)
    if (res.success && res.data) {
      setAuth(res.data.user, res.data.token)
      return res.data.user
    }
    throw new Error('Login failed')
  }, [setAuth])

  const register = useCallback(async (data: { f_name: string; l_name: string; email: string; phone: string }) => {
    const res = await nestjsAuth.register(data)
    if (res.success && res.data) {
      setAuth(res.data.user, res.data.token)
      return res.data.user
    }
    throw new Error('Registration failed')
  }, [setAuth])

  const logout = useCallback(async (redirectTo?: string) => {
    try {
      await nestjsAuth.logout()
    } catch {
      // Ignore logout errors
    }
    clearAuth()
    if (redirectTo) {
      router.push(redirectTo)
    }
  }, [clearAuth, router])

  return {
    user,
    token,
    isAuthenticated,
    userType,
    customerLogin,
    vendorLogin,
    riderLogin,
    register,
    logout,
  }
}
