import { Spinner, TextInput } from '@inkjs/ui';
import { Box, Static, Text, useApp, useInput } from 'ink';
import { useEffect, useReducer, useRef } from 'react';
import { getBoard } from '../board/index.js';
import { conductor } from '../conductor.js';
import { DEFAULT_PROJECT } from '../memory/identity.js';
import { listTasks } from '../memory/tasks.js';
import { MessageView } from './components.js';
import { type RenderItem, renderEvent } from './messages.js';

/** A short HH:MM:SS stamp for the user's own echoed messages (the conductor stamps bot events). */
const clock = (): string =>
  new Date().toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

const appendHistory = (state: RenderItem[], item: RenderItem): RenderItem[] => [...state, item];

export function App() {
  const { exit } = useApp();
  // The conductor's domain events accumulate into our own render history (it holds no UI state now).
  const [history, pushHistory] = useReducer(appendHistory, []);
  // Status (busy/thinking/ctx/jobs-running/speaker) is a pull snapshot — re-render when it changes.
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const offStatus = conductor.subscribe(force);
    const offEvents = conductor.onEvent((e) => pushHistory(renderEvent(e)));
    return () => {
      offStatus();
      offEvents();
    };
  }, []);
  // The input stays mounted now (so you can type while bots think), so it no longer clears itself on
  // submit — bump this key to remount it empty after each send.
  const [inputKey, clearInput] = useReducer((x: number) => x + 1, 0);
  // Ids for the TUI's own local rows (the echoed user input, /tasks output) — namespaced so they can't
  // collide with conductor-emitted event ids.
  const localSeq = useRef(0);
  const localId = () => `local-${localSeq.current++}`;

  useInput((input, key) => {
    if (key.ctrl && input === 'd') exit();
  });

  const { ctx, running, speaker, thinking } = conductor.getStatus();
  const who = speaker.charAt(0).toUpperCase() + speaker.slice(1);
  // Plan jobs waiting on the human's /approve. Re-read each render — the status subscription fires on
  // every job update, so this panel appears the moment a plan lands in 'awaiting'.
  const awaiting = conductor.awaitingApprovals();

  function handleSubmit(value: string) {
    const text = value.trim();
    if (!text) return;
    if (text === '/exit' || text === '/quit') {
      exit();
      return;
    }
    // "/tasks" dumps every employee's open reminders (what the reflect pass has captured) into the
    // transcript — a CLI-local view, not a chat message, so the TUI renders it itself.
    if (text === '/tasks') {
      const tasks = listTasks({ project: DEFAULT_PROJECT, status: 'open' });
      const note = tasks.length
        ? `Open reminders (${tasks.length}):\n` +
          tasks.map((t) => `  #${t.id}  [${t.owner}]  ${t.description}`).join('\n')
        : 'No open reminders yet.';
      pushHistory({ id: localId(), kind: 'note', text: note });
      clearInput();
      return;
    }
    // "/as <name>" switches who you're speaking as in the channel — lets you simulate a group chat.
    const as = text.match(/^\/as\s+(.+)$/i);
    if (as) {
      conductor.setSpeaker(as[1]);
      clearInput();
      return;
    }
    // "/approve <jobId> [edits]" / "/reject <jobId> <reason>" — the HUMAN-ONLY plan-approval gate. These
    // call the conductor directly (never a chat bot), so the model can't approve its own plan. The result
    // is a local note, not a channel message.
    const approve = text.match(/^\/approve\s+(\S+)\s*(.*)$/i);
    if (approve) {
      const id = approve[1];
      const edits = approve[2].trim() || undefined;
      const isTicket = /^TKT-/i.test(id);
      const res = isTicket ? conductor.approveTicket(id, edits) : conductor.approvePlan(id, edits);
      pushHistory({
        id: localId(),
        kind: 'note',
        text: res.ok
          ? isTicket
            ? `✓ Approved ticket ${id} — plans frozen, ready for the team to build.`
            : `✓ Approved ${id} — building now.`
          : `Couldn't approve ${id}: ${res.reason}`,
      });
      clearInput();
      return;
    }
    const reject = text.match(/^\/reject\s+(\S+)\s*(.*)$/i);
    if (reject) {
      const reason = reject[2].trim();
      if (!reason) {
        pushHistory({ id: localId(), kind: 'note', text: 'Usage: /reject <jobId> <reason>' });
        clearInput();
        return;
      }
      const res = conductor.rejectPlan(reject[1], reason);
      pushHistory({
        id: localId(),
        kind: 'note',
        text: res.ok
          ? `✕ Rejected ${reject[1]} — sent back to revise.`
          : `Couldn't reject ${reject[1]}: ${res.reason}`,
      });
      clearInput();
      return;
    }
    // "/approve-ticket <TKT-id> [edits]" — the STANDUP sign-off. Freezes the ticket's plans and makes it
    // buildable without any further per-job approval. Distinct from "/approve <jobId>" (a single plan job).
    const approveTicket = text.match(/^\/approve-ticket\s+(\S+)\s*(.*)$/i);
    if (approveTicket) {
      const res = conductor.approveTicket(approveTicket[1], approveTicket[2].trim() || undefined);
      pushHistory({
        id: localId(),
        kind: 'note',
        text: res.ok
          ? `✓ Approved ticket ${approveTicket[1]} — plans frozen, ready for the team to build.`
          : `Couldn't approve ${approveTicket[1]}: ${res.reason}`,
      });
      clearInput();
      return;
    }
    // "/standup" — kick off a standup: post a synthetic prompt as you so Sam leads the backlog review.
    if (text === '/standup') {
      conductor.submitUser(
        "Standup time. Sam, lead us through it — walk me through the backlog and let's decide what to work on. Everyone, share what's on your plate and what you got done.",
      );
      clearInput();
      return;
    }
    // "/tickets" dumps the Jira board into the transcript — a CLI-local view, not a chat message.
    if (text === '/tickets') {
      const tickets = getBoard().listTickets({ project: DEFAULT_PROJECT });
      const note = tickets.length
        ? `Board (${tickets.length}):\n` +
          tickets.map((t) => `  ${t.id}  (${t.status})  ${t.title}`).join('\n')
        : 'No tickets on the board yet.';
      pushHistory({ id: localId(), kind: 'note', text: note });
      clearInput();
      return;
    }
    // Echo the user's own message locally (the conductor only puts it on the channel), then submit.
    pushHistory({ id: localId(), kind: 'user', text, speaker: who, ts: clock() });
    conductor.submitUser(text);
    clearInput();
  }

  const ctxLabel =
    ctx.input !== undefined
      ? `ctx ${ctx.input.toLocaleString()} in · ${(ctx.output ?? 0).toLocaleString()} out`
      : '';

  return (
    <Box flexDirection="column">
      {/* Completed messages stream into history at the MESSAGE level (streamMode 'updates'): each
          chunk of a bot's turn — text or tool calls — appears whole as soon as that step finishes,
          not token-by-token. The spinner below shows the bot is still working between chunks. */}
      <Static items={history}>{(item) => <MessageView key={item.id} item={item} />}</Static>

      {/* Running-bots indicator — separate from the input, which stays live so you can type while they
          think and fire messages as you go (they fold them in at their next step). */}
      {thinking.length > 0 && (
        <Box>
          <Spinner
            label={`${thinking.join(', ')} ${thinking.length === 1 ? 'is' : 'are'} thinking…`}
          />
        </Box>
      )}
      {awaiting.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          {awaiting.map((j) => (
            <Text key={j.id} color="yellow">
              {`⏳ Awaiting your approval: ${j.id} ("${j.task.slice(0, 60)}${
                j.task.length > 60 ? '…' : ''
              }")  ·  /approve ${j.id}  ·  /reject ${j.id} <reason>`}
            </Text>
          ))}
        </Box>
      )}
      <Box>
        <Text color="cyan">{`${who} ❯ `}</Text>
        <TextInput
          key={inputKey}
          placeholder="message   ·   /approve <job>   ·   /tasks   ·   /as <name>   ·   /exit"
          onSubmit={handleSubmit}
        />
      </Box>

      {(ctxLabel || running > 0) && (
        <Box>
          <Text dimColor>
            {[ctxLabel, running > 0 ? `${running} job${running === 1 ? '' : 's'} running` : '']
              .filter(Boolean)
              .join('  ·  ')}
          </Text>
        </Box>
      )}
    </Box>
  );
}
