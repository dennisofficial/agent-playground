import type { Reaction, RenderItem } from './messages';
import { storeReducer } from './store';

type MsgItem = Extract<RenderItem, { kind: 'user' }>;

const userMsg = (id: string, reactions?: Reaction[]): RenderItem => ({
  id,
  kind: 'user',
  text: 'hi',
  ...(reactions ? { reactions } : {}),
});

describe('storeReducer', () => {
  it('folds a reaction onto its target message', () => {
    const next = storeReducer([userMsg('m1')], {
      t: 'react',
      id: 'r1',
      targetId: 'm1',
      by: 'sam',
      emoji: '💭',
    });
    expect((next[0] as MsgItem).reactions).toEqual([
      { by: 'sam', emoji: '💭' },
    ]);
  });

  it('un-folds the matching reaction from its target message', () => {
    const items = [userMsg('m1', [{ by: 'sam', emoji: '💭' }])];
    const next = storeReducer(items, {
      t: 'unreact',
      targetId: 'm1',
      by: 'sam',
      emoji: '💭',
    });
    expect((next[0] as MsgItem).reactions).toEqual([]);
  });

  it('only removes the matching {by, emoji}, leaving others', () => {
    const items = [
      userMsg('m1', [
        { by: 'sam', emoji: '💭' },
        { by: 'dana', emoji: '💭' },
        { by: 'sam', emoji: '👍' },
      ]),
    ];
    const next = storeReducer(items, {
      t: 'unreact',
      targetId: 'm1',
      by: 'sam',
      emoji: '💭',
    });
    expect((next[0] as MsgItem).reactions).toEqual([
      { by: 'dana', emoji: '💭' },
      { by: 'sam', emoji: '👍' },
    ]);
  });

  it('drops a standalone reaction row when that is where it landed', () => {
    const items: RenderItem[] = [
      { id: 'r1', kind: 'reaction', by: 'sam', emoji: '💭' },
    ];
    const next = storeReducer(items, {
      t: 'unreact',
      targetId: 'missing',
      by: 'sam',
      emoji: '💭',
    });
    expect(next).toEqual([]);
  });

  it('is a no-op when the reaction is not present', () => {
    const items = [userMsg('m1', [{ by: 'dana', emoji: '👍' }])];
    const next = storeReducer(items, {
      t: 'unreact',
      targetId: 'm1',
      by: 'sam',
      emoji: '💭',
    });
    expect((next[0] as MsgItem).reactions).toEqual([
      { by: 'dana', emoji: '👍' },
    ]);
  });
});
