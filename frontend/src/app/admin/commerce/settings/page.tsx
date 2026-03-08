'use client'

import { useState, useEffect, useCallback } from 'react'
import { nestjsAdmin } from '@/lib/api/nestjs/admin'
import { useToast } from '@/components/shared/Toast'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Settings,
  Save,
  Loader2,
  Building2,
  CreditCard,
  Truck,
  Bell,
  Globe,
  Shield,
} from 'lucide-react'

interface SettingSection {
  title: string
  icon: React.ComponentType<{ size?: number; className?: string }>
  keys: string[]
}

const SETTING_SECTIONS: SettingSection[] = [
  {
    title: 'Business Information',
    icon: Building2,
    keys: [
      'business_name',
      'address',
      'phone',
      'email',
      'logo',
      'footer_text',
      'copyright_text',
    ],
  },
  {
    title: 'Payment Settings',
    icon: CreditCard,
    keys: [
      'cash_on_delivery',
      'digital_payment',
      'currency_code',
      'currency_symbol',
      'currency_symbol_direction',
      'wallet_status',
      'loyalty_point_status',
      'loyalty_point_exchange_rate',
      'minimum_point_to_transfer',
    ],
  },
  {
    title: 'Delivery Settings',
    icon: Truck,
    keys: [
      'free_delivery_over',
      'default_delivery_charge',
      'per_km_charge',
      'minimum_delivery_charge',
      'maximum_delivery_charge',
      'dm_tips_status',
      'schedule_order',
    ],
  },
  {
    title: 'Notification Settings',
    icon: Bell,
    keys: [
      'push_notification',
      'sms_notification',
      'email_notification',
      'whatsapp_notification',
      'firebase_server_key',
    ],
  },
  {
    title: 'App Settings',
    icon: Globe,
    keys: [
      'maintenance_mode',
      'app_minimum_version_android',
      'app_minimum_version_ios',
      'app_url_android',
      'app_url_ios',
      'toggle_veg_non_veg',
      'toggle_dm_registration',
      'toggle_store_registration',
    ],
  },
  {
    title: 'Security & Legal',
    icon: Shield,
    keys: [
      'terms_and_conditions',
      'privacy_policy',
      'about_us',
      'refund_policy',
    ],
  },
]

export default function AdminCommerceSettingsPage() {
  const toast = useToast()

  const [settings, setSettings] = useState<Record<string, string>>({})
  const [originalSettings, setOriginalSettings] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const fetchSettings = useCallback(async () => {
    setLoading(true)
    try {
      const res = await nestjsAdmin.getSettings()
      if (res.success && res.data) {
        setSettings(res.data)
        setOriginalSettings(res.data)
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load settings'
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    fetchSettings()
  }, [fetchSettings])

  const handleChange = (key: string, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }))
  }

  const hasChanges = JSON.stringify(settings) !== JSON.stringify(originalSettings)

  const handleSave = async () => {
    if (!hasChanges) {
      toast.info('No changes to save')
      return
    }

    setSaving(true)
    try {
      // Only send changed settings
      const changedSettings: Record<string, string> = {}
      for (const key of Object.keys(settings)) {
        if (settings[key] !== originalSettings[key]) {
          changedSettings[key] = settings[key]
        }
      }

      const res = await nestjsAdmin.updateSettings(changedSettings)
      if (res.success) {
        setOriginalSettings({ ...settings })
        toast.success('Settings saved successfully')
      }
    } catch {
      toast.error('Failed to save settings')
    } finally {
      setSaving(false)
    }
  }

  const formatLabel = (key: string) => {
    return key
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
  }

  const isBooleanField = (key: string) => {
    const boolKeys = [
      'cash_on_delivery',
      'digital_payment',
      'wallet_status',
      'loyalty_point_status',
      'dm_tips_status',
      'schedule_order',
      'push_notification',
      'sms_notification',
      'email_notification',
      'whatsapp_notification',
      'maintenance_mode',
      'toggle_veg_non_veg',
      'toggle_dm_registration',
      'toggle_store_registration',
    ]
    return boolKeys.includes(key)
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner text="Loading settings..." />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Business Settings</h1>
          <p className="text-sm text-gray-500 mt-1">
            Configure platform-wide settings
          </p>
        </div>
        <Button
          onClick={handleSave}
          disabled={saving || !hasChanges}
          className="bg-[#059211] hover:bg-[#047a0e]"
        >
          {saving ? (
            <Loader2 className="animate-spin mr-2" size={16} />
          ) : (
            <Save size={16} className="mr-2" />
          )}
          Save Changes
        </Button>
      </div>

      {hasChanges && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 flex items-center gap-2">
          <Settings size={16} className="text-yellow-600" />
          <p className="text-sm text-yellow-700">
            You have unsaved changes. Click &ldquo;Save Changes&rdquo; to apply.
          </p>
        </div>
      )}

      {/* Setting Sections */}
      <div className="space-y-6">
        {SETTING_SECTIONS.map((section) => {
          const SectionIcon = section.icon
          const sectionKeys = section.keys.filter(
            (key) => key in settings || true
          )

          return (
            <Card key={section.title}>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center gap-2">
                  <SectionIcon size={20} className="text-[#059211]" />
                  {section.title}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {sectionKeys.map((key) => (
                    <div key={key}>
                      <label className="text-sm font-medium text-gray-700 mb-1 block">
                        {formatLabel(key)}
                      </label>
                      {isBooleanField(key) ? (
                        <div className="flex items-center gap-2 h-10">
                          <input
                            type="checkbox"
                            checked={
                              settings[key] === 'true' ||
                              settings[key] === '1' ||
                              settings[key] === 'on'
                            }
                            onChange={(e) =>
                              handleChange(key, e.target.checked ? 'true' : 'false')
                            }
                            className="rounded border-gray-300 text-[#059211] focus:ring-[#059211] w-5 h-5"
                          />
                          <span className="text-sm text-gray-600">
                            {settings[key] === 'true' ||
                            settings[key] === '1' ||
                            settings[key] === 'on'
                              ? 'Enabled'
                              : 'Disabled'}
                          </span>
                        </div>
                      ) : (
                        <Input
                          value={settings[key] || ''}
                          onChange={(e) => handleChange(key, e.target.value)}
                          placeholder={`Enter ${formatLabel(key).toLowerCase()}`}
                          className={
                            settings[key] !== originalSettings[key]
                              ? 'border-yellow-400 bg-yellow-50/50'
                              : ''
                          }
                        />
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      {/* Bottom Save Button */}
      {hasChanges && (
        <div className="sticky bottom-6 flex justify-end">
          <Button
            onClick={handleSave}
            disabled={saving}
            className="bg-[#059211] hover:bg-[#047a0e] shadow-lg"
          >
            {saving ? (
              <Loader2 className="animate-spin mr-2" size={16} />
            ) : (
              <Save size={16} className="mr-2" />
            )}
            Save All Changes
          </Button>
        </div>
      )}
    </div>
  )
}
