'use client'

import Image from 'next/image'
import Link from 'next/link'
import { Star, Clock, MapPin } from 'lucide-react'
import type { Store } from '@/types/nestjs/api'

interface StoreCardProps {
  store: Store
}

export function StoreCard({ store }: StoreCardProps) {
  return (
    <Link href={`/shop/stores/${store.id}`}>
      <div className="bg-white rounded-lg border shadow-sm overflow-hidden hover:shadow-md transition-shadow">
        <div className="relative h-32 bg-gray-100">
          {store.cover_photo ? (
            <Image
              src={store.cover_photo}
              alt={store.name}
              fill
              className="object-cover"
              sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-primary/10 to-primary/5">
              {store.logo ? (
                <Image
                  src={store.logo}
                  alt={store.name}
                  width={48}
                  height={48}
                  className="rounded-full"
                />
              ) : (
                <span className="text-2xl font-bold text-primary/40">
                  {store.name.charAt(0)}
                </span>
              )}
            </div>
          )}
          {store.free_delivery && (
            <span className="absolute top-2 left-2 bg-green-500 text-white text-xs font-medium px-2 py-0.5 rounded">
              Free Delivery
            </span>
          )}
        </div>

        <div className="p-3">
          <div className="flex items-start justify-between mb-1">
            <h3 className="text-sm font-semibold text-gray-900 line-clamp-1 flex-1">
              {store.name}
            </h3>
            {store.avg_rating > 0 && (
              <div className="flex items-center gap-0.5 ml-2 shrink-0">
                <Star size={12} className="text-yellow-400 fill-yellow-400" />
                <span className="text-xs font-medium text-gray-700">
                  {store.avg_rating.toFixed(1)}
                </span>
              </div>
            )}
          </div>

          <p className="text-xs text-gray-500 line-clamp-1 mb-2">{store.address}</p>

          <div className="flex items-center gap-3 text-xs text-gray-500">
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
            {store.minimum_order > 0 && (
              <span>Min ₹{store.minimum_order}</span>
            )}
          </div>
        </div>
      </div>
    </Link>
  )
}
