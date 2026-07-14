// Fake `codex app-server` for tests: speaks the same NDJSON JSON-RPC protocol over stdio, with no
// dependencies. Scripts its notification sequence off the incoming turn/start input text so tests can
// exercise the happy path, approval interception, steer, and effort passthrough deterministically.

import { createInterface } from 'node:readline';

const TURN_ID = 'turn_test_1';
const CANNED_USAGE = {
  total: {
    inputTokens: 10,
    cachedInputTokens: 2,
    outputTokens: 5,
    reasoningOutputTokens: 3,
    totalTokens: 15,
  },
  last: {
    inputTokens: 10,
    cachedInputTokens: 2,
    outputTokens: 5,
    reasoningOutputTokens: 3,
    totalTokens: 15,
  },
};

let serverRequestId = 1000;
let currentThreadId = 'thr_test_1';
let turnDone = false;
let steerResolver = null;
let interrupted = false;

const pendingServerRequests = new Map();

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function notify(method, params) {
  send({ method, params });
}

function serverRequest(method, params) {
  return new Promise((resolve) => {
    const id = serverRequestId++;
    pendingServerRequests.set(id, resolve);
    send({ method, id, params });
  });
}

function completeTurn(threadId, status) {
  if (turnDone) return;
  turnDone = true;
  // Real `Turn` objects carry no `usage` field — token usage only ever arrives via
  // thread/tokenUsage/updated notifications, which the client accumulates separately.
  notify('turn/completed', {
    threadId,
    turn: { id: TURN_ID, status, items: [], error: null },
  });
}

async function runScript(threadId, text, effort, sandboxPolicy) {
  turnDone = false;
  interrupted = false;
  // Echo the received effort/sandboxPolicy back (alongside the real `turn` object) so a test can
  // prove they were passed through in the real wire shape.
  notify('turn/started', {
    threadId,
    turn: { id: TURN_ID, status: 'inProgress', items: [] },
    effort,
    sandboxPolicy,
  });

  if (text.includes('trigger-approval')) {
    const decision = await serverRequest('item/fileChange/requestApproval', {
      threadId,
      turnId: TURN_ID,
      itemId: 'item_fc_1',
      grantRoot: '/tmp/codex-sdk-test-home',
    });
    const status = decision && decision.decision === 'decline' ? 'declined' : 'completed';
    notify('item/started', {
      threadId,
      turnId: TURN_ID,
      item: { id: 'item_fc_1', type: 'fileChange', status: 'inProgress' },
    });
    notify('item/completed', {
      threadId,
      turnId: TURN_ID,
      item: { id: 'item_fc_1', type: 'fileChange', status },
    });
    notify('thread/tokenUsage/updated', { threadId, turnId: TURN_ID, tokenUsage: CANNED_USAGE });
    completeTurn(threadId, 'completed');
    return;
  }

  if (text.includes('trigger-permissions')) {
    const grant = await serverRequest('item/permissions/requestApproval', {
      threadId,
      turnId: TURN_ID,
      itemId: 'item_perm_1',
      environmentId: null,
      cwd: '/tmp',
      reason: 'need workspace write',
      startedAtMs: Date.now(),
      permissions: {
        fileSystem: { read: null, write: ['/tmp/codex-sdk-test-home'], entries: [] },
        network: null,
      },
    });
    const ok =
      grant &&
      grant.permissions &&
      grant.permissions.fileSystem &&
      Array.isArray(grant.permissions.fileSystem.write) &&
      grant.permissions.fileSystem.write[0] === '/tmp/codex-sdk-test-home' &&
      grant.scope === 'turn';
    notify('item/completed', {
      threadId,
      turnId: TURN_ID,
      item: {
        id: 'item_am_1',
        type: 'agentMessage',
        text: ok ? 'permission-granted' : 'permission-bad-response',
      },
    });
    notify('thread/tokenUsage/updated', { threadId, turnId: TURN_ID, tokenUsage: CANNED_USAGE });
    completeTurn(threadId, 'completed');
    return;
  }

  if (text.includes('trigger-steer')) {
    notify('item/started', {
      threadId,
      turnId: TURN_ID,
      item: { id: 'item_am_1', type: 'agentMessage' },
    });
    const steeredText = await new Promise((resolve) => {
      steerResolver = resolve;
    });
    if (interrupted) {
      completeTurn(threadId, 'interrupted');
      return;
    }
    notify('item/agentMessage/delta', {
      threadId,
      turnId: TURN_ID,
      itemId: 'item_am_1',
      delta: `echo:${steeredText}`,
    });
    notify('item/completed', {
      threadId,
      turnId: TURN_ID,
      item: { id: 'item_am_1', type: 'agentMessage', text: `echo:${steeredText}` },
    });
    notify('thread/tokenUsage/updated', { threadId, turnId: TURN_ID, tokenUsage: CANNED_USAGE });
    completeTurn(threadId, 'completed');
    return;
  }

  // Default happy path.
  notify('item/started', {
    threadId,
    turnId: TURN_ID,
    item: { id: 'item_am_1', type: 'agentMessage' },
  });
  notify('item/agentMessage/delta', {
    threadId,
    turnId: TURN_ID,
    itemId: 'item_am_1',
    delta: 'Hello',
  });
  notify('item/completed', {
    threadId,
    turnId: TURN_ID,
    item: { id: 'item_am_1', type: 'agentMessage', text: 'Hello' },
  });
  notify('thread/tokenUsage/updated', { threadId, turnId: TURN_ID, tokenUsage: CANNED_USAGE });
  if (interrupted) {
    completeTurn(threadId, 'interrupted');
    return;
  }
  completeTurn(threadId, 'completed');
}

