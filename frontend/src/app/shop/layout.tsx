'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Home, Store, ShoppingCart, ClipboardList, User } from 'lucide-react'
import { useNestjsAuth } from '@/hooks/useNestjsAuth'
import { nestjsCart } from '@/lib/api/nestjs/cart'
import { ErrorBoundary } from '@/components/shared/ErrorBoundary'
import { CartBadge } from '@/components/shop/CartBadge'
import { SearchBar } from '@/components/shop/SearchBar'

const navItems = [
  { href: '/shop', label: 'Home', icon: Home },
  { href: '/shop/stores', label: 'Stores', icon: Store },
  { href: '/shop/cart', label: 'Cart', icon: ShoppingCart },
  { href: '/shop/orders', label: 'Orders', icon: ClipboardList },
  { href: '/shop/profile', label: 'Profile', icon: User },
]

export default function ShopLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const { isAuthenticated } = useNestjsAuth()
  const [cartCount, setCartCount] = useState(0)

  useEffect(() => {
    if (!isAuthenticated) return
    nestjsCart
      .get()
      .then((res) => {
        if (res.data) {
          setCartCount(res.data.items?.length ?? 0)
        }
      })
      .catch(() => {})
  }, [isAuthenticated, pathname])

  const isActive = (href: string) => {
    if (href === '/shop') return pathname === '/shop' || pathname === '/shop/'
    return pathname.startsWith(href)
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Top Header */}
      <header className="sticky top-0 z-40 bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-3">
          <div className="flex items-center gap-3">
            <Link href="/shop" className="shrink-0">
              <span className="text-xl font-bold text-[#059211]">Mangwale</span>
            </Link>
            <div className="flex-1">
              <SearchBar placeholder="Search items, stores..." />
            </div>
            <Link href="/shop/cart" className="relative shrink-0 p-2">
              <ShoppingCart size={22} className="text-gray-700" />
              {cartCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 w-5 h-5 bg-[#059211] text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                  {cartCount > 9 ? '9+' : cartCount}
                </span>
              )}
            </Link>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl mx-auto w-full">
        <ErrorBoundary>
          {children}
        </ErrorBoundary>
      </main>

      {/* Floating Cart Badge */}
      <CartBadge count={cartCount} />

      {/* Bottom Navigation */}
      <nav className="sticky bottom-0 z-40 bg-white border-t border-gray-200 shadow-[0_-2px_10px_rgba(0,0,0,0.05)]">
        <div className="max-w-7xl mx-auto flex items-center justify-around">
          {navItems.map(({ href, label, icon: Icon }) => {
            const active = isActive(href)
            return (
              <Link
                key={href}
                href={href}
                className={`flex flex-col items-center gap-0.5 py-2 px-3 min-w-[64px] transition-colors ${
                  active ? 'text-[#059211]' : 'text-gray-500'
                }`}
              >
                <div className="relative">
                  <Icon size={20} strokeWidth={active ? 2.5 : 2} />
                  {label === 'Cart' && cartCount > 0 && (
                    <span className="absolute -top-1.5 -right-2 w-4 h-4 bg-[#059211] text-white text-[9px] font-bold rounded-full flex items-center justify-center">
                      {cartCount > 9 ? '9+' : cartCount}
                    </span>
                  )}
                </div>
                <span className={`text-[10px] font-medium ${active ? 'font-semibold' : ''}`}>
                  {label}
                </span>
              </Link>
            )
          })}
        </div>
      </nav>
    </div>
  )
}
