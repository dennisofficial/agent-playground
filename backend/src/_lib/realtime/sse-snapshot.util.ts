import type { Subscription } from '@workspace/pg-realtime';
import type { SseMessageEvent } from '@workspace/pg-realtime/nest';
import { Observable } from 'rxjs';

export function sseSnapshotList<T>(
  openTriggers: Array<() => Promise<Subscription>>,
  load: () => Promise<T[]>,
  pk: (row: T) => string,
): Observable<SseMessageEvent> {
  return new Observable<SseMessageEvent>((subscriber) => {
    const subs: Subscription[] = [];
    let cancelled = false;
    let running = false;
    let pending = false;

    const emit = async (): Promise<void> => {
      if (running) {
        pending = true;
        return;
      }
      running = true;
      try {
        const rows = await load();
        if (!cancelled) {
          subscriber.next({ type: 'data', data: rows.map((row) => ({ pk: pk(row), row })) });
        }
      } catch (err) {
        if (!cancelled) subscriber.error(err);
      } finally {
        running = false;
        if (pending && !cancelled) {
          pending = false;
          void emit();
        }
      }
    };

    void (async () => {
      for (const open of openTriggers) {
        const sub = await open();
        if (cancelled) {
          sub.close();
          return;
        }
        subs.push(sub);
        // Any delta (including the initial `data` snapshot) triggers a reload of the joined query.
        sub.on(() => void emit());
      }
    })().catch((err) => {
      if (!cancelled) subscriber.error(err);
    });

    return () => {
      cancelled = true;
      for (const sub of subs) sub.close();
    };
  });
}
