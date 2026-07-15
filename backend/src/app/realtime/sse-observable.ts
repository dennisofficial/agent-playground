import type { MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';
import type { SubscriptionImpl } from '@workspace/pg-realtime';

/**
 * Adapt a pg-realtime subscription to a Nest SSE stream. Attaching the handler (`on`) lazily kicks the
 * snapshot, so the first frame the client receives is the `{ kind: 'data' }` snapshot, followed by live
 * `add`/`update`/`remove` deltas. Each `RowDelta` is wrapped as an SSE `MessageEvent`; the subscription
 * is closed when the client disconnects (Observable teardown).
 *
 * Re-implements cubix's trimmed `sseObservable` locally (the vendored package ships core only).
 */
export function subscriptionToObservable(
  sub: SubscriptionImpl,
): Observable<MessageEvent> {
  return new Observable<MessageEvent>((subscriber) => {
    sub.on((delta) => subscriber.next({ data: delta }));
    return () => sub.close();
  });
}

/**
 * The stream returned when realtime is unavailable (engine off / failed to start). It emits ONE
 * `{ kind: 'disabled' }` control frame and then stays open without completing or erroring. This is
 * deliberate: a 503 (or a completing/erroring stream) makes `EventSource` reconnect in a tight loop —
 * here the client sees `disabled`, closes the stream, and falls back to its normal polling refetch.
 */
export function realtimeDisabledStream(): Observable<MessageEvent> {
  return new Observable<MessageEvent>((subscriber) => {
    subscriber.next({ data: { kind: 'disabled' } });
    // No complete()/error() — the client closes on the `disabled` frame; teardown is a no-op.
  });
}
