import { useEffect, useState } from "react";
import { serviceJobIds } from "../../domain/services.js";
import { useServices } from "../services.js";

/**
 * How often the job list re-reads the registry. Services change a handful of times a day, so this is
 * about how stale the mark may be rather than about smoothness — a second is under the threshold at
 * which "I started a dev server and the list did not notice" reads as a bug.
 */
const POLL_MS = 1000;

/**
 * Which jobs are holding a running service.
 *
 * A POLL, not a subscription, and deliberately: `ServiceRegistryService` has no notify machinery,
 * and adding one would mean an emitter, a listener contract and a `useSyncExternalStore` snapshot
 * for a signal that moves when a human types `service_start`. The cost of the timer is one map over
 * a handful of entries; the cost of the emitter is a lifetime of keeping it correct.
 *
 * The stable-identity rule that makes the timer harmless lives in `serviceJobIds`, where it is pure
 * and tested — without it this repaints the whole list every second.
 */
export function useServiceJobIds(): ReadonlySet<string> {
  const { serviceRegistryService } = useServices();
  const [jobIds, setJobIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  useEffect(() => {
    const read = (): void =>
      setJobIds((previous) =>
        serviceJobIds({
          previous,
          entries: serviceRegistryService.allServices(),
        }),
      );
    // Once immediately: a page mounted after the services were started would otherwise show an
    // unmarked list for the first second, which reads as "there are none".
    read();
    const timer = setInterval(read, POLL_MS);
    return () => clearInterval(timer);
  }, [serviceRegistryService]);

  return jobIds;
}
