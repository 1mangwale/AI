import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface User {
  id: number;
  f_name: string;
  l_name?: string;
  phone: string;
  email?: string;
  image?: string;
}

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  _hasHydrated: boolean;
  lastSyncedFrom?: string; // Platform that last synced auth (web, whatsapp, etc.)
  setAuth: (user: User, token: string, syncSource?: string) => void;
  clearAuth: (syncSource?: string) => void;
  updateUser: (user: Partial<User>) => void;
  setHasHydrated: (hasHydrated: boolean) => void;
  // Centralized auth sync
  syncFromRemote: (data: { userId: number; userName: string; token: string; platform: string }) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      isAuthenticated: false,
      _hasHydrated: false,
      lastSyncedFrom: undefined,

      setAuth: (user, token, syncSource = 'web') => {
        set({ 
          user, 
          token, 
          isAuthenticated: true,
          lastSyncedFrom: syncSource 
        });
      },

      clearAuth: (syncSource) => {
        set({ 
          user: null, 
          token: null, 
          isAuthenticated: false,
          lastSyncedFrom: syncSource 
        });
      },

      updateUser: (userData) =>
        set((state) => ({
          user: state.user ? { ...state.user, ...userData } : null,
        })),

      setHasHydrated: (hasHydrated) => {
        set({ _hasHydrated: hasHydrated });
      },

      // Called when auth is synced from another channel (WhatsApp, etc.)
      syncFromRemote: (data) => {
        const currentUser = get().user;
        
        // Only sync if not already authenticated or if it's from a different platform
        if (!currentUser || get().lastSyncedFrom !== data.platform) {
          console.log(`🔐 Syncing auth from ${data.platform}`);
          set({
            user: {
              id: data.userId,
              f_name: data.userName,
              phone: '', // Will be updated from backend
            },
            token: data.token,
            isAuthenticated: true,
            lastSyncedFrom: data.platform,
          });
        }
      },
    }),
    {
      name: 'auth-storage',
      storage: createJSONStorage(() => localStorage),
      // Don't persist _hasHydrated - it should always start false
      // token is NOT persisted — it's in an HttpOnly cookie now
      partialize: (state) => ({
        user: state.user,
        isAuthenticated: state.isAuthenticated,
        lastSyncedFrom: state.lastSyncedFrom,
      }),
      onRehydrateStorage: () => (state, error) => {
        if (error) {
          console.error('🔴 Auth store rehydration error:', error);
        } else {
          console.log('🟢 Auth store rehydrated:', {
            isAuthenticated: state?.isAuthenticated,
            userId: state?.user?.id,
            phone: state?.user?.phone,
            hasToken: !!state?.token
          });
        }
        state?.setHasHydrated(true);
      },
    }
  )
);
