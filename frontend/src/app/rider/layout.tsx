'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useNestjsAuthStore } from '@/store/nestjsAuthStore'
import { Package, DollarSign, User, Bike } from 'lucide-react'

const AUTH_FREE_PATHS = ['/rider/login']

const bottomTabs = [
  { name: 'Deliveries', href: '/rider/orders', icon: Package },
  { name: 'Earnings', href: '/rider/earnings', icon: DollarSign },
  { name: 'Profile', href: '/rider/profile', icon: User },
]

export default function RiderLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const { isAuthenticated, userType, _hasHydrated } = useNestjsAuthStore()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  const isLoginPage = pathname === '/rider/login'

  useEffect(() => {
    if (!_hasHydrated || !mounted) return

    if (!isAuthenticated && !isLoginPage) {
      router.push('/rider/login')
      return
    }

    if (isAuthenticated && userType !== 'delivery_man' && !isLoginPage) {
      router.push('/rider/login')
      return
    }
  }, [_hasHydrated, isAuthenticated, userType, isLoginPage, router, mounted])

  if (!mounted || !_hasHydrated) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-[#059211]/30 border-t-[#059211] rounded-full animate-spin" />
      </div>
    )
  }

  if (isLoginPage) {
    return <>{children}</>
  }

  if (!isAuthenticated || userType !== 'delivery_man') {
    return null
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col max-w-md mx-auto">
      {/* Top Bar */}
      <header className="sticky top-0 z-20 bg-white border-b px-4 h-14 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-[#059211] rounded-lg flex items-center justify-center">
            <Bike size={18} className="text-white" />
          </div>
          <span className="text-lg font-bold text-gray-900">Rider</span>
        </div>
        <Link href="/rider/profile">
          <div className="w-8 h-8 bg-gray-100 rounded-full flex items-center justify-center">
            <User size={16} className="text-gray-600" />
          </div>
        </Link>
      </header>

      {/* Content */}
      <main className="flex-1 overflow-y-auto pb-20">
        {children}
      </main>

      {/* Bottom Nav */}
      <nav className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-md bg-white border-t z-20">
        <div className="flex items-center justify-around h-16">
          {bottomTabs.map((tab) => {
            const isActive = pathname.startsWith(tab.href) ||
              (tab.href === '/rider/orders' && pathname === '/rider/dashboard')
            return (
              <Link
                key={tab.name}
                href={tab.href}
                className={`flex flex-col items-center gap-1 px-4 py-2 transition-colors ${
                  isActive ? 'text-[#059211]' : 'text-gray-400'
                }`}
              >
                <tab.icon size={20} />
                <span className="text-[10px] font-medium">{tab.name}</span>
              </Link>
            )
          })}
        </div>
      </nav>
    </div>
  )
}
