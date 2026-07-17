import { extname, basename, join } from 'node:path';
import {
  access,
  copyFile,
  mkdir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { EnvService } from '@core/config/env/env.service';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  ComposerDraftAttachmentEntity,
  ComposerDraftEntity,
} from '../persistence/entities';
import type {
  DraftPayload,
  DraftStagedAnswer,
  ReviewComment,
} from '@shared/domain/composer-draft';
import {
  decryptSecret,
  encryptSecret,
  loadSecretsKey,
} from '../onboarding/secret-cipher';
import { JobLifecycleService } from '../driver/job-lifecycle.service';
import {
  ATTACHMENT_EXTS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MIME_BY_EXT,
  safeUploadName,
  type UploadedAttachment,
} from './attachment-upload';
import {
  AttachmentCardItem,
  renderUploadedFilesXml,
} from '../prompt-kit/messages/first-turn-seeds';

/**
 * The wire (cleartext) counterpart of `DraftStagedAnswer` — the shape returned by GET and accepted by PUT.
 * The `secret` variant carries a cleartext `value`; `ComposerDraftService` is the ONLY place that crosses
 * the encrypt (`putDraft`) / decrypt (`getDraft`) boundary, so a staged secret's plaintext never rides
 * anywhere else — not the entity, not the realtime WAL row (see `DraftRealtimeRow`).
 */
export type DraftStagedAnswerWire =
  | { kind: 'question'; cardId: string; label: string; answer: string }
  | {
      kind: 'file';
      cardId: string;
      label: string;
      filename: string;
      content: string;
    }
  | { kind: 'secret'; cardId: string; label: string; value: string };

/** The draft payload as exposed to / accepted from the owner's own device. */
export type DraftPayloadWire = {
  text: string;
  stagedAnswers: DraftStagedAnswerWire[];
  comments: ReviewComment[];
};

/** One draft attachment as exposed to the client — never the `stored_name` (the on-disk name). */
export type DraftAttachmentDto = {
  id: string;
  name: string;
  kind: 'image' | 'file';
  size: number;
};

function emptyPayload(): DraftPayload {
  return { text: '', stagedAnswers: [], comments: [] };
}

/** Postgres unique-violation SQLSTATE — the `(job_id, user_id)` index a racing first-write can hit. */
const PG_UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const pgCode =
    (err as QueryFailedError & { code?: unknown }).code ??
    (err as QueryFailedError & { driverError?: { code?: unknown } }).driverError
      ?.code;
  return pgCode === PG_UNIQUE_VIOLATION;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Server-side owner of the composer draft — the operator's in-progress message (text, staged
 * question/file/secret answers, queued review comments) and its uploaded-on-add attachments, held
 * per-`(job_id, user_id)` so it survives a tab close or device switch. See `ComposerDraftEntity` +
 * `ComposerDraftAttachmentEntity`.
 *
 * Attachment mutations (`addAttachment`/`deleteAttachment`) touch ONLY `composer_draft_attachments`, but
 * the realtime fan-out (`DRAFTS_MODEL`) watches `composer_drafts` only — so both methods also bump the
 * parent draft row's `updated_at` in the SAME transaction as the attachment write, or the other device
 * would never learn the attachment list changed.
 */
@Injectable()
export class ComposerDraftService {
  constructor(
    @InjectRepository(ComposerDraftEntity, DB_CONNECTION)
    private readonly drafts: Repository<ComposerDraftEntity>,
    @InjectRepository(ComposerDraftAttachmentEntity, DB_CONNECTION)
    private readonly attachments: Repository<ComposerDraftAttachmentEntity>,
    @InjectDataSource(DB_CONNECTION)
    private readonly dataSource: DataSource,
    private readonly env: EnvService,
    private readonly lifecycle: JobLifecycleService,
  ) {}

  private key(): Buffer {
    return loadSecretsKey(this.env.get('SECRETS_ENCRYPTION_KEY'));
  }

  private toWireAnswer(a: DraftStagedAnswer): DraftStagedAnswerWire {
    if (a.kind !== 'secret') return a;
    return {
      kind: 'secret',
      cardId: a.cardId,
      label: a.label,
      value: decryptSecret(a.valueEnc, this.key()),
    };
  }

  private toStoredAnswer(a: DraftStagedAnswerWire): DraftStagedAnswer {
    if (a.kind !== 'secret') return a;
    return {
      kind: 'secret',
      cardId: a.cardId,
      label: a.label,
      valueEnc: encryptSecret(a.value, this.key()),
    };
  }

  private toAttachmentDto(
    row: ComposerDraftAttachmentEntity,
  ): DraftAttachmentDto {
    return { id: row.id, name: row.filename, kind: row.kind, size: row.size };
  }

