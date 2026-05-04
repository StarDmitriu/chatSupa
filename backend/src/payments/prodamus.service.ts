import { Injectable } from '@nestjs/common';
import { createHmac } from 'crypto';

type AnyObj = Record<string, any>;

@Injectable()
export class ProdamusService {
  private readonly formUrl = (process.env.PRODAMUS_FORM_URL || '').trim();
  private readonly secretKey = (process.env.PRODAMUS_SECRET_KEY || '').trim();
  private readonly sys = (process.env.PRODAMUS_SYS || '').trim(); // <-- ДОБАВЬ

  assertConfig(): void {
    if (!this.formUrl) throw new Error('Missing env: PRODAMUS_FORM_URL');
    if (!this.secretKey) throw new Error('Missing env: PRODAMUS_SECRET_KEY');
    if (!this.sys) throw new Error('Missing env: PRODAMUS_SYS');
  }

  /** Проверка конфига без выброса (для контроллера). */
  isConfigReady(): boolean {
    return Boolean(
      this.formUrl?.trim() && this.secretKey?.trim() && this.sys?.trim(),
    );
  }

  getBaseFormUrl(): string {
    this.assertConfig();
    // гарантируем trailing slash
    return this.formUrl.endsWith('/') ? this.formUrl : `${this.formUrl}/`;
  }

  getSecretKey(): string {
    this.assertConfig();
    return this.secretKey;
  }

  private getRestUrl(path: string): string {
    const base = this.getBaseFormUrl();
    return `${base}rest/${path}/`;
  }

  /**
   * Приводим все значения к строкам (как требует дока)
   */
  private stringifyDeep(input: any): any {
    if (input === null || input === undefined) return '';
    if (Array.isArray(input)) return input.map((v) => this.stringifyDeep(v));
    if (typeof input === 'object') {
      const out: AnyObj = {};
      for (const k of Object.keys(input)) out[k] = this.stringifyDeep(input[k]);
      return out;
    }
    return String(input);
  }

  /**
   * Сортировка ключей по алфавиту "вглубь"
   */
  private sortDeep(input: any): any {
    if (Array.isArray(input)) return input.map((v) => this.sortDeep(v));
    if (input && typeof input === 'object') {
      const out: AnyObj = {};
      const keys = Object.keys(input).sort((a, b) => a.localeCompare(b));
      for (const k of keys) out[k] = this.sortDeep(input[k]);
      return out;
    }
    return input;
  }

