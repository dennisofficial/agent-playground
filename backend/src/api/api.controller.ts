import { Controller, Get } from '@nestjs/common';
import { Public } from '@workspace/auth/server';
import { ApiService } from './api.service';

@Controller()
export class ApiController {
  constructor(private readonly apiService: ApiService) {}

  /** Health-check / smoke-test endpoint — publicly accessible (no auth required). */
  @Public()
  @Get()
  getHello(): string {
    return this.apiService.getHello();
  }
}
