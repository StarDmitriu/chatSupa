//backend/src/admin/admin.guard.ts
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly supabaseService: SupabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const userId = req?.user?.userId;

    if (!userId) throw new ForbiddenException('no_user');

    const supabase = this.supabaseService.getClient();
    const { data: user, error } = await supabase
      .from('users')
      .select('id,is_admin,is_blocked')
      .eq('id', userId)
      .maybeSingle();

    if (error) throw new ForbiddenException('admin_check_failed');
    if (!user) throw new ForbiddenException('user_not_found');
    if (user.is_blocked) throw new ForbiddenException('blocked');
    if (!user.is_admin) throw new ForbiddenException('not_admin');

    return true;
  }
}
