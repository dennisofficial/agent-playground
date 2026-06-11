import {
  emojiToSlackName,
  translateInbound,
  translateOutbound,
} from './slack-text';

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
      translateInbound(
        '<@UBOT> everyone check in',
        deps({ selfBotUserId: 'UBOT' }),
      ),
    ).toBe('@here everyone check in');
  });

  it('translates special mentions', () => {
    expect(translateInbound('<!here> standup', deps())).toBe('@here standup');
    expect(translateInbound('<!channel|channel> hi', deps())).toBe(
      '@channel hi',
    );
    expect(translateInbound('<!everyone>', deps())).toBe('@everyone');
  });

  it('unwraps links and channel refs', () => {
    expect(
      translateInbound(
        'see <https://example.com/x|the docs> and <https://a.b>',
        deps(),
      ),
    ).toBe('see the docs (https://example.com/x) and https://a.b');
    expect(translateInbound('move to <#C042|dev>', deps())).toBe(
      'move to #dev',
    );
  });

  it('unescapes HTML entities last, without corrupting tokens', () => {
    expect(translateInbound('a &lt;b&gt; c &amp;&amp; d', deps())).toBe(
      'a <b> c && d',
    );
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

describe('translateOutbound (Markdown → mrkdwn)', () => {
  it('converts bold, italic, strikethrough, links, and headers', () => {
    expect(translateOutbound('**done** and __shipped__')).toBe(
      '*done* and *shipped*',
    );
    expect(translateOutbound('this is *emphasis* only')).toBe(
      'this is _emphasis_ only',
    );
    expect(translateOutbound('~~dropped~~ it')).toBe('~dropped~ it');
    expect(
      translateOutbound('see [the PR](https://github.com/a/b/pull/1)'),
    ).toBe('see <https://github.com/a/b/pull/1|the PR>');
    expect(translateOutbound('# Standup notes\nbody')).toBe(
      '*Standup notes*\nbody',
    );
  });

  it('rewrites Markdown bullets to • without eating emphasis', () => {
    expect(translateOutbound('- first\n* second\n  - nested')).toBe(
      '• first\n• second\n  • nested',
    );
    expect(translateOutbound('* item with *emphasis* inside')).toBe(
      '• item with _emphasis_ inside',
    );
  });

  it('never rewrites code contents (only the fence language tag is dropped)', () => {
    expect(translateOutbound('run `npm i **not bold**` now')).toBe(
      'run `npm i **not bold**` now',
    );
    expect(
      translateOutbound(
        'before **bold**\n```ts\nconst a = b ** c; // [x](y)\n```\nafter',
      ),
    ).toBe('before *bold*\n```\nconst a = b ** c; // [x](y)\n```\nafter');
  });

  it('leaves plain text, multiplication, and existing mrkdwn alone', () => {
    expect(translateOutbound('2 * 3 * 4 = 24')).toBe('2 * 3 * 4 = 24');
    expect(translateOutbound('already _italic_ and ~struck~')).toBe(
      'already _italic_ and ~struck~',
    );
  });

  it('strips fence language tags (mrkdwn renders them as literal first-line text)', () => {
    expect(translateOutbound('```javascript\nconst a = 1;\n```')).toBe(
      '```\nconst a = 1;\n```',
    );
    expect(translateOutbound('```\nplain\n```')).toBe('```\nplain\n```');
  });

  it('turns horizontal rules into a divider line', () => {
    expect(translateOutbound('above\n---\nbelow')).toBe(
      'above\n──────────\nbelow',
    );
    expect(translateOutbound('***')).toBe('──────────');
    // Not a rule: a frontmatter-less em-dash aside or a 2-char line.
    expect(translateOutbound('a -- b')).toBe('a -- b');
  });

  it('renders Markdown tables as aligned monospace blocks', () => {
    const table =
      '| Col A | B |\n|-------|---|\n| Row 1 | ✅ |\n| Longer row | x |';
    expect(translateOutbound(table)).toBe(
      '```\nCol A      | B\n-----------+--\nRow 1      | ✅\nLonger row | x\n```',
    );
    // Pipes without a separator row are not a table.
    expect(translateOutbound('a | b')).toBe('a | b');
  });

  it('converts image syntax: real URLs become links, fake paths keep the alt text', () => {
    expect(translateOutbound('see ![diagram](https://cdn.x/d.png)')).toBe(
      'see <https://cdn.x/d.png|diagram>',
    );
    expect(translateOutbound('![](https://cdn.x/d.png)')).toBe(
      'https://cdn.x/d.png',
    );
    expect(
      translateOutbound('an image placeholder: ![alt text](image.png)'),
    ).toBe('an image placeholder: alt text');
  });
});
