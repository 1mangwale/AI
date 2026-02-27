import { useState } from 'react'
import Image from 'next/image'
import { Star, MapPin, ChevronRight } from 'lucide-react'
import type { ProductCard as ProductCardType } from '@/types/chat'

const IMAGE_SOURCES = [
  'https://storage.mangwale.ai/mangwale/store',
  'https://new.mangwale.com/storage/app/public/store',
  'https://mangwale.s3.ap-south-1.amazonaws.com/store',
]

interface StoreCardProps {
  card: ProductCardType
  onAction: (value: string) => void
  index?: number
}

export function StoreCard({ card, onAction, index = 0 }: StoreCardProps) {
  const [imageError, setImageError] = useState(false)
  const [sourceIndex, setSourceIndex] = useState(0)
  const [isVisible] = useState(true)

  const handleImageError = () => {
    if (sourceIndex < IMAGE_SOURCES.length - 1) {
      setSourceIndex(prev => prev + 1)
    } else {
      setImageError(true)
    }
  }

  // Build image URL — try card.image first, then cascade through sources
  const imageUrl = (() => {
    if (!card.image) return null
    // If card.image is a full URL, use as-is
    if (card.image.startsWith('http')) return card.image
    // Otherwise, prepend source base
    return `${IMAGE_SOURCES[sourceIndex]}/${card.image}`
  })()

  const rating = card.rating ? (typeof card.rating === 'number' ? card.rating.toFixed(1) : card.rating) : null

  return (
    <div
      className={`
        rounded-xl w-full overflow-hidden shadow-sm hover:shadow-md
        transition-all duration-200 ease-out border border-gray-100
        ${isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3'}
      `}
      style={{ transitionDelay: `${index * 40}ms` }}
    >
      {/* Store image or emoji */}
      <div className="relative w-full aspect-[16/10] bg-gradient-to-br from-orange-50 to-amber-50 overflow-hidden">
        {imageError || !imageUrl ? (
          <div className="w-full h-full flex items-center justify-center text-4xl bg-gradient-to-br from-orange-100 to-amber-100">
            🏪
          </div>
        ) : (
          <Image
            src={imageUrl}
            alt={card.name}
            fill
            className="object-cover"
            onError={handleImageError}
            loading="lazy"
            sizes="(max-width: 640px) 45vw, 200px"
          />
        )}

        {/* Rating badge */}
        {rating && parseFloat(String(rating)) > 0 && (
          <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 bg-white/90 backdrop-blur-sm text-[10px] px-1.5 py-0.5 rounded-md">
            <Star className="w-3 h-3 fill-orange-400 text-orange-400" />
            <span className="font-semibold text-gray-800">{rating}</span>
          </div>
        )}

        {/* Distance badge */}
        {card.distance && (
          <div className="absolute top-1.5 left-1.5 flex items-center gap-0.5 bg-white/90 backdrop-blur-sm text-[10px] px-1.5 py-0.5 rounded-md">
            <MapPin className="w-3 h-3 text-gray-600" />
            <span className="text-gray-700">{card.distance}</span>
          </div>
        )}
      </div>

      {/* Store info */}
      <div className="px-2.5 py-2">
        <h4 className="font-bold text-[12px] text-gray-900 leading-tight line-clamp-1">{card.name}</h4>
        {card.category && (
          <p className="text-[10px] text-gray-500 mt-0.5 truncate">{card.category}</p>
        )}
      </div>

      {/* View Menu button */}
      <div className="px-2.5 pb-2">
        <button
          onClick={() => onAction(card.action?.value || `store_${card.id}`)}
          className="w-full py-1.5 rounded-lg bg-orange-500 text-white font-semibold text-[11px] hover:bg-orange-600 transition-colors flex items-center justify-center gap-1"
        >
          <span>View Menu</span>
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}
