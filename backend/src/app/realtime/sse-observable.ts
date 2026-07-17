import type { MessageEvent } from '@nestjs/common';
import type { SubscriptionImpl } from '@workspace/pg-realtime';
import { Observable } from 'rxjs';

export function subscriptionToObservable(sub: SubscriptionImpl): Observable<MessageEvent> {
  return new Observable<MessageEvent>((subscriber) => {
    sub.on((delta) => subscriber.next({ data: delta }));
    return () => sub.close();
  });
}

export function realtimeDisabledStream(): Observable<MessageEvent> {
  return new Observable<MessageEvent>((subscriber) => {
    subscriber.next({ data: { kind: 'disabled' } });
  });
}
