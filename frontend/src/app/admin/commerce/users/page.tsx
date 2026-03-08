'use client'

import { useState, useEffect, useCallback } from 'react'
import { nestjsAdmin } from '@/lib/api/nestjs/admin'
import { useToast } from '@/components/shared/Toast'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { NestjsUser } from '@/types/nestjs/api'
import {
  Search,
  ChevronLeft,
  ChevronRight,
  Users,
  ToggleLeft,
  ToggleRight,
  Loader2,
} from 'lucide-react'

const USER_TYPE_OPTIONS = [
  { label: 'All', value: '' },
  { label: 'Customers', value: 'customer' },
  { label: 'Vendors', value: 'vendor' },
  { label: 'Riders', value: 'delivery_man' },
]

const userTypeColors: Record<string, string> = {
  customer: 'bg-blue-100 text-blue-700',
  vendor: 'bg-purple-100 text-purple-700',
  delivery_man: 'bg-orange-100 text-orange-700',
  admin: 'bg-red-100 text-red-700',
}

export default function AdminCommerceUsersPage() {
  const toast = useToast()

  const [users, setUsers] = useState<NestjsUser[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [togglingId, setTogglingId] = useState<number | null>(null)

  const fetchUsers = useCallback(async () => {
    setLoading(true)
    try {
      const res = await nestjsAdmin.getUsers({
        page,
        limit: 15,
        search: search || undefined,
        user_type: typeFilter || undefined,
      })
      if (res.success) {
        setUsers(res.data)
        setTotalPages(res.meta.totalPages)
        setTotal(res.meta.total)
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load users'
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }, [page, search, typeFilter, toast])

  useEffect(() => {
    fetchUsers()
  }, [fetchUsers])

  const handleToggleStatus = async (user: NestjsUser) => {
    setTogglingId(user.id)
    try {
      await nestjsAdmin.updateUserStatus(user.id, !user.is_active)
      toast.success(`User ${!user.is_active ? 'activated' : 'deactivated'}`)
      fetchUsers()
    } catch {
      toast.error('Failed to update user status')
    } finally {
      setTogglingId(null)
    }
  }

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    setPage(1)
    fetchUsers()
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">User Management</h1>
        <p className="text-sm text-gray-500 mt-1">
          Manage platform users ({total} total)
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <form onSubmit={handleSearch} className="flex-1 flex gap-2">
          <div className="relative flex-1">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input
              placeholder="Search by name, email, phone..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Button type="submit" variant="outline">
            Search
          </Button>
        </form>
        <div className="flex gap-2">
          {USER_TYPE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => {
                setTypeFilter(opt.value)
                setPage(1)
              }}
              className={`px-3 py-2 text-sm rounded-lg border whitespace-nowrap transition-colors ${
                typeFilter === opt.value
                  ? 'bg-[#059211] text-white border-[#059211]'
                  : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex justify-center py-12">
          <LoadingSpinner text="Loading users..." />
        </div>
      ) : users.length === 0 ? (
        <div className="bg-white rounded-xl border p-12 text-center">
          <Users size={48} className="mx-auto text-gray-300 mb-3" />
          <p className="text-gray-500">No users found</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Name</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 hidden md:table-cell">Email</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Phone</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Type</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 hidden lg:table-cell">Joined</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {users.map((u) => (
                  <tr key={u.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {u.image ? (
                          <img
                            src={u.image}
                            alt={u.f_name}
                            className="w-9 h-9 rounded-full object-cover"
                          />
                        ) : (
                          <div className="w-9 h-9 bg-gray-100 rounded-full flex items-center justify-center">
                            <Users size={16} className="text-gray-400" />
                          </div>
                        )}
                        <span className="font-medium text-gray-900">
                          {u.f_name} {u.l_name}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-600 hidden md:table-cell">
                      {u.email || '-'}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{u.phone}</td>
                    <td className="px-4 py-3">
                      <Badge className={userTypeColors[u.user_type] || 'bg-gray-100 text-gray-700'}>
                        {u.user_type.replace('_', ' ')}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        className={
                          u.is_active
                            ? 'bg-green-100 text-green-700'
                            : 'bg-red-100 text-red-700'
                        }
                      >
                        {u.is_active ? 'Active' : 'Inactive'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs hidden lg:table-cell">
                      {new Date(u.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => handleToggleStatus(u)}
                        disabled={togglingId === u.id}
                        className="inline-flex items-center gap-1 text-sm hover:text-[#059211] transition-colors disabled:opacity-50"
                        title={u.is_active ? 'Deactivate' : 'Activate'}
                      >
                        {togglingId === u.id ? (
                          <Loader2 size={18} className="animate-spin text-gray-400" />
                        ) : u.is_active ? (
                          <ToggleRight size={22} className="text-[#059211]" />
                        ) : (
                          <ToggleLeft size={22} className="text-gray-400" />
                        )}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between px-4 py-3 border-t bg-gray-50">
            <p className="text-sm text-gray-500">
              Page {page} of {totalPages} ({total} users)
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                <ChevronLeft size={16} />
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage(page + 1)}
              >
                <ChevronRight size={16} />
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
