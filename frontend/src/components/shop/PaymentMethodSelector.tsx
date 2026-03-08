'use client'

import { CreditCard, Wallet, Banknote, Check } from 'lucide-react'

interface PaymentMethodSelectorProps {
  selected: string
  onSelect: (method: string) => void
  cashOnDelivery?: boolean
  digitalPayment?: boolean
  walletBalance?: number
}

const methods = [
  { id: 'digital_payment', label: 'Pay Online', icon: CreditCard, description: 'Card, UPI, Net Banking' },
  { id: 'cash_on_delivery', label: 'Cash on Delivery', icon: Banknote, description: 'Pay when delivered' },
  { id: 'wallet', label: 'Wallet', icon: Wallet, description: 'Pay from wallet balance' },
]

export function PaymentMethodSelector({
  selected,
  onSelect,
  cashOnDelivery = true,
  digitalPayment = true,
  walletBalance = 0,
}: PaymentMethodSelectorProps) {
  const availableMethods = methods.filter((m) => {
    if (m.id === 'cash_on_delivery' && !cashOnDelivery) return false
    if (m.id === 'digital_payment' && !digitalPayment) return false
    return true
  })

  return (
    <div className="space-y-2">
      {availableMethods.map((method) => {
        const Icon = method.icon
        const isSelected = selected === method.id
        const isDisabled = method.id === 'wallet' && walletBalance <= 0

        return (
          <button
            key={method.id}
            onClick={() => !isDisabled && onSelect(method.id)}
            disabled={isDisabled}
            className={`w-full text-left p-3 rounded-lg border transition-colors ${
              isSelected
                ? 'border-primary bg-primary/5'
                : isDisabled
                  ? 'border-gray-100 bg-gray-50 opacity-50 cursor-not-allowed'
                  : 'border-gray-200 hover:border-gray-300'
            }`}
          >
            <div className="flex items-center gap-3">
              <Icon size={20} className={isSelected ? 'text-primary' : 'text-gray-400'} />
              <div className="flex-1">
                <p className="text-sm font-medium text-gray-900">{method.label}</p>
                <p className="text-xs text-gray-500">
                  {method.id === 'wallet'
                    ? `Balance: ₹${walletBalance.toFixed(2)}`
                    : method.description}
                </p>
              </div>
              {isSelected && <Check size={16} className="text-primary" />}
            </div>
          </button>
        )
      })}
    </div>
  )
}
