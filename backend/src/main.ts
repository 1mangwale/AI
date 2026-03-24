import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { NestExpressApplication } from '@nestjs/platform-express';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { join } from 'path';
import axios from 'axios';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { Response } from 'express';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log', 'debug'],
    rawBody: true,
  });

  // Enable WebSocket support with Socket.IO adapter
  app.useWebSocketAdapter(new IoAdapter(app));

  // 🍪 Cookie parser — for HttpOnly JWT cookies
  app.use(cookieParser());

  // 🔒 Security: HTTP security headers with CSP
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://accounts.google.com", "https://apis.google.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        imgSrc: ["'self'", "data:", "https:", "blob:"],
        connectSrc: ["'self'", "ws:", "wss:", "https://chat.mangwale.ai", "https://new.mangwale.com", "https://maps.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        frameSrc: ["'self'", "https://new.mangwale.com", "https://accounts.google.com"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));

  // 🛡️ Global exception filter - prevent stack trace leaks
  app.useGlobalFilters(new AllExceptionsFilter());

  // 🔄 Graceful shutdown - ensures DB connections, queues, etc. are properly closed
  app.enableShutdownHooks();

  const configService = app.get(ConfigService);
  const port = configService.get('app.port');
  const env = configService.get('app.env');
  const appName = configService.get('app.name');

  // Serve static files from public directory
  app.useStaticAssets(join(__dirname, '..', 'public'));

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Set global prefix for all routes (except health check)
  app.setGlobalPrefix('api', {
    exclude: ['health', 'ready', 'metrics', 'mcp', 'mcp/(.*)'],
  });


  // Enable CORS with strict origin whitelist
  // Parse additional CORS origins from env (comma-separated)
  const additionalCorsOrigins = process.env.ADDITIONAL_CORS_ORIGINS
    ? process.env.ADDITIONAL_CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  app.enableCors({
    origin: [
      'https://chat.mangwale.ai',
      'https://admin.mangwale.ai',
      'https://mangwale.ai',
      'https://test.mangwale.ai',
      ...additionalCorsOrigins,
      ...(process.env.NODE_ENV !== 'production' ? [
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:3005',
      ] : []),
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Admin-Api-Key'],
  });
  
  logger.log('✅ CORS enabled for frontend origins');

  // Health check endpoint - REMOVED in favor of HealthController
  // app.getHttpAdapter().get('/health', (req, res: Response) => {
  //   res.status(200).json({
  //     status: 'ok',
  //     service: appName,
  //     timestamp: new Date().toISOString(),
  //     uptime: Math.floor(process.uptime()),
  //     environment: env,
  //   });
  // });

  // Readiness probe: quick check to PHP backend (non-blocking, short timeout)
  app.getHttpAdapter().get('/ready', async (_req, res: Response) => {
    const phpBaseUrl = configService.get<string>('php.baseUrl') || process.env.PHP_BACKEND_URL;
    const checkUrl = phpBaseUrl ? `${phpBaseUrl.replace(/\/$/, '')}/api/v1/module` : null;
    const start = Date.now();
    try {
      if (!checkUrl) throw new Error('PHP base URL not configured');
      const resp = await axios.get(checkUrl, { timeout: 1500 });
      res.status(200).json({
        status: 'ready',
        php: { ok: true, statusCode: resp.status },
        latencyMs: Date.now() - start,
        timestamp: new Date().toISOString(),
      });
    } catch (e: any) {
      res.status(503).json({
        status: 'degraded',
        php: { ok: false, error: 'Service unavailable' },
        latencyMs: Date.now() - start,
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Note: Prometheus metrics endpoint is handled by MetricsController at /metrics
  // The legacy JSON endpoint has been removed in favor of the proper Prometheus format

  // 📚 Swagger API Documentation
  if (env !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Mangwale AI API')
      .setDescription('Multi-Channel Conversational AI Platform for Delivery & Ordering')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document);
    logger.log(`📚 Swagger docs: http://localhost:${port}/api/docs`);
  }

  await app.listen(port, '0.0.0.0');

  logger.log(`🚀 ${appName} running on port ${port}`);
  logger.log(`🌍 Environment: ${env}`);
  logger.log(`🔗 Health check: http://localhost:${port}/health`);
  logger.log(`📱 WhatsApp webhook: http://localhost:${port}/webhook/whatsapp`);
  logger.log('✅ Application started successfully');
}

bootstrap();