  /**
   * JSON stringify + экранирование /
   */
  private toSignedJson(data: any): string {
    const str = JSON.stringify(data);
    return str.replace(/\//g, '\\/');
  }

  /**
   * Подпись: HMAC-SHA256(json, secretKey) hex
   */
  sign(data: AnyObj): string {
    const prepared = this.sortDeep(this.stringifyDeep(data));
    const json = this.toSignedJson(prepared);
    return createHmac('sha256', this.getSecretKey())
      .update(json, 'utf8')
      .digest('hex');
  }

  verify(data: AnyObj, signature: string): boolean {
    const sig = (signature || '').trim();
    if (!sig) return false;
    const expected = this.sign(data);
    // timing-safe сравнение тут не критично, но можно
    return expected === sig;
  }

  /**
   * В webhook от Payform часто прилетает multipart с ключами вида:
   * products[0][name] и т.п.
   * Для корректной подписи надо преобразовать это в объект/массив.
   */
  expandBracketKeys(flat: AnyObj): AnyObj {
    const out: AnyObj = {};

    const setDeep = (obj: any, path: (string | number)[], value: any) => {
      let cur = obj;
      for (let i = 0; i < path.length; i++) {
        const key = path[i];
        const isLast = i === path.length - 1;
        const nextKey = path[i + 1];

        const nextIsIndex = typeof nextKey === 'number';

        if (isLast) {
          cur[key as any] = value;
          return;
        }

        if (cur[key as any] === undefined) {
          cur[key as any] = nextIsIndex ? [] : {};
        }
        cur = cur[key as any];
      }
    };

    const parsePath = (k: string): (string | number)[] => {
      // products[0][name] -> ["products", 0, "name"]
      const parts = k.split(/\[|\]/).filter(Boolean);
      return parts.map((p) => (/^\d+$/.test(p) ? Number(p) : p));
    };

    for (const [k, v] of Object.entries(flat || {})) {
      if (!k.includes('[')) {
        out[k] = v;
        continue;
      }
      setDeep(out, parsePath(k), v);
    }

    return out;
  }

  /**
   * Собираем ссылку на оплату (do=link) + подпись.
   * Важно: в URL кладём плоские параметры, но signature считаем по "вложенному" объекту.
   */
  buildPaymentLink(params: {
    orderId: string; // ваш order_num (например payments.id)
    customerPhone?: string;
    customerEmail?: string;
    customerExtra?: string;
    subscriptionId?: string;
    productName: string;
    productPrice: number; // "2000"
    quantity?: number;
  }): string {
    const base = this.getBaseFormUrl();

    const dataForSign: AnyObj = {
      sys: this.sys,
      order_num: params.orderId,
      callbackType: 'json',
      do: 'link',

      ...(params.customerPhone ? { customer_phone: params.customerPhone } : {}),
      ...(params.customerEmail ? { customer_email: params.customerEmail } : {}),
      ...(params.customerExtra ? { customer_extra: params.customerExtra } : {}),
      ...(params.subscriptionId ? { subscription: params.subscriptionId } : {}),

      products: [
        {
          name: params.productName,
          price: String(params.productPrice),
          quantity: String(params.quantity ?? 1),
        },
      ],
    };

    const signature = this.sign(dataForSign);

    // В URL кладём "плоско", как принимает Payform
    const q = new URLSearchParams();
    q.set('sys', this.sys);
    //q.set('order_id', params.orderId);
    q.set('order_num', params.orderId);
    q.set('callbackType', 'json');
    q.set('do', 'link');

    if (params.customerPhone) q.set('customer_phone', params.customerPhone);
    if (params.customerEmail) q.set('customer_email', params.customerEmail);
    if (params.customerExtra) q.set('customer_extra', params.customerExtra);
    if (params.subscriptionId) q.set('subscription', params.subscriptionId);

    q.set('products[0][name]', params.productName);
    q.set('products[0][price]', String(params.productPrice));
    q.set('products[0][quantity]', String(params.quantity ?? 1));

    q.set('signature', signature);

    return `${base}?${q.toString()}`;
  }

  async resolvePaymentLink(payformUrl: string): Promise<string> {
    const res = await fetch(payformUrl, {
      method: 'GET',
      redirect: 'follow',
    });
    const text = await res.text().catch(() => '');
    const trimmed = (text || '').trim();

    if (!res.ok) {
      const errMsg =
        trimmed.length > 200 ? trimmed.slice(0, 200) + '…' : trimmed;
      throw new Error(
        `Prodamus link failed: ${res.status} ${res.statusText}. ${errMsg}`,
      );
    }

    if (/^https?:\/\//i.test(trimmed)) return trimmed;

    const m = trimmed.match(/https?:\/\/\S+/i);
    if (m?.[0]) return m[0];

    try {
      const json = JSON.parse(trimmed) as Record<string, unknown>;
      const link =
        (json?.link as string) ||
        (json?.url as string) ||
        (json?.payment_url as string) ||
        (json?.redirect_url as string);
      if (link && /^https?:\/\//i.test(String(link))) return String(link);
      if (json?.error || json?.message) {
        throw new Error(
          String(json.error || json.message || 'Unknown Prodamus error'),
        );
      }
    } catch (e) {
      if (e instanceof SyntaxError) {
        // не JSON — продолжаем
      } else {
        throw e;
      }
    }

    if (res.url && res.url !== payformUrl) return res.url;

    throw new Error(
      'Prodamus не вернул ссылку на оплату. Ответ: ' +
        (trimmed.length > 100 ? trimmed.slice(0, 100) + '…' : trimmed),
    );
  }

  async setSubscriptionActivity(params: {
    subscriptionId: string;
    customerEmail?: string;
    customerPhone?: string;
    activeUser?: boolean;
    activeManager?: boolean;
  }): Promise<{ ok: boolean; status: number; body: string }> {
    this.assertConfig();

    const data: AnyObj = {
      subscription: params.subscriptionId,
      ...(params.customerEmail ? { customer_email: params.customerEmail } : {}),
      ...(params.customerPhone ? { customer_phone: params.customerPhone } : {}),
      ...(typeof params.activeUser === 'boolean'
        ? { active_user: params.activeUser ? 1 : 0 }
        : {}),
      ...(typeof params.activeManager === 'boolean'
        ? { active_manager: params.activeManager ? 1 : 0 }
        : {}),
    };

    const signature = this.sign(data);
    const body = new URLSearchParams({
      ...Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, String(v)]),
      ),
      signature,
    });

    const url = this.getRestUrl('setActivity');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const text = await res.text();
    const ok = res.ok && /success/i.test(text);

    return { ok, status: res.status, body: text };
  }
}
