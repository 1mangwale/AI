'use client'

import { useState, useEffect } from 'react'
import { MapPin, Plus, Check } from 'lucide-react'
import { nestjsDelivery } from '@/lib/api/nestjs/delivery'
import type { DeliveryAddress } from '@/types/nestjs/api'

interface AddressSelectorProps {
  selectedId?: number
  onSelect: (address: DeliveryAddress) => void
  onAddNew?: () => void
}

export function AddressSelector({ selectedId, onSelect, onAddNew }: AddressSelectorProps) {
  const [addresses, setAddresses] = useState<DeliveryAddress[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    nestjsDelivery
      .getAddresses()
      .then((res) => setAddresses(res.data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="space-y-2">
        {[1, 2].map((i) => (
          <div key={i} className="h-16 bg-gray-100 rounded-lg animate-shimmer" />
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {addresses.map((addr) => (
        <button
          key={addr.id}
          onClick={() => onSelect(addr)}
          className={`w-full text-left p-3 rounded-lg border transition-colors ${
            selectedId === addr.id
              ? 'border-primary bg-primary/5'
              : 'border-gray-200 hover:border-gray-300'
          }`}
        >
          <div className="flex items-start gap-3">
            <MapPin size={16} className="text-gray-400 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900 capitalize">
                {addr.address_type}
              </p>
              <p className="text-xs text-gray-500 truncate">{addr.address}</p>
              <p className="text-xs text-gray-400">{addr.contact_person_name} - {addr.contact_person_number}</p>
            </div>
            {selectedId === addr.id && (
              <Check size={16} className="text-primary shrink-0 mt-0.5" />
            )}
          </div>
        </button>
      ))}

      {onAddNew && (
        <button
          onClick={onAddNew}
          className="w-full p-3 rounded-lg border border-dashed border-gray-300 text-sm text-gray-500 hover:border-primary hover:text-primary transition-colors flex items-center justify-center gap-2"
        >
          <Plus size={16} />
          Add New Address
        </button>
      )}
    </div>
  )
}
