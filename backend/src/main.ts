import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import * as dotenv from 'dotenv';
import {
  getRuntimeInstanceId,
  runtimeCapabilitiesLabel,
  runtimeHasCapability,
} from './runtime/runtime-role';

dotenv.config();

async function bootstrap() {
  const runtimeLabel = runtimeCapabilitiesLabel();
  const instanceId = getRuntimeInstanceId();

  if (!runtimeHasCapability('api')) {
    const app = await NestFactory.createApplicationContext(AppModule);
    console.log(
      `[Runtime] started background context role=${runtimeLabel} instance=${instanceId}`,
    );

    const shutdown = async () => {
      await app.close().catch(() => undefined);
      process.exit(0);
    };

    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
    return;
  }

  const app = await NestFactory.create(AppModule);
  const server = app.getHttpAdapter().getInstance();

  server.get('/', (_req: any, res: any) => {
    res.status(200).send('ok');
  });

  const corsOriginsRaw = String(process.env.CORS_ORIGINS || '').trim();
  const corsOrigins = corsOriginsRaw
    ? corsOriginsRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [
        'https://chatrassylka.ru',
        'https://www.chatrassylka.ru',
        'http://localhost:3001',
        'http://127.0.0.1:3001',
      ];

  app.enableCors({
    origin: (origin, cb) => {
      // без Origin: curl, сервер-сервер, healthchecks
      if (!origin) return cb(null, true);
      if (corsOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // удаляет лишние поля
      forbidNonWhitelisted: true, // если пришли лишние поля — 400
      transform: true, // приводит типы (boolean и т.п.)
    }),
  );

  const port = process.env.PORT || 3000;
  const host = (process.env.BIND_HOST || process.env.HOST || '0.0.0.0').trim();
  await app.listen(port, host);
  console.log(
    `[Runtime] listening http://${host}:${port} role=${runtimeLabel} instance=${instanceId}`,
  );
}
bootstrap();
