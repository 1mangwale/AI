'use client'

import { useState, useEffect } from 'react'
import { nestjsStores } from '@/lib/api/nestjs/stores'
import { nestjsItems } from '@/lib/api/nestjs/items'
import { nestjsCart } from '@/lib/api/nestjs/cart'
import { useNestjsAuth } from '@/hooks/useNestjsAuth'
import { useToast } from '@/components/shared/Toast'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { StoreCard } from '@/components/shop/StoreCard'
import { ProductCard } from '@/components/shop/ProductCard'
import type { Module, Store, Item } from '@/types/nestjs/api'

export default function ShopHomePage() {
  const { isAuthenticated } = useNestjsAuth()
  const toast = useToast()

  const [modules, setModules] = useState<Module[]>([])
  const [activeModule, setActiveModule] = useState<number | undefined>(undefined)
  const [popularStores, setPopularStores] = useState<Store[]>([])
  const [popularItems, setPopularItems] = useState<Item[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    nestjsStores
      .getModules()
      .then((res) => {
        if (res.data) setModules(res.data)
      })
      .catch(() => toast.error('Failed to load modules'))
  }, [toast])

  useEffect(() => {
    setLoading(true)
    Promise.all([
      nestjsStores.popular(activeModule),
      nestjsItems.popular(activeModule),
    ])
      .then(([storesRes, itemsRes]) => {
        if (storesRes.data) setPopularStores(storesRes.data)
        if (itemsRes.data) setPopularItems(itemsRes.data)
      })
      .catch(() => toast.error('Failed to load data'))
      .finally(() => setLoading(false))
  }, [activeModule, toast])

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

  return (
    <div className="px-4 py-4 pb-24">
      {/* Module Pills */}
      {modules.length > 0 && (
        <div className="mb-6">
          <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
            <button
              onClick={() => setActiveModule(undefined)}
              className={`shrink-0 px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                activeModule === undefined
                  ? 'bg-[#059211] text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              All
            </button>
            {modules.map((mod) => (
              <button
                key={mod.id}
                onClick={() => setActiveModule(mod.id)}
                className={`shrink-0 px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                  activeModule === mod.id
                    ? 'bg-[#059211] text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                {mod.module_name}
              </button>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-20">
          <LoadingSpinner size="lg" text="Loading..." />
        </div>
      ) : (
        <>
          {/* Popular Stores */}
          {popularStores.length > 0 && (
            <section className="mb-8">
              <h2 className="text-lg font-bold text-gray-900 mb-3">Popular Stores</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {popularStores.map((store) => (
                  <StoreCard key={store.id} store={store} />
                ))}
              </div>
            </section>
          )}

          {/* Popular Items */}
          {popularItems.length > 0 && (
            <section className="mb-8">
              <h2 className="text-lg font-bold text-gray-900 mb-3">Popular Items</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {popularItems.map((item) => (
                  <ProductCard
                    key={item.id}
                    item={item}
                    onAddToCart={handleAddToCart}
                  />
                ))}
              </div>
            </section>
          )}

          {popularStores.length === 0 && popularItems.length === 0 && (
            <div className="text-center py-20">
              <p className="text-gray-500 text-sm">No stores or items available right now.</p>
            </div>
          )}
        </>
      )}
    </div>
  )
}
