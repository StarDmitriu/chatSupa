import { classifyDeliveryError } from './delivery-error-classifier';

describe('classifyDeliveryError', () => {
  it('classifies TG permission errors as permanent with auto-unselect', () => {
    const r = classifyDeliveryError(
      'tg',
      '403: CHAT_WRITE_FORBIDDEN (caused by messages.SendMessage)',
    );
    expect(r.kind).toBe('permanent');
    expect(r.normalizedCode).toBe('CHAT_WRITE_FORBIDDEN');
    expect(r.shouldAutoUnselectTarget).toBe(true);
  });

  it('classifies TG flood wait as transient', () => {
    const r = classifyDeliveryError('tg', 'A wait of 37 seconds is required');
    expect(r.kind).toBe('transient');
    expect(r.normalizedCode).toBe('TG_FLOOD_WAIT');
    expect(r.shouldAutoUnselectTarget).toBe(false);
  });

  it('classifies WA connectivity retry marker as transient', () => {
    const r = classifyDeliveryError('wa', 'wa_connect_retry_2');
    expect(r.kind).toBe('transient');
    expect(r.normalizedCode).toBe('WA_CONNECT_RETRY');
  });

  it('returns unknown for non-mapped errors', () => {
    const r = classifyDeliveryError('wa', 'unexpected custom error');
    expect(r.kind).toBe('unknown');
    expect(r.normalizedCode).toBe('UNKNOWN');
  });
});

