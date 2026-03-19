# Documentation Sources by Technology

Always web_fetch the actual page — do not rely on training knowledge for APIs, schemas,
or framework conventions. These change frequently.

---

## Web Frameworks

| Technology | Primary Docs | GitHub | Best Practices Source |
|-----------|-------------|--------|-----------------------|
| Next.js | https://nextjs.org/docs | github.com/vercel/next.js | nextjs.org/docs/app/building-your-application |
| NestJS | https://docs.nestjs.com | github.com/nestjs/nest | docs.nestjs.com/fundamentals |
| FastAPI | https://fastapi.tiangolo.com | github.com/tiangolo/fastapi | fastapi.tiangolo.com/advanced |
| Django | https://docs.djangoproject.com | github.com/django/django | docs.djangoproject.com/en/stable |
| Express | https://expressjs.com/en/guide | github.com/expressjs/express | expressjs.com/en/advanced/best-practice-performance |
| Hono | https://hono.dev/docs | github.com/honojs/hono | hono.dev/docs/guides |

## Mobile

| Technology | Primary Docs | GitHub |
|-----------|-------------|--------|
| React Native | https://reactnative.dev/docs/getting-started | github.com/facebook/react-native |
| Expo | https://docs.expo.dev | github.com/expo/expo |
| Flutter | https://docs.flutter.dev | github.com/flutter/flutter |

## Databases

| Technology | Primary Docs | Migration Tool |
|-----------|-------------|----------------|
| PostgreSQL | https://www.postgresql.org/docs/current/ | Flyway / Liquibase |
| MongoDB | https://www.mongodb.com/docs/ | migrate-mongo |
| Redis | https://redis.io/docs/ | - |
| Prisma ORM | https://www.prisma.io/docs | prisma migrate |
| Drizzle ORM | https://orm.drizzle.team/docs | drizzle-kit |
| SQLAlchemy | https://docs.sqlalchemy.org | Alembic |

## ML / Data

| Technology | Primary Docs | GitHub |
|-----------|-------------|--------|
| PyTorch | https://pytorch.org/docs/stable/ | github.com/pytorch/pytorch |
| HuggingFace | https://huggingface.co/docs | github.com/huggingface/transformers |
| LangChain | https://python.langchain.com/docs | github.com/langchain-ai/langchain |
| Apache Kafka | https://kafka.apache.org/documentation/ | github.com/apache/kafka |
| Apache Airflow | https://airflow.apache.org/docs/ | github.com/apache/airflow |
| dbt | https://docs.getdbt.com | github.com/dbt-labs/dbt-core |

## Infrastructure & DevOps

| Technology | Primary Docs |
|-----------|-------------|
| Docker | https://docs.docker.com |
| Kubernetes | https://kubernetes.io/docs/home/ |
| Terraform | https://developer.hashicorp.com/terraform/docs |
| GitHub Actions | https://docs.github.com/en/actions |

## Auth & Security

| Technology | Primary Docs |
|-----------|-------------|
| Auth.js (NextAuth) | https://authjs.dev |
| Clerk | https://clerk.com/docs |
| Supabase Auth | https://supabase.com/docs/guides/auth |
| OWASP Top 10 | https://owasp.org/www-project-top-ten/ |

---

## Search Strategies

When the technology isn't in this table:

1. **Official docs**: `[technology name] documentation` → look for the .org, .dev, or .io site
2. **Changelog / recent**: `[technology] changelog 2024` or `[technology] release notes`
3. **Production patterns**: `[technology] production best practices site:github.com`
4. **Architecture examples**: `[technology] example architecture site:dev.to OR site:medium.com`

Always check the publish date. Prefer sources from the last 12 months for fast-moving tech.
