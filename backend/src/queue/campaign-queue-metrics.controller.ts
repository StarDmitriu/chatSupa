import {
  Controller,
  Get,
  Headers,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { QueueService } from './queue.service';

/**
 * Метрики глубины очередей рассылки — для мониторинга (Uptime Kuma, Grafana, ручной curl).
 * Без INTERNAL_METRICS_KEY в env эндпоинт отключён (404), чтобы не светить структуру очередей.
 * Ответ: per-queue счётчики, summary, skew по шардам, failed/prioritized, campaignVip — см. docs/CAMPAIGN_QUEUE_RUNBOOK.md
 */
@Controller('health')
export class CampaignQueueMetricsController {
  constructor(private readonly queueService: QueueService) {}

  @Get('campaign-queues')
  async campaignQueues(
    @Headers('x-internal-metrics-key') key?: string,
  ): Promise<Awaited<ReturnType<QueueService['getCampaignSendQueuesMetrics']>>> {
    const expected = (process.env.INTERNAL_METRICS_KEY || '').trim();
    if (!expected) {
      throw new NotFoundException();
    }
    if (key !== expected) {
      throw new ForbiddenException();
    }
    return this.queueService.getCampaignSendQueuesMetrics();
  }
}
