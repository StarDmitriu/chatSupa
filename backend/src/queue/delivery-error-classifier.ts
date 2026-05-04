export type DeliveryErrorKind = 'transient' | 'permanent' | 'unknown';

export type DeliveryClassifiedError = {
  kind: DeliveryErrorKind;
  normalizedCode: string;
  shouldAutoUnselectTarget: boolean;
};

const TG_PERMANENT_PATTERNS: Array<{ re: RegExp; code: string }> = [
  { re: /\bCHAT_WRITE_FORBIDDEN\b/i, code: 'CHAT_WRITE_FORBIDDEN' },
  { re: /\bUSER_BANNED_IN_CHANNEL\b/i, code: 'USER_BANNED_IN_CHANNEL' },
  { re: /\bCHAT_ADMIN_REQUIRED\b/i, code: 'CHAT_ADMIN_REQUIRED' },
  { re: /\bPEER_ID_INVALID\b/i, code: 'PEER_ID_INVALID' },
  { re: /\bCHANNEL_INVALID\b/i, code: 'CHANNEL_INVALID' },
  { re: /\bCHANNEL_PRIVATE\b/i, code: 'CHANNEL_PRIVATE' },
];

const TG_TRANSIENT_PATTERNS: Array<{ re: RegExp; code: string }> = [
  { re: /A wait of \d+ seconds is required/i, code: 'TG_FLOOD_WAIT' },
  { re: /^telegram_not_connected$/i, code: 'TG_NOT_CONNECTED' },
  { re: /^send_timeout$/i, code: 'SEND_TIMEOUT' },
  { re: /^tg_connect_retry_\d+$/i, code: 'TG_CONNECT_RETRY' },
  { re: /^tg_flood_wait_\d+s$/i, code: 'TG_FLOOD_WAIT' },
  { re: /\bTIMEOUT\b/i, code: 'TIMEOUT' },
];

const WA_TRANSIENT_PATTERNS: Array<{ re: RegExp; code: string }> = [
  { re: /^whatsapp_not_connected$/i, code: 'WA_NOT_CONNECTED' },
  { re: /^wa_not_connected$/i, code: 'WA_NOT_CONNECTED' },
  { re: /^send_timeout$/i, code: 'SEND_TIMEOUT' },
  { re: /^wa_connect_retry_\d+$/i, code: 'WA_CONNECT_RETRY' },
  { re: /media upload failed on all hosts/i, code: 'WA_MEDIA_UPLOAD_TRANSIENT' },
  { re: /\bETIMEDOUT\b/i, code: 'ETIMEDOUT' },
  { re: /\bECONNRESET\b/i, code: 'ECONNRESET' },
  { re: /\bEAI_AGAIN\b/i, code: 'EAI_AGAIN' },
];

function classifyByPatterns(
  text: string,
  patterns: Array<{ re: RegExp; code: string }>,
): string | null {
  for (const p of patterns) {
    if (p.re.test(text)) return p.code;
  }
  return null;
}

export function classifyDeliveryError(
  channel: 'wa' | 'tg',
  rawError: string | null | undefined,
): DeliveryClassifiedError {
  const text = String(rawError || '').trim();
  if (!text) {
    return {
      kind: 'unknown',
      normalizedCode: 'UNKNOWN',
      shouldAutoUnselectTarget: false,
    };
  }

  if (channel === 'tg') {
    const permanent = classifyByPatterns(text, TG_PERMANENT_PATTERNS);
    if (permanent) {
      return {
        kind: 'permanent',
        normalizedCode: permanent,
        shouldAutoUnselectTarget: true,
      };
    }
    const transient = classifyByPatterns(text, TG_TRANSIENT_PATTERNS);
    if (transient) {
      return {
        kind: 'transient',
        normalizedCode: transient,
        shouldAutoUnselectTarget: false,
      };
    }
  } else {
    const transient = classifyByPatterns(text, WA_TRANSIENT_PATTERNS);
    if (transient) {
      return {
        kind: 'transient',
        normalizedCode: transient,
        shouldAutoUnselectTarget: false,
      };
    }
  }

  return {
    kind: 'unknown',
    normalizedCode: 'UNKNOWN',
    shouldAutoUnselectTarget: false,
  };
}