  /** The caller's draft, or an empty one when none exists yet — never creates a row on a bare read. */
  async getDraft(
    orgId: string,
    jobId: string,
    userId: string,
  ): Promise<{
    payload: DraftPayloadWire;
    attachments: DraftAttachmentDto[];
    updatedAt: string | null;
  }> {
    const [row, attachmentRows] = await Promise.all([
      this.drafts.findOne({
        where: { org_id: orgId, job_id: jobId, user_id: userId },
      }),
      this.attachments.find({
        where: { org_id: orgId, job_id: jobId, user_id: userId },
        order: { created_at: 'ASC' },
      }),
    ]);
    const payload = row?.payload ?? emptyPayload();
    return {
      payload: {
        text: payload.text,
        stagedAnswers: payload.stagedAnswers.map((a) => this.toWireAnswer(a)),
        comments: payload.comments,
      },
      attachments: attachmentRows.map((r) => this.toAttachmentDto(r)),
      updatedAt: row?.updated_at?.toISOString() ?? null,
    };
  }

  /** Upsert the caller's draft by `(job_id, user_id)`, encrypting each staged `secret` value at rest. */
  async putDraft(
    orgId: string,
    jobId: string,
    userId: string,
    wire: DraftPayloadWire,
  ): Promise<void> {
    const payload: DraftPayload = {
      text: wire.text,
      stagedAnswers: wire.stagedAnswers.map((a) => this.toStoredAnswer(a)),
      comments: wire.comments,
    };
    const existing = await this.drafts.findOne({
      where: { org_id: orgId, job_id: jobId, user_id: userId },
    });
    if (existing) {
      existing.payload = payload;
      await this.drafts.save(existing);
      return;
    }
    // No row yet for this (job, user) — but this is the multi-device-sync feature's whole premise, so a
    // concurrent first write (another device's autosave, or an attachment `touchDraft`) can win the insert
    // race on the `(job_id, user_id)` unique index between the `findOne` above and this `save`. Retry as an
    // update on that race instead of surfacing an unhandled 500.
    try {
      await this.drafts.save(
        this.drafts.create({
          org_id: orgId,
          job_id: jobId,
          user_id: userId,
          payload,
        }),
      );
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const row = await this.drafts.findOneOrFail({
        where: { org_id: orgId, job_id: jobId, user_id: userId },
      });
      row.payload = payload;
      await this.drafts.save(row);
    }
  }

  /** Ensure a draft row exists for `(job_id, user_id)` and bump its `updated_at` — fires the realtime
   *  delta for an attachment-only change (see the class doc comment). Must run on a transaction manager. */
  private async touchDraft(
    manager: EntityManager,
    orgId: string,
    jobId: string,
    userId: string,
  ): Promise<void> {
    const repo = manager.getRepository(ComposerDraftEntity);
    const existing = await repo.findOne({
      where: { org_id: orgId, job_id: jobId, user_id: userId },
    });
    if (existing) {
      // TypeORM diffs the loaded entity against the values being saved and skips issuing the UPDATE
      // (and the `@UpdateDateColumn` bump) entirely when nothing differs — so re-saving `existing`
      // unchanged is a silent no-op and never produces the WAL row the other device is waiting on.
      // Mutating `updated_at` first forces TypeORM to see a real diff and actually emit the UPDATE.
      existing.updated_at = new Date();
      await repo.save(existing);
      return;
    }
    // Same insert-race as `putDraft` — retry as a touch-only save on a unique-violation instead of
    // surfacing a 500.
    try {
      await repo.save(
        repo.create({
          org_id: orgId,
          job_id: jobId,
          user_id: userId,
          payload: emptyPayload(),
        }),
      );
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const row = await repo.findOneOrFail({
        where: { org_id: orgId, job_id: jobId, user_id: userId },
      });
      row.updated_at = new Date();
      await repo.save(row);
    }
  }

  /** Stage an uploaded-on-add draft attachment: validate, write the byte to the (unmounted)
   *  draft-uploads dir, and record the row — touching the parent draft row in the same transaction. */
  async addAttachment(
    orgId: string,
    jobId: string,
    userId: string,
    file: UploadedAttachment,
  ): Promise<DraftAttachmentDto> {
    const ext = extname(file.originalname).toLowerCase();
    if (!ATTACHMENT_EXTS.has(ext)) {
      throw new BadRequestException(
        `unsupported attachment type: ${ext || file.originalname}`,
      );
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw new PayloadTooLargeException(
        `attachment too large (${file.size} bytes; limit ${MAX_ATTACHMENT_BYTES})`,
      );
    }
    const existingCount = await this.attachments.count({
      where: { org_id: orgId, job_id: jobId, user_id: userId },
    });
    if (existingCount >= MAX_ATTACHMENTS) {
      throw new BadRequestException(`at most ${MAX_ATTACHMENTS} attachments`);
    }

    const safeName = safeUploadName(file.originalname);
    const dir = this.lifecycle.draftUploadsDirHost(jobId, orgId, userId);
    await mkdir(dir, { recursive: true });
    const stagedPath = join(dir, safeName);
    await writeFile(stagedPath, file.buffer);

    const mime = MIME_BY_EXT[ext]?.mime ?? '';
    const kind: 'image' | 'file' = mime.startsWith('image/') ? 'image' : 'file';
    const filename = basename(file.originalname).slice(0, 100) || safeName;

    const saved = await this.dataSource
      .transaction(async (manager) => {
        const repo = manager.getRepository(ComposerDraftAttachmentEntity);
        const row = await repo.save(
          repo.create({
            org_id: orgId,
            job_id: jobId,
            user_id: userId,
            filename,
            stored_name: safeName,
            kind,
            size: file.size,
          }),
        );
        await this.touchDraft(manager, orgId, jobId, userId);
        return row;
      })
      .catch(async (err) => {
        await unlink(stagedPath).catch(() => undefined);
        throw err;
      });
    return this.toAttachmentDto(saved);
  }

