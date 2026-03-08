'use client'

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Plus, Trash2, Save } from 'lucide-react'
import type { Item, ItemVariation, Category } from '@/types/nestjs/api'

interface ItemFormProps {
  item?: Item
  categories: Category[]
  onSubmit: (data: Partial<Item>) => Promise<void>
  loading?: boolean
}

interface FormValues {
  name: string
  description: string
  price: number
  discount: number
  discount_type: 'percent' | 'amount'
  category_id: number
  veg: boolean
  stock: number
  available_time_starts: string
  available_time_ends: string
  tags: string
}

export function ItemForm({ item, categories, onSubmit, loading }: ItemFormProps) {
  const { register, handleSubmit, formState: { errors } } = useForm<FormValues>({
    defaultValues: {
      name: item?.name || '',
      description: item?.description || '',
      price: item?.price || 0,
      discount: item?.discount || 0,
      discount_type: item?.discount_type || 'percent',
      category_id: item?.category_id || 0,
      veg: item?.veg || false,
      stock: item?.stock || 0,
      available_time_starts: item?.available_time_starts || '',
      available_time_ends: item?.available_time_ends || '',
      tags: item?.tags?.join(', ') || '',
    },
  })
  const [variations, setVariations] = useState<ItemVariation[]>(item?.variations || [])

  const addVariation = () => {
    setVariations([
      ...variations,
      { name: '', type: 'single', min: 0, max: 1, required: false, values: [] },
    ])
  }

  const removeVariation = (index: number) => {
    setVariations(variations.filter((_, i) => i !== index))
  }

  const addVariationOption = (varIndex: number) => {
    const updated = [...variations]
    updated[varIndex].values.push({ label: '', optionPrice: 0 })
    setVariations(updated)
  }

  const handleFormSubmit = handleSubmit(async (data) => {
    await onSubmit({
      ...data,
      variations,
      tags: data.tags ? data.tags.split(',').map((t) => t.trim()) : [],
    })
  })

  return (
    <form onSubmit={handleFormSubmit} className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
          <input
            {...register('name', { required: 'Name is required' })}
            className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary"
          />
          {errors.name && <p className="text-xs text-red-500 mt-1">{errors.name.message}</p>}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Category *</label>
          <select
            {...register('category_id', { required: 'Category is required', valueAsNumber: true })}
            className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary"
          >
            <option value="">Select category</option>
            {categories.map((cat) => (
              <option key={cat.id} value={cat.id}>{cat.name}</option>
            ))}
          </select>
        </div>

        <div className="md:col-span-2">
          <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
          <textarea
            {...register('description')}
            rows={3}
            className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Price *</label>
          <input
            type="number"
            step="0.01"
            {...register('price', { required: true, valueAsNumber: true, min: 0 })}
            className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary"
          />
        </div>

        <div className="flex gap-2">
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-700 mb-1">Discount</label>
            <input
              type="number"
              step="0.01"
              {...register('discount', { valueAsNumber: true, min: 0 })}
              className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary"
            />
          </div>
          <div className="w-28">
            <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
            <select
              {...register('discount_type')}
              className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary"
            >
              <option value="percent">%</option>
              <option value="amount">₹</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Stock</label>
          <input
            type="number"
            {...register('stock', { valueAsNumber: true, min: 0 })}
            className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Tags</label>
          <input
            {...register('tags')}
            placeholder="tag1, tag2, tag3"
            className="w-full px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary"
          />
        </div>

        <div className="flex items-center gap-2">
          <input type="checkbox" {...register('veg')} id="veg" className="rounded" />
          <label htmlFor="veg" className="text-sm text-gray-700">Vegetarian</label>
        </div>
      </div>

      {/* Variations */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-900">Variations</h3>
          <button
            type="button"
            onClick={addVariation}
            className="text-xs text-primary hover:underline flex items-center gap-1"
          >
            <Plus size={14} /> Add Variation
          </button>
        </div>

        {variations.map((variation, vi) => (
          <div key={vi} className="border rounded-lg p-3 mb-3">
            <div className="flex items-center gap-2 mb-2">
              <input
                value={variation.name}
                onChange={(e) => {
                  const updated = [...variations]
                  updated[vi].name = e.target.value
                  setVariations(updated)
                }}
                placeholder="e.g. Size"
                className="flex-1 px-2 py-1 border rounded text-sm"
              />
              <button type="button" onClick={() => removeVariation(vi)} className="text-red-400 hover:text-red-600">
                <Trash2 size={16} />
              </button>
            </div>

            {variation.values.map((opt, oi) => (
              <div key={oi} className="flex items-center gap-2 ml-4 mb-1">
                <input
                  value={opt.label}
                  onChange={(e) => {
                    const updated = [...variations]
                    updated[vi].values[oi].label = e.target.value
                    setVariations(updated)
                  }}
                  placeholder="Option name"
                  className="flex-1 px-2 py-1 border rounded text-xs"
                />
                <input
                  type="number"
                  value={opt.optionPrice}
                  onChange={(e) => {
                    const updated = [...variations]
                    updated[vi].values[oi].optionPrice = Number(e.target.value)
                    setVariations(updated)
                  }}
                  placeholder="Price"
                  className="w-20 px-2 py-1 border rounded text-xs"
                />
              </div>
            ))}

            <button
              type="button"
              onClick={() => addVariationOption(vi)}
              className="ml-4 text-xs text-gray-500 hover:text-primary mt-1"
            >
              + Add Option
            </button>
          </div>
        ))}
      </div>

      <button
        type="submit"
        disabled={loading}
        className="w-full md:w-auto px-6 py-2.5 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary-hover transition-colors disabled:opacity-50 flex items-center gap-2"
      >
        <Save size={16} />
        {loading ? 'Saving...' : item ? 'Update Item' : 'Create Item'}
      </button>
    </form>
  )
}
