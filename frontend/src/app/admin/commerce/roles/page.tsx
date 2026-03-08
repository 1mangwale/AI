'use client'

import { useState, useEffect, useCallback } from 'react'
import { nestjsAdmin } from '@/lib/api/nestjs/admin'
import { useToast } from '@/components/shared/Toast'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import type { AdminRole } from '@/types/nestjs/api'
import {
  Shield,
  Plus,
  Pencil,
  Trash2,
  Loader2,
} from 'lucide-react'

const AVAILABLE_MODULES = [
  'stores',
  'orders',
  'items',
  'users',
  'finance',
  'delivery',
  'subscriptions',
  'settings',
  'roles',
  'notifications',
  'marketing',
  'reports',
  'support',
]

interface RoleFormData {
  name: string
  modules: string[]
}

const emptyForm: RoleFormData = {
  name: '',
  modules: [],
}

export default function AdminCommerceRolesPage() {
  const toast = useToast()

  const [roles, setRoles] = useState<AdminRole[]>([])
  const [loading, setLoading] = useState(true)
  const [showDialog, setShowDialog] = useState(false)
  const [editingRole, setEditingRole] = useState<AdminRole | null>(null)
  const [formData, setFormData] = useState<RoleFormData>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)

  const fetchRoles = useCallback(async () => {
    setLoading(true)
    try {
      const res = await nestjsAdmin.getRoles()
      if (res.success && res.data) {
        setRoles(res.data)
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load roles'
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    fetchRoles()
  }, [fetchRoles])

  const openCreateDialog = () => {
    setEditingRole(null)
    setFormData(emptyForm)
    setShowDialog(true)
  }

  const openEditDialog = (role: AdminRole) => {
    setEditingRole(role)
    setFormData({
      name: role.name,
      modules: role.modules || [],
    })
    setShowDialog(true)
  }

  const handleModuleToggle = (module: string) => {
    setFormData((prev) => ({
      ...prev,
      modules: prev.modules.includes(module)
        ? prev.modules.filter((m) => m !== module)
        : [...prev.modules, module],
    }))
  }

  const handleSave = async () => {
    if (!formData.name.trim()) {
      toast.error('Role name is required')
      return
    }
    if (formData.modules.length === 0) {
      toast.error('Select at least one module')
      return
    }

    setSaving(true)
    try {
      if (editingRole) {
        await nestjsAdmin.updateRole(editingRole.id, {
          name: formData.name,
          modules: formData.modules,
        })
        toast.success('Role updated successfully')
      } else {
        await nestjsAdmin.createRole({
          name: formData.name,
          modules: formData.modules,
        })
        toast.success('Role created successfully')
      }
      setShowDialog(false)
      fetchRoles()
    } catch {
      toast.error('Failed to save role')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (role: AdminRole) => {
    if (!confirm(`Are you sure you want to delete the "${role.name}" role?`)) return

    setDeletingId(role.id)
    try {
      await nestjsAdmin.deleteRole(role.id)
      toast.success('Role deleted successfully')
      fetchRoles()
    } catch {
      toast.error('Failed to delete role')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Role Management</h1>
          <p className="text-sm text-gray-500 mt-1">
            Manage admin roles and permissions ({roles.length} roles)
          </p>
        </div>
        <Button onClick={openCreateDialog} className="bg-[#059211] hover:bg-[#047a0e]">
          <Plus size={16} className="mr-2" />
          Add Role
        </Button>
      </div>

      {/* Roles Table */}
      {loading ? (
        <div className="flex justify-center py-12">
          <LoadingSpinner text="Loading roles..." />
        </div>
      ) : roles.length === 0 ? (
        <div className="bg-white rounded-xl border p-12 text-center">
          <Shield size={48} className="mx-auto text-gray-300 mb-3" />
          <p className="text-gray-500 mb-4">No roles configured</p>
          <Button onClick={openCreateDialog} className="bg-[#059211] hover:bg-[#047a0e]">
            <Plus size={16} className="mr-2" />
            Create First Role
          </Button>
        </div>
      ) : (
        <div className="bg-white rounded-xl border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Role Name</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Modules</th>
                  <th className="text-center px-4 py-3 font-medium text-gray-500 hidden md:table-cell">Permissions</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 hidden md:table-cell">Created</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {roles.map((role) => (
                  <tr key={role.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Shield size={16} className="text-[#059211]" />
                        <span className="font-medium text-gray-900">{role.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {(role.modules || []).slice(0, 3).map((mod) => (
                          <Badge
                            key={mod}
                            variant="secondary"
                            className="text-[10px] bg-gray-100 text-gray-600"
                          >
                            {mod}
                          </Badge>
                        ))}
                        {(role.modules || []).length > 3 && (
                          <Badge variant="secondary" className="text-[10px] bg-gray-100 text-gray-600">
                            +{role.modules.length - 3} more
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-center hidden md:table-cell">
                      <span className="text-gray-600">
                        {role.permissions?.length || 0}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        className={
                          role.is_active
                            ? 'bg-green-100 text-green-700'
                            : 'bg-red-100 text-red-700'
                        }
                      >
                        {role.is_active ? 'Active' : 'Inactive'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs hidden md:table-cell">
                      {new Date(role.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => openEditDialog(role)}
                          className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors text-gray-400 hover:text-gray-600"
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          onClick={() => handleDelete(role)}
                          disabled={deletingId === role.id}
                          className="p-1.5 rounded-lg hover:bg-red-50 transition-colors text-gray-400 hover:text-red-600 disabled:opacity-50"
                        >
                          {deletingId === role.id ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            <Trash2 size={14} />
                          )}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Create/Edit Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingRole ? 'Edit Role' : 'Create Role'}
            </DialogTitle>
            <DialogDescription>
              {editingRole
                ? 'Update the role name and module access.'
                : 'Create a new admin role with module access.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <label className="text-sm font-medium text-gray-700 mb-1 block">
                Role Name
              </label>
              <Input
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g., Store Manager, Finance Admin"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-gray-700 mb-2 block">
                Module Access ({formData.modules.length} selected)
              </label>
              <div className="grid grid-cols-2 gap-2 max-h-[300px] overflow-y-auto">
                {AVAILABLE_MODULES.map((mod) => (
                  <label
                    key={mod}
                    className={`flex items-center gap-2 p-2.5 rounded-lg border cursor-pointer transition-colors ${
                      formData.modules.includes(mod)
                        ? 'bg-[#059211]/5 border-[#059211]/30'
                        : 'bg-white border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={formData.modules.includes(mod)}
                      onChange={() => handleModuleToggle(mod)}
                      className="rounded border-gray-300 text-[#059211] focus:ring-[#059211]"
                    />
                    <span className="text-sm text-gray-700 capitalize">{mod}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)} disabled={saving}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving}
              className="bg-[#059211] hover:bg-[#047a0e]"
            >
              {saving && <Loader2 className="animate-spin mr-2" size={16} />}
              {editingRole ? 'Update Role' : 'Create Role'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
