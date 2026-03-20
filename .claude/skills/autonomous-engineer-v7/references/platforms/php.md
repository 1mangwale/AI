# PHP / Laravel Patterns (2026)

## Before Coding
```bash
# ALWAYS search first
Search: "laravel 12 features"
Search: "php 8.4 features"
Search: "laravel [feature] best practices 2026"
```

---

## Project Structure
```
app/
├── Console/                  # Artisan commands
├── Exceptions/               # Exception handlers
├── Http/
│   ├── Controllers/          # Thin controllers
│   ├── Middleware/
│   ├── Requests/             # Form requests (validation)
│   └── Resources/            # API resources
├── Models/                   # Eloquent models
├── Services/                 # Business logic
├── Repositories/             # Data access (optional)
├── Actions/                  # Single-purpose actions
├── DTOs/                     # Data transfer objects
├── Enums/                    # PHP 8.1+ enums
├── Events/
├── Listeners/
├── Jobs/                     # Queue jobs
├── Notifications/
└── Providers/
config/
database/
├── migrations/
├── factories/
└── seeders/
routes/
├── api.php
├── web.php
└── channels.php
resources/
├── views/                    # Blade (or Inertia)
└── js/                       # If using Inertia
tests/
├── Feature/
└── Unit/
```

---

## Key 2026 Patterns

### 1. Actions Pattern (single responsibility)
```php
// app/Actions/CreateOrderAction.php
<?php

namespace App\Actions;

use App\DTOs\CreateOrderDTO;
use App\Models\Order;
use App\Services\InventoryService;
use Illuminate\Support\Facades\DB;

class CreateOrderAction
{
    public function __construct(
        private InventoryService $inventory,
    ) {}

    public function execute(CreateOrderDTO $dto): Order
    {
        return DB::transaction(function () use ($dto) {
            // Create order
            $order = Order::create([
                'user_id' => $dto->userId,
                'status' => OrderStatus::Pending,
                'subtotal' => $dto->calculateSubtotal(),
                'tax' => $dto->calculateTax(),
                'total' => $dto->calculateTotal(),
            ]);

            // Create items
            foreach ($dto->items as $item) {
                $order->items()->create($item->toArray());
                $this->inventory->decrement($item->productId, $item->quantity);
            }

            // Dispatch events
            OrderCreated::dispatch($order);

            return $order->load('items');
        });
    }
}

// Usage in controller:
// return (new CreateOrderAction($inventory))->execute($dto);
// Or with DI: $this->createOrder->execute($dto);
```

### 2. DTOs with Spatie
```php
// app/DTOs/CreateOrderDTO.php
<?php

namespace App\DTOs;

use Spatie\LaravelData\Data;
use Spatie\LaravelData\Attributes\Validation\Required;

class CreateOrderDTO extends Data
{
    public function __construct(
        #[Required]
        public readonly string $userId,
        
        /** @var OrderItemDTO[] */
        #[Required]
        public readonly array $items,
    ) {}

    public function calculateSubtotal(): int
    {
        return collect($this->items)->sum(
            fn (OrderItemDTO $item) => $item->price * $item->quantity
        );
    }

    public function calculateTax(): int
    {
        $rate = config('shop.tax_rate', 0.1);
        return (int) ($this->calculateSubtotal() * $rate);
    }

    public function calculateTotal(): int
    {
        return $this->calculateSubtotal() + $this->calculateTax();
    }
}
```

### 3. API Resources (clean output)
```php
// app/Http/Resources/OrderResource.php
<?php

namespace App\Http\Resources;

use Illuminate\Http\Resources\Json\JsonResource;

class OrderResource extends JsonResource
{
    public function toArray($request): array
    {
        return [
            'id' => $this->id,
            'status' => $this->status->value,
            'items' => OrderItemResource::collection($this->whenLoaded('items')),
            'subtotal_cents' => $this->subtotal,
            'tax_cents' => $this->tax,
            'total_cents' => $this->total,
            'created_at' => $this->created_at->toISOString(),
        ];
    }
}
```

