'use client'

import Image from 'next/image'
import Link from 'next/link'
import { Star, Plus } from 'lucide-react'
import type { Item } from '@/types/nestjs/api'

interface ProductCardProps {
  item: Item
  onAddToCart?: (item: Item) => void
}

export function ProductCard({ item, onAddToCart }: ProductCardProps) {
  const discountedPrice =
    item.discount_type === 'percent'
      ? item.price - (item.price * item.discount) / 100
      : item.price - item.discount

  return (
    <div className="bg-white rounded-lg border shadow-sm overflow-hidden hover:shadow-md transition-shadow">
      <Link href={`/shop/items/${item.id}`}>
        <div className="relative aspect-square bg-gray-100">
          {item.image ? (
            <Image
              src={item.image}
              alt={item.name}
              fill
              className="object-cover"
              sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-gray-400 text-sm">
              No image
            </div>
          )}
          {item.discount > 0 && (
            <span className="absolute top-2 left-2 bg-red-500 text-white text-xs font-medium px-2 py-0.5 rounded">
              {item.discount_type === 'percent'
                ? `${item.discount}% OFF`
                : `₹${item.discount} OFF`}
            </span>
          )}
          {item.veg && (
            <span className="absolute top-2 right-2 w-5 h-5 border-2 border-green-600 rounded-sm flex items-center justify-center">
              <span className="w-2.5 h-2.5 bg-green-600 rounded-full" />
            </span>
          )}
        </div>
      </Link>

      <div className="p-3">
        <Link href={`/shop/items/${item.id}`}>
          <h3 className="text-sm font-medium text-gray-900 line-clamp-2 mb-1">
            {item.name}
          </h3>
        </Link>

        {item.store && (
          <p className="text-xs text-gray-500 mb-1 truncate">{item.store.name}</p>
        )}

        {item.avg_rating > 0 && (
          <div className="flex items-center gap-1 mb-2">
            <Star size={12} className="text-yellow-400 fill-yellow-400" />
            <span className="text-xs text-gray-600">
              {item.avg_rating.toFixed(1)} ({item.rating_count})
            </span>
          </div>
        )}

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <span className="text-sm font-semibold text-gray-900">
              ₹{discountedPrice.toFixed(0)}
            </span>
            {item.discount > 0 && (
              <span className="text-xs text-gray-400 line-through">
                ₹{item.price.toFixed(0)}
              </span>
            )}
          </div>

          {onAddToCart && (
            <button
              onClick={(e) => {
                e.preventDefault()
                onAddToCart(item)
              }}
              className="w-8 h-8 bg-primary text-white rounded-full flex items-center justify-center hover:bg-primary-hover transition-colors"
            >
              <Plus size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
