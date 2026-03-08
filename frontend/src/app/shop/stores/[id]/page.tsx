'use client'

import { useState, useEffect, use } from 'react'
import Image from 'next/image'
import { Star, Clock, MapPin, ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { nestjsStores } from '@/lib/api/nestjs/stores'
import { nestjsItems } from '@/lib/api/nestjs/items'
import { nestjsCart } from '@/lib/api/nestjs/cart'
import { useNestjsAuth } from '@/hooks/useNestjsAuth'
import { useToast } from '@/components/shared/Toast'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { ProductCard } from '@/components/shop/ProductCard'
import { Badge } from '@/components/ui/badge'
import type { Store, Item, Category } from '@/types/nestjs/api'

export default function StoreDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { isAuthenticated } = useNestjsAuth()
  const toast = useToast()

  const [store, setStore] = useState<Store | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [activeCategory, setActiveCategory] = useState<number | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [itemsLoading, setItemsLoading] = useState(false)

  // Load store info
  useEffect(() => {
    setLoading(true)
    nestjsStores
      .get(Number(id))
      .then((res) => {
        if (res.data) setStore(res.data)
      })
      .catch(() => toast.error('Failed to load store'))
      .finally(() => setLoading(false))
  }, [id, toast])

  // Load categories for this store's module
  useEffect(() => {
    if (!store?.module_id) return
    nestjsItems
      .getCategories(store.module_id)
      .then((res) => {
        if (res.data) setCategories(res.data)
      })
      .catch(() => {})
  }, [store?.module_id])

  // Load items
  useEffect(() => {
    setItemsLoading(true)
    nestjsItems
      .list({
        store_id: Number(id),
        category_id: activeCategory,
        limit: 50,
      })
      .then((res) => {
        setItems(res.data)
      })
      .catch(() => toast.error('Failed to load items'))
      .finally(() => setItemsLoading(false))
  }, [id, activeCategory, toast])

  const handleAddToCart = async (item: Item) => {
    if (!isAuthenticated) {
      toast.warning('Please login to add items to cart')
      return
    }
    try {
      await nestjsCart.addItem({ item_id: item.id, quantity: 1 })
      toast.success(`${item.name} added to cart`)
    } catch {
      toast.error('Failed to add item to cart')
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <LoadingSpinner size="lg" text="Loading store..." />
      </div>
    )
  }

  if (!store) {
    return (
      <div className="text-center py-20 px-4">
        <p className="text-gray-500 mb-4">Store not found</p>
        <Link href="/shop/stores" className="text-[#059211] hover:underline text-sm">
          Browse stores
        </Link>
      </div>
    )
  }

  return (
    <div className="pb-24">
      {/* Store Cover / Header */}
      <div className="relative h-48 sm:h-56 bg-gray-100">
        {store.cover_photo ? (
          <Image
            src={store.cover_photo}
            alt={store.name}
            fill
            className="object-cover"
            priority
          />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-[#059211]/20 to-[#059211]/5" />
        )}
        <Link
          href="/shop/stores"
          className="absolute top-4 left-4 w-9 h-9 bg-white/90 backdrop-blur rounded-full flex items-center justify-center shadow"
        >
          <ArrowLeft size={18} className="text-gray-700" />
        </Link>
      </div>

      {/* Store Info */}
      <div className="px-4 -mt-8 relative z-10">
        <div className="bg-white rounded-xl shadow-md border border-gray-100 p-4">
          <div className="flex items-start gap-3">
            {store.logo ? (
              <Image
                src={store.logo}
                alt={store.name}
                width={56}
                height={56}
                className="rounded-lg border border-gray-200 object-cover shrink-0"
              />
            ) : (
              <div className="w-14 h-14 bg-[#059211]/10 rounded-lg flex items-center justify-center shrink-0">
                <span className="text-xl font-bold text-[#059211]">{store.name.charAt(0)}</span>
              </div>
            )}
            <div className="flex-1 min-w-0">
              <h1 className="text-lg font-bold text-gray-900 truncate">{store.name}</h1>
              <p className="text-xs text-gray-500 line-clamp-1 mt-0.5">{store.address}</p>
              <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
                {store.avg_rating > 0 && (
                  <div className="flex items-center gap-1">
                    <Star size={12} className="text-yellow-400 fill-yellow-400" />
                    <span className="font-medium text-gray-700">
                      {store.avg_rating.toFixed(1)}
                    </span>
                    <span>({store.rating_count})</span>
                  </div>
                )}
                {store.delivery_time && (
                  <div className="flex items-center gap-1">
                    <Clock size={12} />
                    <span>{store.delivery_time}</span>
                  </div>
                )}
                {store.distance !== undefined && (
                  <div className="flex items-center gap-1">
                    <MapPin size={12} />
                    <span>{store.distance.toFixed(1)} km</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-100">
            {store.delivery && (
              <Badge className="bg-[#059211]/10 text-[#059211] border-none text-[10px]">
                Delivery
              </Badge>
            )}
            {store.take_away && (
              <Badge className="bg-blue-50 text-blue-600 border-none text-[10px]">
                Takeaway
              </Badge>
            )}
            {store.free_delivery && (
              <Badge className="bg-green-50 text-green-600 border-none text-[10px]">
                Free Delivery
              </Badge>
            )}
            {store.minimum_order > 0 && (
              <span className="text-xs text-gray-500">Min. order: ₹{store.minimum_order}</span>
            )}
          </div>
        </div>
      </div>

      {/* Category Tabs */}
      {categories.length > 0 && (
        <div className="px-4 mt-4">
          <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
            <button
              onClick={() => setActiveCategory(undefined)}
              className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                activeCategory === undefined
                  ? 'bg-[#059211] text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              All
            </button>
            {categories.map((cat) => (
              <button
                key={cat.id}
                onClick={() => setActiveCategory(cat.id)}
                className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                  activeCategory === cat.id
                    ? 'bg-[#059211] text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {cat.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Items Grid */}
      <div className="px-4 mt-4">
        {itemsLoading ? (
          <div className="flex justify-center py-12">
            <LoadingSpinner size="md" text="Loading items..." />
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-500 text-sm">No items available in this category.</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {items.map((item) => (
              <ProductCard key={item.id} item={item} onAddToCart={handleAddToCart} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