function handleTurnStart(msg) {
  const params = msg.params || {};
  currentThreadId = params.threadId || 'thr_test_1';
  const input = Array.isArray(params.input) ? params.input : [];
  const text = (input[0] && input[0].text) || '';
  if (input.some((item) => item && item.type === 'text' && !Array.isArray(item.text_elements))) {
    send({ id: msg.id, error: { code: -32602, message: 'text input missing text_elements' } });
    return;
  }
  send({
    id: msg.id,
    result: { turn: { id: TURN_ID, status: 'inProgress', items: [], error: null } },
  });
  // Let the response line flush before scripting notifications.
  setImmediate(() => runScript(currentThreadId, text, params.effort, params.sandboxPolicy));
}

function handleSteer(msg) {
  const params = msg.params || {};
  const input = Array.isArray(params.input) ? params.input : [];
  if (input.some((item) => item && item.type === 'text' && !Array.isArray(item.text_elements))) {
    send({ id: msg.id, error: { code: -32602, message: 'text input missing text_elements' } });
    return;
  }
  send({ id: msg.id, result: { turnId: TURN_ID } });
  if (steerResolver) {
    const resolve = steerResolver;
    steerResolver = null;
    resolve((input[0] && input[0].text) || '');
  }
}

function handleInterrupt(msg) {
  interrupted = true;
  send({ id: msg.id, result: {} });
  if (steerResolver) {
    const resolve = steerResolver;
    steerResolver = null;
    resolve('');
  } else {
    completeTurn(currentThreadId, 'interrupted');
  }
}

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  // Response to one of our server-initiated approval requests.
  if (msg.id !== undefined && msg.method === undefined && msg.result !== undefined) {
    const resolve = pendingServerRequests.get(msg.id);
    if (resolve) {
      pendingServerRequests.delete(msg.id);
      resolve(msg.result);
    }
    return;
  }

  switch (msg.method) {
    case 'initialize':
      send({
        id: msg.id,
        result: {
          userAgent: 'fake-app-server/0',
          codexHome: process.env.CODEX_HOME || '/tmp',
          platformFamily: 'unix',
          platformOs: 'linux',
        },
      });
      return;
    case 'initialized':
      return;
    case 'thread/start':
    case 'thread/resume':
      send({ id: msg.id, result: { thread: { id: 'thr_test_1' } } });
      return;
    case 'turn/start':
      handleTurnStart(msg);
      return;
    case 'turn/steer':
      handleSteer(msg);
      return;
    case 'turn/interrupt':
      handleInterrupt(msg);
      return;
    default:
      if (msg.id !== undefined) {
        send({ id: msg.id, error: { code: -32601, message: `Unknown method ${msg.method}` } });
      }
      return;
  }
});

rl.on('close', () => process.exit(0));
