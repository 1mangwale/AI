import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: string;
  permissions: Array<{ module: string; actions: string[] }>;
}

interface AdminAuthState {
  user: AdminUser | null;
  token: string | null;
  isAuthenticated: boolean;
  _hasHydrated: boolean;
  _sessionValidated: boolean;
  setAuth: (user: AdminUser, token: string) => void;
  clearAuth: () => void;
  updateUser: (user: Partial<AdminUser>) => void;
  setHasHydrated: (hasHydrated: boolean) => void;
  validateSession: () => Promise<void>;
}

export const useAdminAuthStore = create<AdminAuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      isAuthenticated: false,
      _hasHydrated: false,
      _sessionValidated: false,

      setAuth: (user, token) => {
        set({ user, token, isAuthenticated: true, _sessionValidated: true });
      },

      clearAuth: () => {
        set({ user: null, token: null, isAuthenticated: false, _sessionValidated: true });
      },

      updateUser: (userData) =>
        set((state) => ({
          user: state.user ? { ...state.user, ...userData } : null,
        })),

      setHasHydrated: (hasHydrated) => {
        set({ _hasHydrated: hasHydrated });
      },

      validateSession: async () => {
        const state = get();
        // Only validate if we think we're authenticated but have no in-memory token
        // (i.e. page was refreshed, token was only in HttpOnly cookie)
        if (!state.isAuthenticated) {
          set({ _sessionValidated: true });
          return;
        }
        if (state.token) {
          // Token is in memory — no need to validate via cookie
          set({ _sessionValidated: true });
          return;
        }

        try {
          const baseUrl = process.env.NEXT_PUBLIC_ADMIN_BACKEND_URL || '/api';
          const response = await fetch(`${baseUrl}/admin/auth/profile`, {
            credentials: 'include',
          });

          if (response.ok) {
            const data = await response.json();
            if (data.success && data.user) {
              set({
                user: data.user as AdminUser,
                isAuthenticated: true,
                _sessionValidated: true,
              });
              return;
            }
          }

          // Cookie invalid or expired — clear auth
          set({ user: null, token: null, isAuthenticated: false, _sessionValidated: true });
        } catch {
          // Network error — clear auth to be safe
          set({ user: null, token: null, isAuthenticated: false, _sessionValidated: true });
        }
      },
    }),
    {
      name: 'admin-auth-storage',
      storage: createJSONStorage(() => localStorage),
      // token is NOT persisted — it's in an HttpOnly cookie
      partialize: (state) => ({
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
        // After rehydration, validate the session via HttpOnly cookie
        state?.validateSession();
      },
    }
  )
);
