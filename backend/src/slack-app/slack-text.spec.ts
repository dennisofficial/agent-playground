import {
  emojiToSlackName,
  extractHandles,
  translateInbound,
  translateOutbound,
} from './slack-text';

const deps = (overrides?: {
  users?: Record<string, string>;
  bots?: Record<string, string>;
  selfBotUserId?: string;
}) => ({
  resolveUser: (id: string) => (overrides?.users ?? {})[id],
  resolveBotHandle: (id: string) => (overrides?.bots ?? {})[id],
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

  it('keeps the @ for a roster puppet mention (so the gate hard-respond rule fires)', () => {
    expect(
      translateInbound('<@U07SAM> can you check this?', {
        ...deps({ bots: { U07SAM: 'sam' } }),
      }),
    ).toBe('@sam can you check this?');
  });

  it('keeps the @ for every puppet when multiple bots are mentioned (the "Sam Maya" regression)', () => {
    expect(
      translateInbound('<@U07SAM> <@U07MAYA>', {
        ...deps({ bots: { U07SAM: 'sam', U07MAYA: 'maya' } }),
      }),
    ).toBe('@sam @maya');
  });

  it('leaves a human mention bare even when their name collides with a bot (no false hard-mention)', () => {
    // U123 resolves to display name "Sam" but is NOT a puppet → bare, not @sam.
    expect(
      translateInbound('<@U123> ping', deps({ users: { U123: 'Sam' } })),
    ).toBe('Sam ping');
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
    expect(emojiToSlackName('💭')).toBe('thought_balloon'); // the "composing" marker
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

describe('extractHandles', () => {
  it('extracts bare @handles from prose', () => {
    expect(extractHandles('@Dennis ping')).toEqual(['Dennis']);
    expect(extractHandles('hey @Alex, check this out')).toEqual(['Alex']);
    expect(extractHandles('@Sam and @Riley please review')).toEqual([
      'Sam',
      'Riley',
    ]);
  });

  it('deduplicates repeated handles', () => {
    expect(extractHandles('@Alex and also @Alex')).toEqual(['Alex']);
  });

  it('skips handles inside fenced code blocks', () => {
    expect(extractHandles('```\n@Dennis\n```')).toEqual([]);
    expect(extractHandles('before ```@Alex``` after')).toEqual([]);
  });

  it('skips handles inside inline code', () => {
    expect(extractHandles('run `@Dennis --help`')).toEqual([]);
    expect(extractHandles('try `npm run @test`')).toEqual([]);
  });

  it('skips email-like patterns (@ preceded by word chars)', () => {
    expect(extractHandles('email user@example.com please')).toEqual([]);
    expect(extractHandles('dennis@slack.com')).toEqual([]);
  });

  it('skips handles in URL paths (@ preceded by /)', () => {
    expect(extractHandles('see https://github.com/@alex for details')).toEqual(
      [],
    );
  });

  it('skips broadcast keywords (here/channel/everyone)', () => {
    expect(extractHandles('@here everyone!')).toEqual([]);
    expect(extractHandles('@channel update')).toEqual([]);
    expect(extractHandles('@everyone listen up')).toEqual([]);
  });

  it('handles dots and hyphens in handle names', () => {
    expect(extractHandles('@first.last ping')).toEqual(['first.last']);
    expect(extractHandles('@de-sign check')).toEqual(['de-sign']);
  });
});

describe('translateOutbound with resolveMention', () => {
  const resolve =
    (map: Record<string, string>) =>
    (h: string): string | undefined =>
      map[h];

  it('converts a resolved @handle to <@SLACK_ID>', () => {
    expect(
      translateOutbound('@Dennis ping', {
        resolveMention: resolve({ Dennis: 'U123' }),
      }),
    ).toBe('<@U123> ping');
  });

  it('leaves an unresolved @handle literal (graceful degradation)', () => {
    expect(
      translateOutbound('@Unknown check this', { resolveMention: resolve({}) }),
    ).toBe('@Unknown check this');
  });

  it('converts multiple distinct handles in one message', () => {
    expect(
      translateOutbound('@Dennis and @Alex please sync', {
        resolveMention: resolve({ Dennis: 'U123', Alex: 'UABC' }),
      }),
    ).toBe('<@U123> and <@UABC> please sync');
  });

  it('leaves @here/@channel/@everyone literal (broadcasts off in v1)', () => {
    expect(
      translateOutbound('@here standup time', {
        resolveMention: resolve({ here: 'Uhere' }),
      }),
    ).toBe('@here standup time');
    expect(
      translateOutbound('@channel heads up', { resolveMention: resolve({}) }),
    ).toBe('@channel heads up');
  });

  it('does not convert @handles inside inline code or fenced blocks', () => {
    expect(
      translateOutbound('run `@Dennis --help`', {
        resolveMention: resolve({ Dennis: 'U123' }),
      }),
    ).toBe('run `@Dennis --help`');
    expect(
      translateOutbound('```\n@Dennis\n```', {
        resolveMention: resolve({ Dennis: 'U123' }),
      }),
    ).toBe('```\n@Dennis\n```');
  });

  it('does not convert email-like patterns', () => {
    expect(
      translateOutbound('contact dennis@example.com', {
        resolveMention: resolve({ 'example.com': 'Uoops' }),
      }),
    ).toBe('contact dennis@example.com');
  });

  it('converts mentions AND applies mrkdwn formatting in the same message', () => {
    expect(
      translateOutbound('**done** — @Dennis LGTM?', {
        resolveMention: resolve({ Dennis: 'U123' }),
      }),
    ).toBe('*done* — <@U123> LGTM?');
  });

  it('no-dep call (undefined deps) is identical to the original behaviour', () => {
    const plain = '**bold** @Dennis and `code`';
    expect(translateOutbound(plain)).toBe(translateOutbound(plain, undefined));
    expect(translateOutbound(plain)).toBe('*bold* @Dennis and `code`');
  });
});
