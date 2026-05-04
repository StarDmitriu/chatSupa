/*import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Worker, Job } from 'bullmq';
import { SupabaseService } from '../supabase/supabase.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { QueueService } from '../queue/queue.service';

type CampaignJobData = {
  jobId: string; // id из campaign_jobs
  userId: string;
  groupJid: string;
  templateId: string;
};

@Injectable()
export class CampaignWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CampaignWorkerService.name);
  private worker?: Worker<CampaignJobData>;

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly whatsapp: WhatsappService,
    private readonly queueService: QueueService,
  ) {}

  onModuleInit() {
    /*this.worker = new Worker<CampaignJobData>(
      'campaign-send',
      async (job: Job<CampaignJobData>) => this.process(job.data),
      { connection: this.queueService.connection, concurrency: 1 },
    );

    this.worker.on('completed', (job) => {
      this.logger.log(`completed queue job ${job.id}`);
    });

    this.worker.on('failed', (job, err) => {
      this.logger.error(`failed queue job ${job?.id}: ${err?.message}`);
    });

    this.logger.log('BullMQ worker started: campaign-send');
  }

  async onModuleDestroy() {
    await this.worker?.close();
  }

  private async process(data: CampaignJobData) {
    const supabase = this.supabaseService.getClient();

    // 1) Лочим строку campaign_jobs, чтобы не обработать дважды
    const { data: locked, error: lockErr } = await supabase
      .from('campaign_jobs')
      .update({ status: 'processing', error: null })
      .eq('id', data.jobId)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();

    if (lockErr || !locked) {
      this.logger.warn(`job lock failed jobId=${data.jobId}`);
      return;
    }

    // 2) Проверяем WA / пробуем поднять сессию
    let waStatus = this.whatsapp.getStatus(data.userId);
    if (waStatus.status !== 'connected') {
      await this.whatsapp.startSession(data.userId);
      waStatus = this.whatsapp.getStatus(data.userId);
    }

    if (waStatus.status !== 'connected') {
      await supabase
        .from('campaign_jobs')
        .update({ status: 'pending', error: 'wa_not_connected' })
        .eq('id', data.jobId);

      throw new Error('wa_not_connected');
    }

    // 3) Тянем шаблон
    const { data: tpl, error: tplErr } = await supabase
      .from('message_templates')
      .select('id, text, media_url, enabled')
      .eq('id', data.templateId)
      .maybeSingle();

    if (tplErr || !tpl) {
      await supabase
        .from('campaign_jobs')
        .update({
          status: 'failed',
          error: 'template_not_found',
          sent_at: new Date().toISOString(),
        })
        .eq('id', data.jobId);
      return;
    }

    if (tpl.enabled === false) {
      await supabase
        .from('campaign_jobs')
        .update({
          status: 'skipped',
          error: 'template_disabled',
          sent_at: new Date().toISOString(),
        })
        .eq('id', data.jobId);
      return;
    }

    // 4) Отправляем
    await this.whatsapp.sendToGroup(data.userId, data.groupJid, {
      text: tpl.text ?? '',
      mediaUrl: tpl.media_url ?? null,
    });

    await supabase
      .from('campaign_jobs')
      .update({
        status: 'sent',
        error: null,
        sent_at: new Date().toISOString(),
      })
      .eq('id', data.jobId);

    this.logger.log(`sent jobId=${data.jobId} -> ${data.groupJid}`);
  }
}
*/
