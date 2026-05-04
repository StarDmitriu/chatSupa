//backend/src/supabase/supabase.service.ts
import { Injectable } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

@Injectable()
export class SupabaseService {
  private client: SupabaseClient;

  constructor() {
    const url = process.env.SUPABASE_URL;
    // ✅ ВАЖНО: service role для бэкенда (обходит RLS)
    const key =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_KEY || // fallback если ты пока не добавил новую переменную
      '';

    if (!url || !key) {
      throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing');
    }

    this.client = createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }

  getClient() {
    return this.client;
  }

  // helper для users
  async findUserByPhone(phone: string) {
    const { data, error } = await this.client
      .from('users')
      .select('*')
      .eq('phone', phone)
      .limit(1);

    if (error) throw error;
    return data?.[0] ?? null;
  }

  async createUser(phone: string) {
    const { data, error } = await this.client
      .from('users')
      .insert({ phone })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async updateLastLogin(phone: string) {
    const { data, error } = await this.client
      .from('users')
      .update({ last_login: new Date().toISOString() })
      .eq('phone', phone)
      .select()
      .single();

    if (error) throw error;
    return data;
  }
}
