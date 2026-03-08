import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { NestjsUser, UserType } from '@/types/nestjs/api'

interface NestjsAuthState {
  user: NestjsUser | null
  token: string | null
  userType: UserType | null
  isAuthenticated: boolean
  _hasHydrated: boolean

  setAuth: (user: NestjsUser, token: string) => void
  clearAuth: () => void
  updateUser: (user: Partial<NestjsUser>) => void
  setHasHydrated: (hasHydrated: boolean) => void
}

export const useNestjsAuthStore = create<NestjsAuthState>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      userType: null,
      isAuthenticated: false,
      _hasHydrated: false,

      setAuth: (user, token) => {
        set({
          user,
          token,
          userType: user.user_type,
          isAuthenticated: true,
        })
      },

      clearAuth: () => {
        set({
          user: null,
          token: null,
          userType: null,
          isAuthenticated: false,
        })
      },

      updateUser: (userData) =>
        set((state) => ({
          user: state.user ? { ...state.user, ...userData } : null,
        })),

      setHasHydrated: (hasHydrated) => {
        set({ _hasHydrated: hasHydrated })
      },
    }),
    {
      name: 'nestjs-auth-storage',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        user: state.user,
        userType: state.userType,
        isAuthenticated: state.isAuthenticated,
        token: state.token,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true)
      },
    }
  )
)
