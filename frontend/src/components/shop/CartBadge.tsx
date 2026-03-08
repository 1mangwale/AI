'use client'

import Link from 'next/link'
import { ShoppingCart } from 'lucide-react'

interface CartBadgeProps {
  count: number
}

export function CartBadge({ count }: CartBadgeProps) {
  if (count <= 0) return null

  return (
    <Link
      href="/shop/cart"
      className="fixed bottom-20 right-4 z-50 bg-primary text-white rounded-full shadow-lg flex items-center gap-2 px-4 py-3 hover:bg-primary-hover transition-colors"
    >
      <ShoppingCart size={20} />
      <span className="text-sm font-semibold">{count} items</span>
    </Link>
  )
}
