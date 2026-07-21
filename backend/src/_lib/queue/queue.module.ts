import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { BullmqConfig } from './bullmq.config';

@Module({
  imports: [BullModule.forRootAsync({ useClass: BullmqConfig })],
})
export class QueueModule {}
