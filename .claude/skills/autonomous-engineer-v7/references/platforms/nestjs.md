# NestJS Patterns (2026)

## Before Coding
```bash
# ALWAYS search first
Search: "nestjs [version] features"
Search: "nestjs [feature] best practices 2026"
```

---

## Project Structure (2026 Standard)
```
src/
├── main.ts                 # Bootstrap (Fastify recommended)
├── app.module.ts           # Root module
├── config/
│   ├── config.module.ts    # Dynamic config from DB
│   └── config.service.ts   # TTL-cached, type-safe
├── common/
│   ├── decorators/         # Custom decorators
│   ├── guards/             # Auth, roles, rate-limit
│   ├── interceptors/       # Logging, transform, cache
│   ├── filters/            # Exception handling
│   └── pipes/              # Validation
├── modules/
│   └── [domain]/
│       ├── [domain].module.ts
│       ├── [domain].controller.ts
│       ├── [domain].service.ts
│       ├── [domain].repository.ts
│       ├── dto/
│       ├── entities/
│       └── [domain].spec.ts
├── database/
│   ├── database.module.ts
│   ├── migrations/
│   └── seeds/
└── shared/
    ├── ai/                 # LLM integration
    ├── queue/              # BullMQ jobs
    └── events/             # Event emitter
```

---

## Key 2026 Patterns

### 1. Standalone Application (faster bootstrap)
```typescript
// main.ts
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';

async function bootstrap() {
  const app = await NestFactory.create(
    AppModule,
    new FastifyAdapter({ logger: true })
  );
  
  // Global pipes, filters, interceptors
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());
  
  await app.listen(process.env.PORT || 3000, '0.0.0.0');
}
bootstrap();
```

### 2. DB-Driven Config
```typescript
// config/config.service.ts
@Injectable()
export class ConfigService {
  private cache = new Map<string, { value: any; expiry: number }>();
  private TTL = 60_000; // 1 minute

  constructor(private prisma: PrismaService) {}

  async get<T>(key: string, defaultValue?: T): Promise<T> {
    const cached = this.cache.get(key);
    if (cached && cached.expiry > Date.now()) {
      return cached.value;
    }
    
    const config = await this.prisma.appConfig.findUnique({ where: { key } });
    const value = config?.value ?? defaultValue;
    
    this.cache.set(key, { value, expiry: Date.now() + this.TTL });
    return value;
  }
}
```

### 3. Repository Pattern (clean separation)
```typescript
// modules/orders/order.repository.ts
@Injectable()
export class OrderRepository {
  constructor(private prisma: PrismaService) {}

  async create(data: CreateOrderDto, tx?: PrismaTransaction) {
    const client = tx ?? this.prisma;
    return client.order.create({ data });
  }

  async findWithItems(id: string) {
    return this.prisma.order.findUnique({
      where: { id },
      include: { items: true, user: { select: { id: true, email: true } } }
    });
  }

  async listPaginated(params: { cursor?: string; limit: number; userId?: string }) {
    const { cursor, limit, userId } = params;
    return this.prisma.order.findMany({
      where: { userId },
      take: limit + 1,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { createdAt: 'desc' }
    });
  }
}
```

### 4. Service Layer (business logic only)
```typescript
// modules/orders/order.service.ts
@Injectable()
export class OrderService {
  constructor(
    private orderRepo: OrderRepository,
    private productRepo: ProductRepository,
    private config: ConfigService,
    private eventEmitter: EventEmitter2,
    private queue: InjectQueue('orders'),
  ) {}

  async create(userId: string, dto: CreateOrderDto) {
    // Get config from DB
    const taxRate = await this.config.get<number>('tax_rate', 0.1);
    
    // Calculate
    const subtotal = dto.items.reduce((sum, i) => sum + i.price * i.quantity, 0);
    const tax = Math.round(subtotal * taxRate);
    const total = subtotal + tax;

    // Transaction
    const order = await this.prisma.$transaction(async (tx) => {
      // Create order
      const order = await this.orderRepo.create({ userId, subtotal, tax, total }, tx);
      
      // Decrement inventory
      for (const item of dto.items) {
        await this.productRepo.decrementStock(item.productId, item.quantity, tx);
      }
      
      return order;
    });

    // Side effects (async)
    this.eventEmitter.emit('order.created', order);
    await this.queue.add('send-confirmation', { orderId: order.id });

    return order;
  }
}
```

### 5. AI Integration Module
```typescript
// shared/ai/ai.module.ts
@Module({
  providers: [AiService, PromptService, CostTracker],
  exports: [AiService],
})
export class AiModule {}

// shared/ai/ai.service.ts
@Injectable()
export class AiService {
  constructor(
    private prompts: PromptService,
    private costs: CostTracker,
    private config: ConfigService,
  ) {}

  async complete(promptKey: string, variables: Record<string, any>) {
    // Get prompt from DB (versioned)
    const prompt = await this.prompts.get(promptKey);
    const rendered = this.render(prompt.template, variables);
    
    // Check budget
    const budget = await this.config.get('ai_monthly_budget');
    const spent = await this.costs.getMonthlyTotal();
    if (spent > budget * 0.9) {
      throw new BudgetExceededError();
    }

    // Call LLM with fallback chain
    const models = await this.config.get<string[]>('ai_model_chain');
    for (const model of models) {
      try {
        const result = await this.callModel(model, rendered);
        await this.costs.log(model, result.usage);
        return result;
      } catch (e) {
        if (model === models.at(-1)) throw e;
        // fallback to next model
      }
    }
  }
}
```

### 6. Queue Processing (BullMQ)
```typescript
// shared/queue/order.processor.ts
@Processor('orders')
export class OrderProcessor {
  constructor(
    private mailer: MailerService,
    private orderRepo: OrderRepository,
  ) {}

  @Process('send-confirmation')
  async sendConfirmation(job: Job<{ orderId: string }>) {
    const order = await this.orderRepo.findWithItems(job.data.orderId);
    await this.mailer.send({
      to: order.user.email,
      template: 'order-confirmation',
      data: order,
    });
  }
}
```

---

## Module Checklist
```
□ Module registered in parent
□ Controller thin (validation only)
□ Service has business logic
□ Repository handles DB
□ DTOs with class-validator
□ Entities match DB schema
□ Tests cover service layer
□ Events emitted for side effects
□ Queue jobs for async work
```

---

## Verify
```bash
# Run
npm run start:dev

# Test
npm run test
npm run test:e2e

# Lint
npm run lint
```
