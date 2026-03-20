# Flutter Patterns (2026)

## Before Coding
```bash
# ALWAYS search first
Search: "flutter 4 features"
Search: "flutter riverpod best practices"
Search: "flutter [feature] 2026"
```

---

## Project Structure
```
lib/
├── main.dart
├── app/
│   ├── app.dart              # MaterialApp + routing
│   └── router.dart           # GoRouter config
├── core/
│   ├── config/               # Environment, constants
│   ├── network/              # Dio client, interceptors
│   ├── storage/              # SharedPrefs, secure storage
│   └── utils/                # Extensions, helpers
├── features/
│   └── [feature]/
│       ├── data/
│       │   ├── models/       # JSON serializable
│       │   ├── repositories/ # Data sources
│       │   └── providers/    # Riverpod providers
│       ├── presentation/
│       │   ├── screens/
│       │   ├── widgets/
│       │   └── controllers/  # Riverpod notifiers
│       └── domain/           # Business logic (if complex)
└── shared/
    ├── widgets/              # Reusable UI
    └── providers/            # Global providers
```

---

## Key 2026 Patterns

### 1. Riverpod 2.0 (state management)
```dart
// features/orders/data/providers/orders_provider.dart
import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'orders_provider.g.dart';

@riverpod
class OrdersNotifier extends _$OrdersNotifier {
  @override
  Future<List<Order>> build() async {
    return ref.watch(orderRepositoryProvider).getOrders();
  }

  Future<void> createOrder(CreateOrderDto dto) async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(() async {
      await ref.read(orderRepositoryProvider).create(dto);
      return ref.read(orderRepositoryProvider).getOrders();
    });
  }

  Future<void> refresh() async {
    ref.invalidateSelf();
  }
}

// Usage in widget:
// final orders = ref.watch(ordersNotifierProvider);
// orders.when(
//   data: (data) => OrderList(orders: data),
//   loading: () => LoadingWidget(),
//   error: (e, st) => ErrorWidget(error: e),
// );
```

### 2. GoRouter (declarative navigation)
```dart
// app/router.dart
import 'package:go_router/go_router.dart';

final routerProvider = Provider<GoRouter>((ref) {
  final authState = ref.watch(authProvider);
  
  return GoRouter(
    initialLocation: '/',
    redirect: (context, state) {
      final isLoggedIn = authState.isAuthenticated;
      final isAuthRoute = state.matchedLocation.startsWith('/auth');
      
      if (!isLoggedIn && !isAuthRoute) return '/auth/login';
      if (isLoggedIn && isAuthRoute) return '/';
      return null;
    },
    routes: [
      GoRoute(
        path: '/',
        builder: (_, __) => const HomeScreen(),
        routes: [
          GoRoute(
            path: 'orders/:id',
            builder: (_, state) => OrderDetailScreen(
              id: state.pathParameters['id']!,
            ),
          ),
        ],
      ),
      GoRoute(
        path: '/auth/login',
        builder: (_, __) => const LoginScreen(),
      ),
    ],
  );
});
```

### 3. Repository Pattern
```dart
// features/orders/data/repositories/order_repository.dart
import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'order_repository.g.dart';

@riverpod
OrderRepository orderRepository(OrderRepositoryRef ref) {
  return OrderRepository(ref.watch(dioProvider));
}

class OrderRepository {
  final Dio _dio;
  
  OrderRepository(this._dio);

  Future<List<Order>> getOrders() async {
    final response = await _dio.get('/orders');
    return (response.data as List)
        .map((json) => Order.fromJson(json))
        .toList();
  }

  Future<Order> getOrder(String id) async {
    final response = await _dio.get('/orders/$id');
    return Order.fromJson(response.data);
  }

  Future<Order> create(CreateOrderDto dto) async {
    final response = await _dio.post('/orders', data: dto.toJson());
    return Order.fromJson(response.data);
  }
}
```

### 4. Dio + Interceptors
```dart
// core/network/dio_client.dart
@riverpod
Dio dio(DioRef ref) {
  final dio = Dio(BaseOptions(
    baseUrl: Environment.apiUrl,
    connectTimeout: const Duration(seconds: 10),
    receiveTimeout: const Duration(seconds: 10),
  ));

  dio.interceptors.addAll([
    AuthInterceptor(ref),
    LogInterceptor(requestBody: true, responseBody: true),
    RetryInterceptor(dio: dio, retries: 3),
  ]);

  return dio;
}

class AuthInterceptor extends Interceptor {
  final Ref _ref;
  
  AuthInterceptor(this._ref);

  @override
  void onRequest(options, handler) {
    final token = _ref.read(authProvider).token;
    if (token != null) {
      options.headers['Authorization'] = 'Bearer $token';
    }
    handler.next(options);
  }

  @override
  void onError(err, handler) {
    if (err.response?.statusCode == 401) {
      _ref.read(authProvider.notifier).logout();
    }
    handler.next(err);
  }
}
```

### 5. Freezed Models (immutable + JSON)
```dart
// features/orders/data/models/order.dart
import 'package:freezed_annotation/freezed_annotation.dart';

part 'order.freezed.dart';
part 'order.g.dart';

@freezed
class Order with _$Order {
  const factory Order({
    required String id,
    required String userId,
    required List<OrderItem> items,
    required int totalCents,
    required OrderStatus status,
    required DateTime createdAt,
  }) = _Order;

  factory Order.fromJson(Map<String, dynamic> json) => _$OrderFromJson(json);
}

@freezed
class CreateOrderDto with _$CreateOrderDto {
  const factory CreateOrderDto({
    required List<OrderItemDto> items,
  }) = _CreateOrderDto;

  factory CreateOrderDto.fromJson(Map<String, dynamic> json) =>
      _$CreateOrderDtoFromJson(json);
}
```

### 6. Secure Storage
```dart
// core/storage/secure_storage.dart
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class SecureStorage {
  static const _storage = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  static Future<void> setToken(String token) =>
      _storage.write(key: 'access_token', value: token);

  static Future<String?> getToken() =>
      _storage.read(key: 'access_token');

  static Future<void> deleteToken() =>
      _storage.delete(key: 'access_token');

  static Future<void> clear() => _storage.deleteAll();
}
```

### 7. Widget Patterns
```dart
// Async widget with Riverpod
class OrdersScreen extends ConsumerWidget {
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final ordersAsync = ref.watch(ordersNotifierProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Orders')),
      body: ordersAsync.when(
        data: (orders) => orders.isEmpty
            ? const EmptyState(message: 'No orders yet')
            : ListView.builder(
                itemCount: orders.length,
                itemBuilder: (_, i) => OrderCard(order: orders[i]),
              ),
        loading: () => const OrderListSkeleton(),
        error: (e, _) => ErrorState(
          error: e,
          onRetry: () => ref.invalidate(ordersNotifierProvider),
        ),
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: () => context.push('/orders/new'),
        child: const Icon(Icons.add),
      ),
    );
  }
}
```

---

## Code Generation
```bash
# Run once to generate code
dart run build_runner build --delete-conflicting-outputs

# Or watch mode during development
dart run build_runner watch
```

---

## Libraries 2026
| Purpose | Library |
|---------|---------|
| State | Riverpod 2.0 |
| Navigation | GoRouter |
| Network | Dio |
| Models | Freezed + json_serializable |
| Storage | SharedPreferences / flutter_secure_storage |
| Forms | Reactive Forms |
| UI | Material 3 / custom design system |

---

## Verify
```bash
# Analyze
flutter analyze

# Test
flutter test

# Run
flutter run
```
