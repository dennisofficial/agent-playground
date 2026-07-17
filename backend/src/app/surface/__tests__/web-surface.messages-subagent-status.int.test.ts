import type { ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrgMembershipGuard } from '../../org/org-membership.guard';
import { DB_CONNECTION } from '../../persistence/database.module';
import { JobEntity, SubagentEntity, TranscriptMessageEntity } from '../../persistence/entities';
import { WebSurfaceController } from '../web-surface.controller';

const ORG_ID = 'org-1';
const REPO_ID = 'repo-1';
const JOB_ID = 'thread-1';
const ANCHOR_ID = 'msg-anchor';
const ENDED_AT = new Date('2026-07-16T12:00:00.000Z');

let app: import('@nestjs/common').INestApplication;
let server: ReturnType<import('@nestjs/common').INestApplication['getHttpServer']>;
let subagentRows: Array<{
  parent_message_id: string;
  thread_id: string;
  status: string;
  ended_at: Date | null;
}> = [];

const anchorRow = {
  id: ANCHOR_ID,
  thread_id: JOB_ID,
  subagent_id: null,
  ts: 'a1',
  author: 'atlas',
  author_id: 'atlas',
  author_bot_id: 'bot',
  text: '',
  kind: 'tool',
  card: null,
  meta: {
    id: 'tu-bg',
    name: 'Task',
    input: { subagent_type: 'test' },
    result: 'agentId: s1 — use SendMessage', // the launch ack, NOT completion
  },
  created_at: new Date('2026-07-16T11:59:00.000Z'),
};
const childRow = {
  id: 'msg-child',
  thread_id: JOB_ID,
  subagent_id: 's1',
  ts: 'c1',
  author: 'atlas',
  author_id: 'atlas',
  author_bot_id: 'bot',
  text: 'working…',
  kind: 'text',
  card: null,
  meta: { parentToolUseId: 'tu-bg' },
  created_at: new Date('2026-07-16T11:59:30.000Z'),
};

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [WebSurfaceController],
  })
    .useMocker((token) => {
      if (token === getRepositoryToken(JobEntity, DB_CONNECTION))
        return {
          findOne: vi.fn(() => Promise.resolve({ id: JOB_ID, org_id: ORG_ID, repo_id: REPO_ID })),
        };
      if (token === getRepositoryToken(TranscriptMessageEntity, DB_CONNECTION)) {
        const getMany = vi.fn(() => Promise.resolve([anchorRow, childRow]));
        const qb: Record<string, unknown> = {};
        for (const m of ['where', 'orderBy', 'addOrderBy']) qb[m] = () => qb;
        qb.getMany = getMany;
        return { createQueryBuilder: vi.fn(() => qb) };
      }
      if (token === getRepositoryToken(SubagentEntity, DB_CONNECTION))
        return { find: vi.fn(() => Promise.resolve(subagentRows)) };
      return {}; // auto-mock every other collaborator (unused by this endpoint)
    })
    .overrideGuard(OrgMembershipGuard)
    .useValue({
      canActivate: (ctx: ExecutionContext) => {
        ctx.switchToHttp().getRequest().org = { id: ORG_ID, role: 'owner' };
        return true;
      },
    })
    .compile();

  app = moduleRef.createNestApplication();
  await app.init();
  server = app.getHttpServer();
  const probe = await request(server).get('/web/does-not-exist-probe');
  console.log('REAL SERVER CHECK — listening:', server.listening, '| probe status:', probe.status);
}, 30_000);

afterAll(async () => {
  await app?.close();
});

const messagesUrl = `/web/orgs/${ORG_ID}/repos/${REPO_ID}/jobs/${JOB_ID}/messages`;

describe('GET .../messages — authoritative subagent status on the anchor (LIVE HTTP)', () => {
  it("a still-running subagent → anchor carries subagentStatus:'running', endedAt:null (despite launch-ack meta.result)", async () => {
    subagentRows = [
      {
        parent_message_id: ANCHOR_ID,
        thread_id: JOB_ID,
        status: 'running',
        ended_at: null,
      },
    ];
    const res = await request(server).get(messagesUrl);
    console.log(`OBSERVED GET ${messagesUrl} →`, res.status);
    expect(res.status).toBe(200);
    const anchor = (res.body as Array<Record<string, unknown>>).find((m) => m.id === ANCHOR_ID)!;
    console.log('anchor payload:', JSON.stringify(anchor));
    expect(anchor.subagentStatus).toBe('running');
    expect(anchor.subagentEndedAt).toBeNull();
    const child = (res.body as Array<Record<string, unknown>>).find((m) => m.id === 'msg-child')!;
    expect('subagentStatus' in child).toBe(false);
  });

  it("a finished subagent → anchor carries subagentStatus:'done' + the ISO ended_at", async () => {
    subagentRows = [
      {
        parent_message_id: ANCHOR_ID,
        thread_id: JOB_ID,
        status: 'done',
        ended_at: ENDED_AT,
      },
    ];
    const res = await request(server).get(messagesUrl);
    const anchor = (res.body as Array<Record<string, unknown>>).find((m) => m.id === ANCHOR_ID)!;
    expect(anchor.subagentStatus).toBe('done');
    expect(anchor.subagentEndedAt).toBe(ENDED_AT.toISOString());
  });

  it('no subagent row → anchor omits the field (legacy fallback path on the web)', async () => {
    subagentRows = [];
    const res = await request(server).get(messagesUrl);
    const anchor = (res.body as Array<Record<string, unknown>>).find((m) => m.id === ANCHOR_ID)!;
    expect('subagentStatus' in anchor).toBe(false);
  });
});
