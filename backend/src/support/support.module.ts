import { Module } from '@nestjs/common';
import { SupportTicketService } from './support-ticket.service';

@Module({
  providers: [SupportTicketService],
  exports: [SupportTicketService],
})
export class SupportModule {}
