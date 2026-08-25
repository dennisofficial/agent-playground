import { Injectable, Logger } from "@nestjs/common";
import { AccountVaultService } from "../auth/account-vault.service.js";
import { EngineHomeService } from "../auth/engine-home.service.js";
import {
  cleanTitle,
  sanitiseModelTitle,
  TITLE_MODEL,
  TITLE_SYSTEM,
  titlePrompt,
} from "../domain/job-title.js";
import { ClaudeOneShotService } from "../engine/one-shot.service.js";
import { JobRepository } from "../store/job.repository.js";

/**
 * What a job is called, after it exists.
 *
 * Two writers, one rule between them: the human's rename is final, and the model's title only ever
 * replaces the line the job was derived from. That rule lives in `JobRepository.retitle`'s `where`
 * clause, because naming runs beside the job's first turn and the two genuinely race.
 *
 * It is also the store the title is READ from while a page is up. Without it the header you are
 * looking at when the titler lands keeps the derived line until you leave the job and come back —
 * the rename is invisible in the one place you are certainly watching. Same `useSyncExternalStore`
 * shape as the running-threads snapshot: subscribe, read, no context cascade.
 */
@Injectable()
export class JobTitleService {
  private readonly logger = new Logger(JobTitleService.name);

  /** Only jobs whose title has MOVED this session. A miss means the row on hand is still right. */
  private readonly titles = new Map<string, string>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly jobRepository: JobRepository,
    private readonly accountVaultService: AccountVaultService,
    private readonly engineHomeService: EngineHomeService,
    private readonly claudeOneShotService: ClaudeOneShotService,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** `undefined` when this job has not been renamed since the caller read its row. */
  titleOf = (jobId: string): string | undefined => this.titles.get(jobId);

  /**
   * The human renamed it. Returns the title as stored, which is not always what was typed — see
   * `cleanTitle` — so the field the rename was typed into can show what actually landed.
   */
  async rename(args: { jobId: string; title: string }): Promise<string> {
    const title = cleanTitle(args.title);
    // Refused rather than accepted-as-empty: a nameless row draws as a blank line in every list,
    // and the job would then be findable only by the shape of the gap it leaves.
    if (!title) throw new Error("a job needs a name");
    await this.jobRepository.setTitle({ jobId: args.jobId, title });
    this.publish(args.jobId, title);
    return title;
  }

  /**
   * Name the job after its first message, in the background.
   *
   * Fire-and-forget by design, and the signature says so by returning nothing: the job already has
   * a usable name before this is called, so there is no state where anyone waits on it. It runs on
   * the account the job's own first turn runs on — same credential, same rotation, and a title is
   * billed where the work is.
   */
  name(args: {
    jobId: string;
    accountId: string;
    cwd: string;
    firstMessage: string;
    /** The derived title the job is wearing. The model's replaces this one, or nothing. */
    derived: string;
  }): void {
    void this.generate(args).catch((error: unknown) => {
      // A job keeps the name it already has. Nothing else in the app changes.
      this.logger.warn(`could not name job ${args.jobId}: ${String(error)}`);
    });
  }

  private async generate(args: {
    jobId: string;
    accountId: string;
    cwd: string;
    firstMessage: string;
    derived: string;
  }): Promise<void> {
    const blob = await this.accountVaultService.freshCredential(args.accountId);
    // Through the same gate a turn goes through: the credentials file is shared, so the write and
    // the spawn that reads it have to be one critical section. `ask` is synchronous up to the spawn
    // precisely so this holds.
    const raw = await this.engineHomeService.claim(
      { accountId: args.accountId, blob },
      (env) =>
        this.claudeOneShotService.ask({
          prompt: titlePrompt(args.firstMessage),
          systemPrompt: TITLE_SYSTEM,
          model: TITLE_MODEL,
          cwd: args.cwd,
          env,
        }),
    );
    if (raw === undefined) return;

    const title = sanitiseModelTitle(raw);
    if (!title || title === args.derived) return;

    const applied = await this.jobRepository.retitle({
      jobId: args.jobId,
      title,
      ifTitle: args.derived,
    });
    // Not applied means renamed by hand while the model was thinking, or the job is already gone.
    // Publishing anyway would put a title on screen that the database does not hold.
    if (applied) this.publish(args.jobId, title);
  }

  private publish(jobId: string, title: string): void {
    this.titles.set(jobId, title);
    for (const listener of this.listeners) listener();
  }
}
