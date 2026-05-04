import { IsString } from 'class-validator';

export class DeleteTemplateDto {
  @IsString()
  templateId: string;
}
