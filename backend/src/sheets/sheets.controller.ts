import {
  Controller,
  ForbiddenException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SheetsService } from './sheets.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('sheets')
@UseGuards(JwtAuthGuard)
export class SheetsController {
  constructor(private readonly sheets: SheetsService) {}

  @Post('create')
  async create(@Req() req: { user?: { userId?: string } }) {
    const userId = req?.user?.userId;
    if (!userId) throw new ForbiddenException('no_user');
    return this.sheets.createForUser(userId);
  }
}
