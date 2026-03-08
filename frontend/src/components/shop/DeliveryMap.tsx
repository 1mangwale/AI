'use client'

import { useEffect, useRef, useState } from 'react'
import type { TrackingData } from '@/types/nestjs/api'

interface DeliveryMapProps {
  tracking: TrackingData
  deliveryAddress: { latitude: number; longitude: number }
  storeLocation?: { latitude: number; longitude: number }
}

export function DeliveryMap({ tracking, deliveryAddress, storeLocation }: DeliveryMapProps) {
  const mapRef = useRef<HTMLDivElement>(null)
  const [mapLoaded, setMapLoaded] = useState(false)

  useEffect(() => {
    if (!mapRef.current || mapLoaded) return

    import('leaflet').then((L) => {
      // @ts-expect-error -- CSS import for leaflet styles
      import('leaflet/dist/leaflet.css')

      const map = L.map(mapRef.current!, {
        zoomControl: false,
      })

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap',
      }).addTo(map)

      // Delivery man marker
      const riderIcon = L.divIcon({
        html: '<div class="w-8 h-8 bg-primary rounded-full flex items-center justify-center text-white text-xs font-bold shadow-lg border-2 border-white">DM</div>',
        className: '',
        iconSize: [32, 32],
        iconAnchor: [16, 16],
      })

      const riderMarker = L.marker(
        [tracking.delivery_man.latitude, tracking.delivery_man.longitude],
        { icon: riderIcon }
      ).addTo(map)

      // Delivery address marker
      const destIcon = L.divIcon({
        html: '<div class="w-6 h-6 bg-red-500 rounded-full flex items-center justify-center text-white text-xs shadow-lg border-2 border-white">D</div>',
        className: '',
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      })

      L.marker(
        [deliveryAddress.latitude, deliveryAddress.longitude],
        { icon: destIcon }
      ).addTo(map)

      // Store marker
      if (storeLocation) {
        const storeIcon = L.divIcon({
          html: '<div class="w-6 h-6 bg-blue-500 rounded-full flex items-center justify-center text-white text-xs shadow-lg border-2 border-white">S</div>',
          className: '',
          iconSize: [24, 24],
          iconAnchor: [12, 12],
        })
        L.marker(
          [storeLocation.latitude, storeLocation.longitude],
          { icon: storeIcon }
        ).addTo(map)
      }

      // Fit bounds
      const bounds = L.latLngBounds([
        [tracking.delivery_man.latitude, tracking.delivery_man.longitude],
        [deliveryAddress.latitude, deliveryAddress.longitude],
      ])
      if (storeLocation) {
        bounds.extend([storeLocation.latitude, storeLocation.longitude])
      }
      map.fitBounds(bounds, { padding: [40, 40] })

      setMapLoaded(true)

      return () => {
        map.remove()
      }
    })
  }, [tracking, deliveryAddress, storeLocation, mapLoaded])

  return (
    <div ref={mapRef} className="w-full h-64 rounded-lg overflow-hidden bg-gray-100" />
  )
}
