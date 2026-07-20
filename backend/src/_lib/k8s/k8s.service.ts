import { EnvService } from '@core/config/env/env.service';
import {
  CoreV1Api,
  type CoreV1Event,
  Exec,
  KubeConfig,
  type V1Pod,
  type V1Status,
} from '@kubernetes/client-node';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Writable } from 'node:stream';
import { isK8sNotFoundError } from './k8s.utils';

/** How long `waitForPodReady` polls before giving up, and its poll interval. */
const READY_POLL_INTERVAL_MS = 1_000;

@Injectable()
export class K8sService implements OnModuleInit {
  private readonly logger = new Logger(K8sService.name);
  private core!: CoreV1Api;
  private exec!: Exec;

  constructor(private readonly envService: EnvService) {}

  onModuleInit(): void {
    const kc = new KubeConfig();
    try {
      kc.loadFromCluster();
      this.logger.log('Loaded in-cluster kubeconfig');
    } catch {
      kc.loadFromDefault();
      this.logger.log('Loaded kubeconfig from default (env KUBECONFIG or ~/.kube/config)');
    }
    this.core = kc.makeApiClient(CoreV1Api);
    this.exec = new Exec(kc);
  }

  async ensureNamespace(namespace: string): Promise<void> {
    try {
      await this.core.readNamespace({ name: namespace });
      return;
    } catch (err) {
      if (!isK8sNotFoundError(err)) throw err;
    }
    await this.core.createNamespace({ body: { metadata: { name: namespace } } });
    this.logger.log(`Created namespace ${namespace}`);
  }

  createPod(namespace: string, body: V1Pod): Promise<V1Pod> {
    return this.core.createNamespacedPod({ namespace, body });
  }

  async getPod(namespace: string, name: string): Promise<V1Pod | null> {
    try {
      return await this.core.readNamespacedPod({ namespace, name });
    } catch (err) {
      if (isK8sNotFoundError(err)) return null;
      throw err;
    }
  }

  async deletePod(namespace: string, name: string): Promise<void> {
    try {
      await this.core.deleteNamespacedPod({ namespace, name });
    } catch (err) {
      if (isK8sNotFoundError(err)) return;
      throw err;
    }
  }

  async listPodsByLabel(namespace: string, labelSelector: string): Promise<V1Pod[]> {
    const res = await this.core.listNamespacedPod({ namespace, labelSelector });
    return res.items;
  }

  async listPodEvents(namespace: string, podName: string): Promise<CoreV1Event[]> {
    const res = await this.core.listNamespacedEvent({
      namespace,
      fieldSelector: `involvedObject.name=${podName}`,
    });
    return res.items;
  }

  /**
   * Run a command in a container of a running pod. Resolves when the process reports Success, rejects
   * with the captured stderr otherwise. Detached launches should background inside the command itself
   * (e.g. `setsid ... &`) so the exec stream closes immediately.
   */
  async execInPod(
    namespace: string,
    pod: string,
    container: string,
    command: string[],
  ): Promise<void> {
    const errChunks: string[] = [];
    const stderr = new Writable({
      write(chunk, _enc, cb): void {
        errChunks.push(chunk.toString());
        cb();
      },
    });
    const stdout = new Writable({
      write(_chunk, _enc, cb): void {
        cb();
      },
    });

    await new Promise<void>((resolve, reject) => {
      this.exec
        .exec(
          namespace,
          pod,
          container,
          command,
          stdout,
          stderr,
          null,
          false,
          (status: V1Status) => {
            if (status.status === 'Success') resolve();
            else
              reject(
                new Error(
                  `exec in ${pod}/${container} failed: ${status.message ?? status.reason ?? status.status ?? 'unknown'} ${errChunks.join('')}`.trim(),
                ),
              );
          },
        )
        .catch(reject);
    });
  }

  /** Poll until the pod is Running with a true Ready condition, or throw on terminal phase / timeout. */
  async waitForPodReady(namespace: string, pod: string, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const p = await this.getPod(namespace, pod);
      if (p) {
        const phase = p.status?.phase;
        const ready = p.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True');
        if (phase === 'Running' && ready) return;
        if (phase === 'Failed' || phase === 'Succeeded') {
          throw new Error(`pod ${pod} reached terminal phase ${phase} before becoming Ready`);
        }
      }
      await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
    }
    throw new Error(`pod ${pod} did not become Ready within ${timeoutMs}ms`);
  }
}
