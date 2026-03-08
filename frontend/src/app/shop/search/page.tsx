'use client'

import { useState, useEffect, useCallback, useRef, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { Search } from 'lucide-react'
import { nestjsItems } from '@/lib/api/nestjs/items'
import { nestjsCart } from '@/lib/api/nestjs/cart'
import { useNestjsAuth } from '@/hooks/useNestjsAuth'
import { useToast } from '@/components/shared/Toast'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { ProductCard } from '@/components/shop/ProductCard'
import { Input } from '@/components/ui/input'
import type { Item } from '@/types/nestjs/api'

function SearchContent() {
  const searchParams = useSearchParams()
  const initialQuery = searchParams.get('q') || ''
  const { isAuthenticated } = useNestjsAuth()
  const toast = useToast()

  const [query, setQuery] = useState(initialQuery)
  const [results, setResults] = useState<Item[]>([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const performSearch = useCallback(async (q: string) => {
    const trimmed = q.trim()
    if (!trimmed) {
      setResults([])
      setSearched(false)
      return
    }
    setLoading(true)
    setSearched(true)
    try {
      const res = await nestjsItems.search(trimmed)
      if (res.data) setResults(res.data)
      else setResults([])
    } catch {
      toast.error('Search failed')
      setResults([])
    } finally {
      setLoading(false)
    }
  }, [toast])

  // Search on initial load if query param exists
  useEffect(() => {
    if (initialQuery) {
      performSearch(initialQuery)
    }
  }, [initialQuery, performSearch])

  // Debounced search as user types
  const handleQueryChange = (value: string) => {
    setQuery(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      performSearch(value)
    }, 400)
  }

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
      {/* Search Input */}
      <div className="relative mb-6">
        <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <Input
          type="text"
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          placeholder="Search for items..."
          className="pl-10"
          autoFocus
        />
      </div>

      {/* Results */}
      {loading ? (
        <div className="flex justify-center py-16">
          <LoadingSpinner size="md" text="Searching..." />
        </div>
      ) : !searched ? (
        <div className="text-center py-16">
          <Search size={40} className="text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500 text-sm">Search for items across all stores</p>
        </div>
      ) : results.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-gray-500 text-sm">
            No results found for &quot;{query.trim()}&quot;
          </p>
          <p className="text-xs text-gray-400 mt-1">Try a different search term</p>
        </div>
      ) : (
        <>
          <p className="text-sm text-gray-500 mb-3">
            {results.length} result{results.length !== 1 ? 's' : ''} for &quot;{query.trim()}&quot;
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {results.map((item) => (
              <ProductCard
                key={item.id}
                item={item}
                onAddToCart={handleAddToCart}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

export default function SearchPage() {
  return (
    <Suspense fallback={
      <div className="flex justify-center py-20">
        <LoadingSpinner size="lg" text="Loading..." />
      </div>
    }>
      <SearchContent />
    </Suspense>
  )
}
