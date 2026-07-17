import { Injectable } from '@nestjs/common';
import type { OrgUsage } from '@workspace/shared';
import { Subject, type Observable } from 'rxjs';

export type UsageChange = {
  orgId: string;
  usage: OrgUsage;
};

@Injectable()
export class UsageEventBus {
  private readonly subject = new Subject<UsageChange>();

  publish(event: UsageChange): void {
    this.subject.next(event);
  }

  get stream$(): Observable<UsageChange> {
    return this.subject.asObservable();
  }
}
