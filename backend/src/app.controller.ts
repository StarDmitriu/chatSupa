import {
  Body,
  Controller,
  Get,
  Post,
  HttpCode,
  UseGuards,
} from '@nestjs/common';
import { AppService } from './app.service';
import { RateLimitLogGuard } from './common/rate-limit.guard';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  /** Лог клиентских ошибок для разбора «Application error». Тело ограничено по длине полей (без валидации DTO — публичный эндпоинт). */
  @Post('log-client-error')
  @HttpCode(204)
  @UseGuards(RateLimitLogGuard)
  logClientError(@Body() body: unknown) {
    const b =
      body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const message =
      typeof b.message === 'string' ? b.message.slice(0, 2000) : 'unknown';
    const digest = typeof b.digest === 'string' ? b.digest.slice(0, 100) : null;
    const path = typeof b.path === 'string' ? b.path.slice(0, 500) : null;
    const url = typeof b.url === 'string' ? b.url.slice(0, 500) : null;
    const userAgent =
      typeof b.userAgent === 'string' ? b.userAgent.slice(0, 400) : null;
    const stack = typeof b.stack === 'string' ? b.stack.slice(0, 8000) : null;

    console.error(
      '[client-error]',
      JSON.stringify({
        message,
        digest,
        path,
        url,
        userAgent,
      }),
    );
    if (stack) console.error('[client-error stack]', stack);
    return;
  }
}
