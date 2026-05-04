import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { SmsService } from '../sms/sms.service';

describe('AuthService', () => {
  let service: AuthService;

  const mockSmsService = {
    send: jest.fn(),
  };

  beforeEach(async () => {
    process.env.SUPABASE_URL =
      process.env.SUPABASE_URL || 'https://test.supabase.co';
    process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-anon-key';
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: SmsService, useValue: mockSmsService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
