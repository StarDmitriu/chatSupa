import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private readonly apiId = (process.env.SMSRU_API_ID || '').trim();
  private readonly from = (process.env.SMSRU_FROM || '').trim(); // опционально
  private readonly env = (process.env.NODE_ENV || 'development').trim();

  /**
   * sms.ru send endpoint:
   * https://sms.ru/sms/send?api_id=...&to=...&msg=...&json=1
   */
  async sendSms(phone: string, text: string) {
    // ✅ DEV режим: если нет API ключа — НЕ ломаем логин, просто логируем код
    if (!this.apiId) {
      this.logger.warn(
        `SMSRU_API_ID не задан -> DEV mode: SMS не отправляем. phone=${phone} text="${text}"`,
      );
      return { success: true, dev: true, reason: 'no_api_id' };
    }

    try {
      const params: any = {
        api_id: this.apiId,
        to: phone,
        msg: text,
        json: 1,
      };

      // sender name (если задан)
      if (this.from) {
        params.from = this.from;
      }

      const res = await axios.get('https://sms.ru/sms/send', {
        params,
        timeout: 15_000,
      });

      const data = res.data;

      /**
       * У sms.ru JSON примерно такой:
       * { "status":"OK","status_code":100,"sms":{ "<phone>": {"status":"OK","status_code":100,"sms_id":"..."} } }
       */
      if (!data || data.status !== 'OK') {
        this.logger.warn(`sms.ru error response: ${JSON.stringify(data)}`);
        return { success: false, reason: 'smsru_not_ok', data };
      }

      // иногда удобно проверить status_code=100
      if (data.status_code && Number(data.status_code) !== 100) {
        this.logger.warn(`sms.ru status_code != 100: ${JSON.stringify(data)}`);
        return { success: false, reason: 'smsru_status_code', data };
      }

      // вытаскиваем статус по конкретному номеру (обычно ключ == phone)
      let perPhoneStatus: string | undefined;
      let perPhoneStatusCode: number | undefined;
      let perPhoneStatusText: string | undefined;
      try {
        if (data.sms && typeof data.sms === 'object') {
          const firstKey = Object.keys(data.sms)[0];
          const smsInfo = firstKey ? data.sms[firstKey] : undefined;
          if (smsInfo) {
            perPhoneStatus = smsInfo.status;
            perPhoneStatusCode =
              typeof smsInfo.status_code === 'number'
                ? smsInfo.status_code
                : Number(smsInfo.status_code);
            if (typeof smsInfo.status_text === 'string') {
              perPhoneStatusText = smsInfo.status_text;
            }
          }
        }
      } catch {
        // игнорируем, это только для логов
      }

      // Маскируем часть номера в логах
      const maskedPhone =
        phone && phone.length > 4
          ? `${'*'.repeat(phone.length - 4)}${phone.slice(-4)}`
          : phone;

      this.logger.log(
        `SMS via sms.ru OK: status=${data.status} code=${data.status_code} ` +
          `phone=${maskedPhone} ` +
          (perPhoneStatus
            ? `sms_status=${perPhoneStatus} sms_code=${perPhoneStatusCode}${
                perPhoneStatusText ? ` sms_text="${perPhoneStatusText}"` : ''
              }`
            : ''),
      );

      // Важно: общий ответ может быть OK, но конкретный номер — ERROR (например, 204/209/233/304 и т.п.)
      // В этом случае считаем отправку НЕуспешной, чтобы фронт не говорил пользователю "код отправлен".
      if (perPhoneStatus && perPhoneStatus !== 'OK') {
        return {
          success: false,
          reason: 'smsru_per_phone_error',
          provider: 'smsru',
          status: perPhoneStatus,
          status_code: perPhoneStatusCode,
          status_text: perPhoneStatusText,
        };
      }
      if (
        typeof perPhoneStatusCode === 'number' &&
        Number.isFinite(perPhoneStatusCode) &&
        perPhoneStatusCode !== 100
      ) {
        return {
          success: false,
          reason: 'smsru_per_phone_status_code',
          provider: 'smsru',
          status: perPhoneStatus,
          status_code: perPhoneStatusCode,
          status_text: perPhoneStatusText,
        };
      }

      return { success: true, provider: 'smsru', data };
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const resp = e?.response?.data ? JSON.stringify(e.response.data) : null;

      this.logger.error(
        `SMS send failed: ${msg}${resp ? ` resp=${resp}` : ''}`,
      );

      return { success: false, reason: 'smsru_exception', error: msg, resp };
    }
  }
}
