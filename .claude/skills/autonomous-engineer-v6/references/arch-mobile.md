# Architecture Reference — Mobile Apps

## Framework Choice

| Scenario | Recommendation |
|----------|---------------|
| Cross-platform, JS team | React Native + Expo |
| Cross-platform, performance-critical | Flutter |
| iOS-only, Swift team | SwiftUI + Swift Concurrency |
| Android-only, Kotlin team | Jetpack Compose |

Default assumption: **React Native + Expo** unless stated otherwise.

---

## React Native + Expo Architecture

### Recommended Stack

| Concern | Library |
|---------|---------|
| Navigation | Expo Router (file-based) |
| State management | Zustand + React Query |
| API client | React Query + tRPC or Axios |
| Local storage | MMKV (fast) or AsyncStorage |
| Forms | React Hook Form + Zod |
| Styling | NativeWind (Tailwind for RN) |
| Animations | Reanimated 3 |
| Auth | Expo SecureStore for tokens |

### Folder Structure

```
app/
├── (auth)/               # Auth flow screens
│   ├── login.tsx
│   └── register.tsx
├── (app)/                # Protected screens
│   ├── _layout.tsx       # Auth guard here
│   ├── index.tsx
│   └── [feature]/
├── _layout.tsx           # Root layout + providers
└── +not-found.tsx

src/
├── api/                  # API client layer
│   ├── client.ts         # Axios/tRPC setup
│   └── hooks/            # React Query hooks per entity
├── store/                # Zustand stores
│   └── [feature].store.ts
├── components/           # Shared UI components
├── config/               # App config (reads from API + local)
└── utils/
```

---

## Config Pattern for Mobile

Mobile apps must NOT hardcode:
- API URLs → fetched from a remote config endpoint on startup
- Feature flags → fetched from backend config service
- UI strings for dynamic content → from CMS or config

```typescript
// src/config/remote-config.ts
// On app launch, fetch and cache remote config
async function loadRemoteConfig(): Promise<AppConfig> {
  const cached = await MMKV.getString('remote_config');
  const cacheAge = await MMKV.getNumber('remote_config_age');

  // Use cache if < 5 minutes old
  if (cached && cacheAge && Date.now() - cacheAge < 300_000) {
    return JSON.parse(cached);
  }

  const config = await api.get('/app/config');
  MMKV.set('remote_config', JSON.stringify(config));
  MMKV.set('remote_config_age', Date.now());
  return config;
}
```

---

## Offline-First Pattern

For apps that must work without connectivity:

```
User Action
  → Optimistic UI update (immediate)
  → Write to local SQLite / MMKV queue
  → Sync engine tries to push to server
    → Success: mark synced, update local record
    → Failure: retry with exponential backoff
    → Conflict: server wins (or merge strategy)
```

Use **WatermelonDB** for complex local-first data with sync.

---

## Auth Token Handling

```typescript
// NEVER store tokens in AsyncStorage — use SecureStore
import * as SecureStore from 'expo-secure-store';

export const tokenStorage = {
  get: (key: string) => SecureStore.getItemAsync(key),
  set: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  delete: (key: string) => SecureStore.deleteItemAsync(key),
};

// Intercept 401s and refresh silently
api.interceptors.response.use(null, async (error) => {
  if (error.response?.status === 401) {
    const refreshToken = await tokenStorage.get('refresh_token');
    const { accessToken } = await refreshTokenApi(refreshToken);
    await tokenStorage.set('access_token', accessToken);
    return api.request(error.config); // retry
  }
  return Promise.reject(error);
});
```

---

## Performance Checklist

- [ ] All lists use `FlashList` not `FlatList` (10x faster)
- [ ] Images use `expo-image` with caching
- [ ] Heavy computation off JS thread via `react-native-worklets`
- [ ] No `useEffect` chains for data fetching — use React Query
- [ ] Screen transitions <300ms
- [ ] JS bundle split by route (Expo Router does this automatically)
