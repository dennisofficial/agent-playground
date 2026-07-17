import { EnvService } from '@core/config/env/env.service';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import type { DraftPayload, DraftStagedAnswer, ReviewComment } from '../../_shared/domain/composer-draft';
import { access, copyFile, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { DataSource, EntityManager, QueryFailedError, Repository } from 'typeorm';
import { JobLifecycleService } from '../driver/job-lifecycle.service';
import { decryptSecret, encryptSecret, loadSecretsKey } from '../onboarding/secret-cipher';
import { DB_CONNECTION } from '../persistence/database.module';
import { ComposerDraftAttachmentEntity, ComposerDraftEntity } from '../persistence/entities';
import {
  AttachmentCardItem,
  renderUploadedFilesXml,
} from '../prompt-kit/messages/first-turn-seeds';
import {
  ATTACHMENT_EXTS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MIME_BY_EXT,
  safeUploadName,
  type UploadedAttachment,
} from './attachment-upload';

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

export type DraftPayloadWire = {
  text: string;
  stagedAnswers: DraftStagedAnswerWire[];
  comments: ReviewComment[];
};

export type DraftAttachmentDto = {
  id: string;
  name: string;
  kind: 'image' | 'file';
  size: number;
};

function emptyPayload(): DraftPayload {
  return { text: '', stagedAnswers: [], comments: [] };
}

const PG_UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const pgCode =
    (err as QueryFailedError & { code?: unknown }).code ??
    (err as QueryFailedError & { driverError?: { code?: unknown } }).driverError?.code;
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

  private toAttachmentDto(row: ComposerDraftAttachmentEntity): DraftAttachmentDto {
    return { id: row.id, name: row.filename, kind: row.kind, size: row.size };
  }

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
      existing.updated_at = new Date();
      await repo.save(existing);
      return;
    }
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

  async addAttachment(
    orgId: string,
    jobId: string,
    userId: string,
    file: UploadedAttachment,
  ): Promise<DraftAttachmentDto> {
    const ext = extname(file.originalname).toLowerCase();
    if (!ATTACHMENT_EXTS.has(ext)) {
      throw new BadRequestException(`unsupported attachment type: ${ext || file.originalname}`);
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
      await manager.getRepository(ComposerDraftAttachmentEntity).delete({ id: attachmentId });
      await this.touchDraft(manager, orgId, jobId, userId);
    });

    const dir = this.lifecycle.draftUploadsDirHost(jobId, orgId, userId);
    await unlink(join(dir, row.stored_name)).catch((err: NodeJS.ErrnoException) => {
      if (err?.code !== 'ENOENT') throw err;
    });
  }

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
    const uploadsDir = join(this.lifecycle.contextDirHost(jobId, orgId), 'uploads');
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
      await this.attachments.delete({ id: row.id });
    }
    return { xml: renderUploadedFilesXml(items), items };
  }

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
      stagedAnswers: row.payload.stagedAnswers.filter((a) => !applied.has(a.cardId)),
      comments: opts.clearComments ? [] : row.payload.comments,
    };
    await this.drafts.save(row);
  }
}