### 4. Form Requests (validation)
```php
// app/Http/Requests/CreateOrderRequest.php
<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class CreateOrderRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true; // or check permissions
    }

    public function rules(): array
    {
        return [
            'items' => ['required', 'array', 'min:1'],
            'items.*.product_id' => ['required', 'exists:products,id'],
            'items.*.quantity' => ['required', 'integer', 'min:1'],
        ];
    }

    public function toDTO(): CreateOrderDTO
    {
        return CreateOrderDTO::from([
            'userId' => $this->user()->id,
            'items' => $this->items,
        ]);
    }
}
```

### 5. Thin Controllers
```php
// app/Http/Controllers/OrderController.php
<?php

namespace App\Http\Controllers;

use App\Actions\CreateOrderAction;
use App\Http\Requests\CreateOrderRequest;
use App\Http\Resources\OrderResource;

class OrderController extends Controller
{
    public function __construct(
        private CreateOrderAction $createOrder,
    ) {}

    public function store(CreateOrderRequest $request): OrderResource
    {
        $order = $this->createOrder->execute($request->toDTO());
        
        return new OrderResource($order);
    }

    public function index()
    {
        $orders = auth()->user()
            ->orders()
            ->with('items')
            ->latest()
            ->cursorPaginate(20);

        return OrderResource::collection($orders);
    }
}
```

### 6. Config from DB
```php
// app/Services/ConfigService.php
<?php

namespace App\Services;

use App\Models\AppConfig;
use Illuminate\Support\Facades\Cache;

class ConfigService
{
    public function get(string $key, mixed $default = null): mixed
    {
        return Cache::remember("config:{$key}", 60, function () use ($key, $default) {
            return AppConfig::where('key', $key)->value('value') ?? $default;
        });
    }

    public function set(string $key, mixed $value): void
    {
        AppConfig::updateOrCreate(['key' => $key], ['value' => $value]);
        Cache::forget("config:{$key}");
    }
}
```

### 7. Queue Jobs
```php
// app/Jobs/SendOrderConfirmation.php
<?php

namespace App\Jobs;

use App\Models\Order;
use App\Mail\OrderConfirmationMail;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Support\Facades\Mail;

class SendOrderConfirmation implements ShouldQueue
{
    use Queueable;

    public int $tries = 3;
    public int $backoff = 60;

    public function __construct(
        public Order $order,
    ) {}

    public function handle(): void
    {
        Mail::to($this->order->user->email)
            ->send(new OrderConfirmationMail($this->order));
    }
}

// Dispatch: SendOrderConfirmation::dispatch($order);
```

### 8. Livewire 3 (reactive UI)
```php
// app/Livewire/OrderList.php
<?php

namespace App\Livewire;

use Livewire\Component;
use Livewire\WithPagination;
use App\Models\Order;

class OrderList extends Component
{
    use WithPagination;

    public string $search = '';
    public string $status = '';

    public function render()
    {
        $orders = Order::query()
            ->where('user_id', auth()->id())
            ->when($this->search, fn ($q) => $q->where('id', 'like', "%{$this->search}%"))
            ->when($this->status, fn ($q) => $q->where('status', $this->status))
            ->latest()
            ->paginate(20);

        return view('livewire.order-list', compact('orders'));
    }
}
```

---

## Database Patterns
```php
// Cursor pagination (efficient)
$orders = Order::cursorPaginate(20);

// Eager loading (avoid N+1)
$orders = Order::with(['items', 'user:id,name'])->get();

// Chunk for batch processing
Order::where('status', 'pending')
    ->chunkById(100, function ($orders) {
        foreach ($orders as $order) {
            ProcessOrder::dispatch($order);
        }
    });
```

---

## Testing
```php
// tests/Feature/OrderTest.php
public function test_user_can_create_order(): void
{
    $user = User::factory()->create();
    $product = Product::factory()->create(['price' => 1000]);

    $response = $this->actingAs($user)
        ->postJson('/api/orders', [
            'items' => [
                ['product_id' => $product->id, 'quantity' => 2],
            ],
        ]);

    $response->assertCreated()
        ->assertJsonPath('data.total_cents', 2200); // with 10% tax

    $this->assertDatabaseHas('orders', [
        'user_id' => $user->id,
        'total' => 2200,
    ]);
}
```

---

## Verify
```bash
# Test
php artisan test

# Lint
./vendor/bin/pint

# Static analysis
./vendor/bin/phpstan analyse
```