  /** Remove a staged draft attachment (owner-scoped) — best-effort byte cleanup, and the same
   *  load-bearing touch of the parent draft row. */
  async deleteAttachment(
    orgId: string,
    jobId: string,
    userId: string,
    attachmentId: string,
  ): Promise<void> {
    const row = await this.attachments.findOne({
      where: {
        id: attachmentId,
        org_id: orgId,
        job_id: jobId,
        user_id: userId,
      },
    });
    if (!row) throw new NotFoundException('attachment not found');

    await this.dataSource.transaction(async (manager) => {
      await manager
        .getRepository(ComposerDraftAttachmentEntity)
        .delete({ id: attachmentId });
      await this.touchDraft(manager, orgId, jobId, userId);
    });

    const dir = this.lifecycle.draftUploadsDirHost(jobId, orgId, userId);
    await unlink(join(dir, row.stored_name)).catch(
      (err: NodeJS.ErrnoException) => {
        if (err?.code !== 'ENOENT') throw err;
      },
    );
  }

  /**
   * Send-time counterpart of `WebSurfaceController.ingestAttachments`: move every staged draft attachment
   * from the (unmounted) draft-uploads dir into the job's `/context/uploads/`, and delete the draft rows.
   * Returns null when the caller has no staged attachments.
   */
  async promoteOnSend(
    orgId: string,
    jobId: string,
    userId: string,
  ): Promise<{ xml: string; items: AttachmentCardItem[] } | null> {
    const rows = await this.attachments.find({
      where: { org_id: orgId, job_id: jobId, user_id: userId },
      order: { created_at: 'ASC' },
    });
    if (rows.length === 0) return null;

    const draftDir = this.lifecycle.draftUploadsDirHost(jobId, orgId, userId);
    const uploadsDir = join(
      this.lifecycle.contextDirHost(jobId, orgId),
      'uploads',
    );
    await mkdir(uploadsDir, { recursive: true });

    const items: AttachmentCardItem[] = [];
    for (const row of rows) {
      const from = join(draftDir, row.stored_name);
      const to = join(uploadsDir, row.stored_name);
      try {
        await rename(from, to);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'EXDEV') {
          await copyFile(from, to);
          await unlink(from);
        } else if (code === 'ENOENT' && (await pathExists(to))) {
          // Already moved by an earlier, partially-failed call (e.g. this row's move succeeded but a
          // LATER row in that loop threw before the row-delete below ran, so a retry re-finds this row
          // still in the DB) — the destination file is already there, so treat this row as promoted and
          // fall through to deleting its now-stale record instead of re-throwing on the vanished source.
        } else {
          throw err;
        }
      }
      items.push({
        name: row.filename,
        path: `uploads/${row.stored_name}`,
        kind: row.kind,
        size: row.size,
      });
      // Delete THIS row right after ITS file lands in `uploadsDir`, not once in bulk after the whole loop:
      // (1) makes a mid-loop failure on a later row resumable on retry instead of permanently ENOENT-ing on
      // the already-moved rows, and (2) scopes the delete to exactly the rows this call processed, so a
      // concurrent `addAttachment` on another device (a new row appearing after the `find` above) is never
      // swept up by a broader (org,job,user) delete despite its file never having been moved.
      await this.attachments.delete({ id: row.id });
    }
    return { xml: renderUploadedFilesXml(items), items };
  }

  /**
   * Clear the caller's draft after a send: drop the staged answers that were just applied (by `cardId`,
   * keeping any that are stale/rejected), and — only for the fields this particular submit actually
   * carried — blank the text and/or the queued comments. `opts` is caller-driven because `/message` can
   * fire with no `user` text (a bare card answer) and never carries `comments` at all (those ride
   * `/review-comments` instead), so blanket-clearing both here would wipe an operator's in-progress,
   * unrelated draft. Always an UPDATE, never a DELETE (see `ComposerDraftEntity`'s doc comment) — a no-op
   * when the caller has no draft row.
   */
  async clearOnSend(
    orgId: string,
    jobId: string,
    userId: string,
    appliedCardIds: string[],
    opts: { clearText: boolean; clearComments: boolean },
  ): Promise<void> {
    const row = await this.drafts.findOne({
      where: { org_id: orgId, job_id: jobId, user_id: userId },
    });
    if (!row) return;
    const applied = new Set(appliedCardIds);
    row.payload = {
      text: opts.clearText ? '' : row.payload.text,
      stagedAnswers: row.payload.stagedAnswers.filter(
        (a) => !applied.has(a.cardId),
      ),
      comments: opts.clearComments ? [] : row.payload.comments,
    };
    await this.drafts.save(row);
  }
}
