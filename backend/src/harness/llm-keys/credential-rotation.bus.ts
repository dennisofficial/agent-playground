import { Injectable } from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';

/**
 * Credential-rotation events — emitted whenever a workspace's LLM credentials change in-process (the
 * rotate-keys modal submit, or a `fall_back_to_api_key` flip). Every cache keyed by a tenant's
 * credentials SUBSCRIBES and clears that team's entries, so the NEXT call rebuilds against the fresh
 * key: the decrypted-key cache, the memoized memory/extract chains, the embeddings client, the codex
 * SDK clients. WITHOUT this fan-out a rotated key silently no-ops behind a stale cached model.
 *
 * A tiny leaf provider with NO deps (the BoardEventsBus idiom) so emitters (slack-app, tools) and
 * subscribers (llm-keys, memory, engines) all depend on it without a module cycle. Provided @Global.
 *
 * SCOPE: in-process only. A rotation written via the admin REST (a SEPARATE process) doesn't reach
 * this bus — that path still relies on the 60s cred-cache TTL, same as before.
 */
@Injectable()
export class CredentialRotationBus {
  private readonly subject = new Subject<string>();

  /** Emits a `teamId` whenever its credentials rotated. */
  readonly rotated$: Observable<string> = this.subject.asObservable();

  /** Announce that `teamId`'s credentials changed — fans out to every keyed cache. */
  emit(teamId: string): void {
    this.subject.next(teamId);
  }
}
