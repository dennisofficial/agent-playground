import { emojiToSlackName, translateInbound } from './slack-text';

const deps = (overrides?: {
  users?: Record<string, string>;
  selfBotUserId?: string;
}) => ({
  resolveUser: (id: string) => (overrides?.users ?? {})[id],
  selfBotUserId: overrides?.selfBotUserId,
});

describe('translateInbound', () => {
  it('replaces user mentions with resolved display names', () => {
    expect(
      translateInbound('<@U123> can you check this?', {
        ...deps({ users: { U123: 'Dennis' } }),
      }),
    ).toBe('Dennis can you check this?');
  });

  it('keeps the embedded label, then the raw id, when the user is unknown', () => {
    expect(translateInbound('<@U999|denny> hi', deps())).toBe('denny hi');
    expect(translateInbound('<@U999> hi', deps())).toBe('U999 hi');
  });

  it('translates a mention of our own bot user into @here (roster broadcast)', () => {
    expect(
      translateInbound('<@UBOT> everyone check in', deps({ selfBotUserId: 'UBOT' })),
    ).toBe('@here everyone check in');
  });

  it('translates special mentions', () => {
    expect(translateInbound('<!here> standup', deps())).toBe('@here standup');
    expect(translateInbound('<!channel|channel> hi', deps())).toBe('@channel hi');
    expect(translateInbound('<!everyone>', deps())).toBe('@everyone');
  });

  it('unwraps links and channel refs', () => {
    expect(
      translateInbound('see <https://example.com/x|the docs> and <https://a.b>', deps()),
    ).toBe('see the docs (https://example.com/x) and https://a.b');
    expect(translateInbound('move to <#C042|dev>', deps())).toBe('move to #dev');
  });

  it('unescapes HTML entities last, without corrupting tokens', () => {
    expect(translateInbound('a &lt;b&gt; c &amp;&amp; d', deps())).toBe('a <b> c && d');
  });
});

describe('emojiToSlackName', () => {
  it('maps common unicode emoji to shortcodes', () => {
    expect(emojiToSlackName('👍')).toBe('thumbsup');
    expect(emojiToSlackName('✅')).toBe('white_check_mark');
    expect(emojiToSlackName('🎉')).toBe('tada');
    expect(emojiToSlackName('🚀')).toBe('rocket');
  });

  it('is variation-selector-insensitive in both directions', () => {
    expect(emojiToSlackName('⚠️')).toBe('warning'); // with U+FE0F
    expect(emojiToSlackName('⚠')).toBe('warning'); // without
    expect(emojiToSlackName('❤️')).toBe('heart');
    expect(emojiToSlackName('❤')).toBe('heart');
  });

  it('passes through bare and colon-wrapped shortcodes', () => {
    expect(emojiToSlackName('thumbsup')).toBe('thumbsup');
    expect(emojiToSlackName(':eyes:')).toBe('eyes');
  });

  it('falls back to thumbsup for unknown emoji', () => {
    expect(emojiToSlackName('🦖')).toBe('thumbsup');
    expect(emojiToSlackName('')).toBe('thumbsup');
  });
});
