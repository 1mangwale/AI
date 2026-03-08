'use client'

import { useState, useEffect, use, useMemo } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { ArrowLeft, Star, Minus, Plus, ShoppingCart, Check } from 'lucide-react'
import { nestjsItems } from '@/lib/api/nestjs/items'
import { nestjsCart } from '@/lib/api/nestjs/cart'
import { useNestjsAuth } from '@/hooks/useNestjsAuth'
import { useToast } from '@/components/shared/Toast'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { Item, ItemVariation, ItemVariationOption, AddOn } from '@/types/nestjs/api'

export default function ItemDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { isAuthenticated } = useNestjsAuth()
  const toast = useToast()

  const [item, setItem] = useState<Item | null>(null)
  const [loading, setLoading] = useState(true)
  const [addingToCart, setAddingToCart] = useState(false)
  const [quantity, setQuantity] = useState(1)
  const [selectedVariations, setSelectedVariations] = useState<
    Record<string, ItemVariationOption[]>
  >({})
  const [selectedAddOns, setSelectedAddOns] = useState<Record<number, number>>({})

  useEffect(() => {
    setLoading(true)
    nestjsItems
      .get(Number(id))
      .then((res) => {
        if (res.data) {
          setItem(res.data)
          // Pre-select required single-type variations
          const initial: Record<string, ItemVariationOption[]> = {}
          res.data.variations?.forEach((v: ItemVariation) => {
            if (v.required && v.type === 'single' && v.values.length > 0) {
              initial[v.name] = [v.values[0]]
            }
          })
          setSelectedVariations(initial)
        }
      })
      .catch(() => toast.error('Failed to load item'))
      .finally(() => setLoading(false))
  }, [id, toast])

  const handleVariationSelect = (variation: ItemVariation, option: ItemVariationOption) => {
    setSelectedVariations((prev) => {
      const current = prev[variation.name] || []
      if (variation.type === 'single') {
        return { ...prev, [variation.name]: [option] }
      }
      // Multi-select
      const exists = current.some((o) => o.label === option.label)
      if (exists) {
        const filtered = current.filter((o) => o.label !== option.label)
        return { ...prev, [variation.name]: filtered }
      }
      if (variation.max > 0 && current.length >= variation.max) {
        toast.warning(`Maximum ${variation.max} options allowed for ${variation.name}`)
        return prev
      }
      return { ...prev, [variation.name]: [...current, option] }
    })
  }

  const toggleAddOn = (addon: AddOn) => {
    setSelectedAddOns((prev) => {
      const copy = { ...prev }
      if (copy[addon.id]) {
        delete copy[addon.id]
      } else {
        copy[addon.id] = 1
      }
      return copy
    })
  }

  const discountedPrice = useMemo(() => {
    if (!item) return 0
    return item.discount_type === 'percent'
      ? item.price - (item.price * item.discount) / 100
      : item.price - item.discount
  }, [item])

  const variationTotal = useMemo(() => {
    let total = 0
    Object.values(selectedVariations).forEach((opts) => {
      opts.forEach((o) => {
        total += o.optionPrice
      })
    })
    return total
  }, [selectedVariations])

  const addOnTotal = useMemo(() => {
    if (!item) return 0
    let total = 0
    Object.entries(selectedAddOns).forEach(([addonId, qty]) => {
      const addon = item.add_ons.find((a) => a.id === Number(addonId))
      if (addon) total += addon.price * qty
    })
    return total
  }, [item, selectedAddOns])

  const unitPrice = discountedPrice + variationTotal + addOnTotal
  const totalPrice = unitPrice * quantity

  const handleAddToCart = async () => {
    if (!isAuthenticated) {
      toast.warning('Please login to add items to cart')
      return
    }
    if (!item) return

    // Validate required variations
    for (const variation of item.variations || []) {
      if (variation.required) {
        const selected = selectedVariations[variation.name] || []
        if (selected.length < (variation.min || 1)) {
          toast.warning(`Please select ${variation.name}`)
          return
        }
      }
    }

    setAddingToCart(true)
    try {
      const variationPayload = Object.values(selectedVariations)
        .flat()
        .map((o) => ({ name: o.label, optionPrice: o.optionPrice }))

      const addOnsPayload = Object.entries(selectedAddOns).map(([addonId, qty]) => ({
        id: Number(addonId),
        quantity: qty,
      }))

      await nestjsCart.addItem({
        item_id: item.id,
        quantity,
        variation: variationPayload.length > 0 ? variationPayload : undefined,
        add_ons: addOnsPayload.length > 0 ? addOnsPayload : undefined,
      })
      toast.success(`${item.name} added to cart!`)
    } catch {
      toast.error('Failed to add item to cart')
    } finally {
      setAddingToCart(false)
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <LoadingSpinner size="lg" text="Loading item..." />
      </div>
    )
  }

  if (!item) {
    return (
      <div className="text-center py-20 px-4">
        <p className="text-gray-500 mb-4">Item not found</p>
        <Link href="/shop" className="text-[#059211] hover:underline text-sm">
          Go to home
        </Link>
      </div>
    )
  }

  return (
    <div className="pb-32">
      {/* Item Image */}
      <div className="relative aspect-square max-h-[400px] bg-gray-100">
        {item.image ? (
          <Image
            src={item.image}
            alt={item.name}
            fill
            className="object-cover"
            priority
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-400">
            No image available
          </div>
        )}
        <Link
          href={item.store_id ? `/shop/stores/${item.store_id}` : '/shop'}
          className="absolute top-4 left-4 w-9 h-9 bg-white/90 backdrop-blur rounded-full flex items-center justify-center shadow"
        >
          <ArrowLeft size={18} className="text-gray-700" />
        </Link>

        {item.discount > 0 && (
          <span className="absolute top-4 right-4 bg-red-500 text-white text-xs font-semibold px-2.5 py-1 rounded-full">
            {item.discount_type === 'percent'
              ? `${item.discount}% OFF`
              : `₹${item.discount} OFF`}
          </span>
        )}
      </div>

      {/* Item Info */}
      <div className="px-4 py-4">
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="flex-1">
            <h1 className="text-xl font-bold text-gray-900">{item.name}</h1>
            {item.store && (
              <Link
                href={`/shop/stores/${item.store_id}`}
                className="text-sm text-[#059211] hover:underline"
              >
                {item.store.name}
              </Link>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {item.veg && (
              <span className="w-5 h-5 border-2 border-green-600 rounded-sm flex items-center justify-center">
                <span className="w-2.5 h-2.5 bg-green-600 rounded-full" />
              </span>
            )}
          </div>
        </div>

        {/* Rating */}
        {item.avg_rating > 0 && (
          <div className="flex items-center gap-1 mb-3">
            <Star size={14} className="text-yellow-400 fill-yellow-400" />
            <span className="text-sm font-medium text-gray-700">
              {item.avg_rating.toFixed(1)}
            </span>
            <span className="text-xs text-gray-500">({item.rating_count} ratings)</span>
          </div>
        )}

        {/* Price */}
        <div className="flex items-center gap-2 mb-4">
          <span className="text-2xl font-bold text-gray-900">₹{discountedPrice.toFixed(0)}</span>
          {item.discount > 0 && (
            <span className="text-sm text-gray-400 line-through">₹{item.price.toFixed(0)}</span>
          )}
        </div>

        {/* Description */}
        {item.description && (
          <p className="text-sm text-gray-600 mb-6 leading-relaxed">{item.description}</p>
        )}

        {/* Tags */}
        {item.tags && item.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-6">
            {item.tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="text-xs">
                {tag}
              </Badge>
            ))}
          </div>
        )}

        {/* Variations */}
        {item.variations && item.variations.length > 0 && (
          <div className="space-y-5 mb-6">
            {item.variations.map((variation) => (
              <div key={variation.name}>
                <div className="flex items-center gap-2 mb-2">
                  <h3 className="text-sm font-semibold text-gray-900">{variation.name}</h3>
                  {variation.required && (
                    <span className="text-[10px] text-red-500 font-medium">Required</span>
                  )}
                  {variation.type === 'multi' && variation.max > 0 && (
                    <span className="text-[10px] text-gray-400">
                      (Select up to {variation.max})
                    </span>
                  )}
                </div>
                <div className="space-y-1.5">
                  {variation.values.map((option) => {
                    const selected = (selectedVariations[variation.name] || []).some(
                      (o) => o.label === option.label
                    )
                    return (
                      <button
                        key={option.label}
                        onClick={() => handleVariationSelect(variation, option)}
                        className={`w-full flex items-center justify-between p-3 rounded-lg border text-sm transition-colors ${
                          selected
                            ? 'border-[#059211] bg-[#059211]/5'
                            : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <div
                            className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                              selected ? 'border-[#059211] bg-[#059211]' : 'border-gray-300'
                            }`}
                          >
                            {selected && <Check size={10} className="text-white" />}
                          </div>
                          <span className="text-gray-800">{option.label}</span>
                        </div>
                        {option.optionPrice > 0 && (
                          <span className="text-gray-500">+₹{option.optionPrice}</span>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Add-ons */}
        {item.add_ons && item.add_ons.length > 0 && (
          <div className="mb-6">
            <h3 className="text-sm font-semibold text-gray-900 mb-2">Add-ons</h3>
            <div className="space-y-1.5">
              {item.add_ons
                .filter((a) => a.status)
                .map((addon) => {
                  const checked = !!selectedAddOns[addon.id]
                  return (
                    <button
                      key={addon.id}
                      onClick={() => toggleAddOn(addon)}
                      className={`w-full flex items-center justify-between p-3 rounded-lg border text-sm transition-colors ${
                        checked
                          ? 'border-[#059211] bg-[#059211]/5'
                          : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <div
                          className={`w-4 h-4 rounded border-2 flex items-center justify-center ${
                            checked ? 'border-[#059211] bg-[#059211]' : 'border-gray-300'
                          }`}
                        >
                          {checked && <Check size={10} className="text-white" />}
                        </div>
                        <span className="text-gray-800">{addon.name}</span>
                      </div>
                      <span className="text-gray-500">+₹{addon.price}</span>
                    </button>
                  )
                })}
            </div>
          </div>
        )}
      </div>

      {/* Bottom Bar: Quantity + Add to Cart */}
      <div className="fixed bottom-16 left-0 right-0 z-30 bg-white border-t border-gray-200 shadow-[0_-2px_10px_rgba(0,0,0,0.08)]">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-4">
          {/* Quantity Selector */}
          <div className="flex items-center gap-2 bg-gray-100 rounded-lg p-1">
            <button
              onClick={() => setQuantity((q) => Math.max(1, q - 1))}
              className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-gray-200 transition-colors"
            >
              <Minus size={16} className="text-gray-600" />
            </button>
            <span className="w-8 text-center text-sm font-semibold text-gray-900">
              {quantity}
            </span>
            <button
              onClick={() => setQuantity((q) => Math.min(99, q + 1))}
              className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-gray-200 transition-colors"
            >
              <Plus size={16} className="text-gray-600" />
            </button>
          </div>

          {/* Add to Cart Button */}
          <Button
            onClick={handleAddToCart}
            disabled={addingToCart}
            className="flex-1 bg-[#059211] hover:bg-[#047a0e] text-white h-11"
          >
            {addingToCart ? (
              <LoadingSpinner size="sm" />
            ) : (
              <>
                <ShoppingCart size={18} className="mr-2" />
                Add to Cart - ₹{totalPrice.toFixed(0)}
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
