# React Native Patterns (2026)

## Before Coding
```bash
# ALWAYS search first
Search: "react native new architecture"
Search: "react native 0.76 features"
Search: "react native [library] compatibility"
```

---

## Project Structure (New Architecture)
```
src/
├── app/                     # Expo Router or navigation
│   ├── _layout.tsx          # Root layout
│   ├── index.tsx            # Home
│   ├── (auth)/
│   │   ├── login.tsx
│   │   └── register.tsx
│   └── (tabs)/
│       ├── _layout.tsx      # Tab navigator
│       ├── home.tsx
│       └── profile.tsx
├── components/
│   ├── ui/                  # Reusable UI
│   └── [feature]/           # Feature components
├── hooks/
│   ├── useAuth.ts
│   └── useApi.ts
├── services/
│   ├── api.ts               # API client
│   ├── storage.ts           # Secure storage
│   └── notifications.ts
├── stores/                  # Zustand stores
│   ├── authStore.ts
│   └── appStore.ts
├── utils/
└── types/
```

---

## Key 2026 Patterns

### 1. Expo Router (file-based navigation)
```tsx
// app/_layout.tsx
import { Stack } from 'expo-router';
import { useAuth } from '@/hooks/useAuth';

export default function RootLayout() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded) return <SplashScreen />;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      {isSignedIn ? (
        <Stack.Screen name="(tabs)" />
      ) : (
        <Stack.Screen name="(auth)" />
      )}
    </Stack>
  );
}
```

### 2. State Management (Zustand + MMKV)
```tsx
// stores/authStore.ts
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { MMKV } from 'react-native-mmkv';

const storage = new MMKV();

const mmkvStorage = {
  getItem: (name: string) => storage.getString(name) ?? null,
  setItem: (name: string, value: string) => storage.set(name, value),
  removeItem: (name: string) => storage.delete(name),
};

interface AuthState {
  token: string | null;
  user: User | null;
  setAuth: (token: string, user: User) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      setAuth: (token, user) => set({ token, user }),
      logout: () => set({ token: null, user: null }),
    }),
    { name: 'auth', storage: createJSONStorage(() => mmkvStorage) }
  )
);
```

### 3. API Layer (React Query + fetch)
```tsx
// services/api.ts
import { useAuthStore } from '@/stores/authStore';

const BASE_URL = process.env.EXPO_PUBLIC_API_URL;

export async function api<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const token = useAuthStore.getState().token;
  
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...options?.headers,
    },
  });

  if (!res.ok) {
    if (res.status === 401) useAuthStore.getState().logout();
    throw new ApiError(res.status, await res.json());
  }

  return res.json();
}

// hooks/useOrders.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

export function useOrders() {
  return useQuery({
    queryKey: ['orders'],
    queryFn: () => api<Order[]>('/orders'),
  });
}

export function useCreateOrder() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (data: CreateOrderDto) => api('/orders', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['orders'] }),
  });
}
```

### 4. New Architecture TurboModule (native)
```tsx
// For custom native modules (New Architecture)
// specs/NativeCalculator.ts
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  multiply(a: number, b: number): number;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeCalculator');
```

### 5. Secure Token Handling
```tsx
// services/storage.ts
import * as SecureStore from 'expo-secure-store';

export const secureStorage = {
  async set(key: string, value: string) {
    await SecureStore.setItemAsync(key, value);
  },
  async get(key: string) {
    return SecureStore.getItemAsync(key);
  },
  async delete(key: string) {
    await SecureStore.deleteItemAsync(key);
  },
};

// For tokens:
// await secureStorage.set('refresh_token', token);
```

### 6. Push Notifications (Expo)
```tsx
// services/notifications.ts
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { api } from './api';

export async function registerForPushNotifications() {
  if (!Device.isDevice) return;

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;
  
  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') return;

  const token = (await Notifications.getExpoPushTokenAsync()).data;
  
  // Send to backend
  await api('/users/push-token', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
}
```

### 7. Offline-First (WatermelonDB)
```tsx
// For complex offline: use WatermelonDB
import { Database } from '@nozbe/watermelondb';
import SQLiteAdapter from '@nozbe/watermelondb/adapters/sqlite';

const adapter = new SQLiteAdapter({
  schema,
  migrations,
  jsi: true, // New Architecture
  onSetUpError: error => console.error(error),
});

export const database = new Database({
  adapter,
  modelClasses: [Order, Product, User],
});
```

---

## Component Patterns
```tsx
// Optimized list with FlashList
import { FlashList } from '@shopify/flash-list';

export function OrderList({ orders }: { orders: Order[] }) {
  return (
    <FlashList
      data={orders}
      renderItem={({ item }) => <OrderCard order={item} />}
      estimatedItemSize={80}
      keyExtractor={(item) => item.id}
    />
  );
}

// Skeleton loading
import { Skeleton } from 'moti/skeleton';

export function OrderSkeleton() {
  return (
    <Skeleton.Group show>
      <Skeleton width="100%" height={80} />
      <Skeleton width="60%" height={20} />
    </Skeleton.Group>
  );
}
```

---

## Libraries 2026
| Purpose | Library |
|---------|---------|
| Navigation | Expo Router |
| State | Zustand + MMKV |
| API | TanStack Query |
| Forms | React Hook Form + Zod |
| Lists | FlashList |
| Animations | Reanimated 3 |
| Storage | MMKV (fast) / SecureStore (tokens) |
| UI | Tamagui or NativeWind |

---

## Verify
```bash
# iOS
npx expo run:ios

# Android
npx expo run:android

# Test
npm run test
```
