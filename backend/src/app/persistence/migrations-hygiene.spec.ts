/**
 * Migration hygiene guard. Part A runs the real rules against the real
 * `backend/migrations/*.ts` tree, grandfathering everything already on `origin/main` and
 * asserting only migrations added in this PR are clean. Part B exercises `checkMigrations`
 * against hand-built synthetic fixtures (no git, no filesystem) to pin down each rule.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkMigrations,
  extractNameTimestamp,
  extractUpBody,
  parseMigrationFilename,
  parseMigrationSource,
  type ParsedMigration,
} from './migration-hygiene';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function repoRoot(): string {
  return git(['rev-parse', '--show-toplevel'], process.cwd());
}

function readAllMigrations(root: string): ParsedMigration[] {
  const dir = join(root, 'backend', 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  return files.map((file) => {
    const source = readFileSync(join(dir, file), 'utf8');
    const parsed = parseMigrationSource(file, source);
    if (!parsed) {
      throw new Error(
        `migrations-hygiene: failed to parse ${file} — every committed migration must parse ` +
          '(filename must match `<digits>-<Slug>.ts` and the class must have a `name = \'...\'` property).',
      );
    }
    return parsed;
  });
}

function resolveMergeBaseRef(root: string): string | null {
  try {
    git(['rev-parse', '--verify', 'origin/main'], root);
    return 'origin/main';
  } catch {
    // fall through to fetch
  }
  try {
    git(['fetch', '--no-tags', '--depth=200', 'origin', 'main'], root);
    git(['rev-parse', '--verify', 'origin/main'], root);
    return 'origin/main';
  } catch {
    return null;
  }
}

function resolveAdded(root: string, all: ParsedMigration[]): ParsedMigration[] {
  const ref = resolveMergeBaseRef(root);
  if (!ref) {
    console.warn(
      'migrations-hygiene.spec: origin/main is not resolvable locally — treating `added` as empty. ' +
        'CI (fetch-depth: 0) is the authoritative gate for the added-migration rules.',
    );
    return [];
  }

  const mergeBase = git(['merge-base', 'HEAD', ref], root);
  const diffOutput = git(
    ['diff', '--diff-filter=A', '--name-only', mergeBase, 'HEAD', '--', 'backend/migrations/'],
    root,
  );
  if (!diffOutput) return [];

  const byFile = new Map(all.map((m) => [m.file, m]));
  return diffOutput
    .split('\n')
    .filter(Boolean)
    .map((path) => {
      const basename = path.split('/').pop() as string;
      const migration = byFile.get(basename);
      if (!migration) {
        throw new Error(
          `migrations-hygiene: migration ${basename} was added per git diff but was not found ` +
            'among the parsed migrations in backend/migrations/.',
        );
      }
      return migration;
    });
}

describe('migration hygiene — real tree', () => {
  const root = repoRoot();
  const all = readAllMigrations(root);
  const added = resolveAdded(root, all);

  it('has no hygiene violations on migrations added in this PR', () => {
    const violations = checkMigrations({ all, added });
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });
});

describe('migration hygiene — extractUpBody / extractNameTimestamp', () => {
  // Modeled on the shape of backend/migrations/1784088016344-ReconcileConstraintNaming.ts:
  // up() drops a default-named CHECK and re-adds it under the strategy name; down() reverses
  // that, re-adding the default name — which must NOT leak into the extracted up() body.
  const SAMPLE_SOURCE = `
import { MigrationInterface, QueryRunner } from 'typeorm';

export class SampleMigration1784088016344 implements MigrationInterface {
  name = 'SampleMigration1784088016344';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(\`ALTER TABLE "org_credentials" DROP CONSTRAINT "CHK_org_credentials_x"\`);
    await queryRunner.query(\`ALTER TABLE "org_credentials" ADD CONSTRAINT "chk_org_credentials_x" CHECK (true)\`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(\`ALTER TABLE "org_credentials" DROP CONSTRAINT "chk_org_credentials_x"\`);
    await queryRunner.query(\`ALTER TABLE "org_credentials" ADD CONSTRAINT "CHK_org_credentials_x" CHECK (true)\`);
  }
}
`;

  it('extractNameTimestamp reads the last 13 digits of the `name` property', () => {
    expect(extractNameTimestamp(SAMPLE_SOURCE)).toBe(1784088016344);
    expect(extractNameTimestamp('export class NoName {}')).toBeNull();
    expect(extractNameTimestamp("name = 'TooShort123'")).toBeNull();
  });

  it('extractUpBody stops before down() and excludes its default-named re-add', () => {
    const upBody = extractUpBody(SAMPLE_SOURCE);
    expect(upBody).toContain('DROP CONSTRAINT "CHK_org_credentials_x"');
    expect(upBody).toContain('ADD CONSTRAINT "chk_org_credentials_x"');
    expect(upBody).not.toContain('ADD CONSTRAINT "CHK_org_credentials_x"');
  });

  it('extractUpBody returns an empty string when there is no up()', () => {
    expect(extractUpBody('export class Empty {}')).toBe('');
  });

  it('parseMigrationSource + checkMigrations is clean for the sample migration', () => {
    const basename = '1784088016344-SampleMigration.ts';
    const parsed = parseMigrationSource(basename, SAMPLE_SOURCE);
    expect(parsed).not.toBeNull();
    const migration = parsed as ParsedMigration;
    const violations = checkMigrations({ all: [migration], added: [migration] });
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });
});

describe('migration hygiene — parseMigrationFilename', () => {
  it('parses a well-formed filename', () => {
    expect(parseMigrationFilename('1784088016344-ReconcileConstraintNaming.ts')).toEqual({
      fileTs: 1784088016344,
      slug: 'ReconcileConstraintNaming',
    });
  });

  it('rejects a malformed filename', () => {
    expect(parseMigrationFilename('ReconcileConstraintNaming.ts')).toBeNull();
    expect(parseMigrationFilename('1784088016344-ReconcileConstraintNaming.js')).toBeNull();
  });
});

describe('migration hygiene — checkMigrations (synthetic)', () => {
  const baseline: ParsedMigration[] = [
    {
      file: '1784000000001-Baseline1.ts',
      fileTs: 1784000000001,
      nameTs: 1784000000001,
      upBody: 'CREATE TABLE "foo" ("id" uuid)',
    },
    {
      file: '1784000000501-Baseline2.ts',
      fileTs: 1784000000501,
      nameTs: 1784000000501,
      upBody: 'CREATE TABLE "bar" ("id" uuid)',
    },
  ];
  const baseMax = 1784000000501;

  function withBaseline(added: ParsedMigration[]): { all: ParsedMigration[]; added: ParsedMigration[] } {
    return { all: [...baseline, ...added], added };
  }

  it('rejects a duplicate fileTs (collides with an existing migration)', () => {
    const dup: ParsedMigration = {
      file: '1784000000001-DuplicateFileTs.ts',
      fileTs: baseline[0].fileTs,
      nameTs: 1784100000301,
      upBody: '',
    };
    const violations = checkMigrations(withBaseline([dup]));
    expect(violations.some((v) => v.rule === 'unique-filename-timestamp')).toBe(true);
  });

  it('rejects a duplicate nameTs (collides with an existing migration)', () => {
    const dup: ParsedMigration = {
      file: '1784100000401-DuplicateNameTs.ts',
      fileTs: 1784100000401,
      nameTs: baseline[1].nameTs,
      upBody: '',
    };
    const violations = checkMigrations(withBaseline([dup]));
    expect(violations.some((v) => v.rule === 'unique-name-timestamp')).toBe(true);
  });

  it('rejects a round fileTs', () => {
    const round: ParsedMigration = {
      file: '1784200000000-RoundTimestamp.ts',
      fileTs: 1784200000000,
      nameTs: 1784200000000,
      upBody: '',
    };
    const violations = checkMigrations(withBaseline([round]));
    expect(violations).toEqual([
      {
        file: round.file,
        rule: 'round-timestamp',
        message: expect.stringContaining('round value'),
      },
    ]);
  });

  it('rejects fileTs !== nameTs', () => {
    const mismatch: ParsedMigration = {
      file: '1784300000123-Mismatch.ts',
      fileTs: 1784300000123,
      nameTs: 1784300000456,
      upBody: '',
    };
    const violations = checkMigrations(withBaseline([mismatch]));
    expect(violations).toEqual([
      {
        file: mismatch.file,
        rule: 'filename-name-mismatch',
        message: expect.stringContaining('does not match'),
      },
    ]);
  });

  it('rejects nameTs <= baseMax (backdated / out of order)', () => {
    const backdated: ParsedMigration = {
      file: '1784000000500-Backdated.ts',
      fileTs: baseMax - 1,
      nameTs: baseMax - 1,
      upBody: '',
    };
    const violations = checkMigrations(withBaseline([backdated]));
    expect(violations).toEqual([
      {
        file: backdated.file,
        rule: 'not-monotonic',
        message: expect.stringContaining('does not sort after'),
      },
    ]);
  });

  it('rejects an up() that ADDs a default-named FK constraint', () => {
    const badFk: ParsedMigration = {
      file: '1784400000123-DefaultFk.ts',
      fileTs: 1784400000123,
      nameTs: 1784400000123,
      upBody: `await queryRunner.query(\`ALTER TABLE "foo" ADD CONSTRAINT "FK_foo_bar" FOREIGN KEY ("bar_id") REFERENCES "bar"("id")\`);`,
    };
    const violations = checkMigrations(withBaseline([badFk]));
    expect(violations).toEqual([
      {
        file: badFk.file,
        rule: 'default-named-object',
        message: expect.stringContaining('FK_foo_bar'),
      },
    ]);
  });

  it('rejects an up() that CREATEs a default-named index', () => {
    const badIndex: ParsedMigration = {
      file: '1784400000456-DefaultIndex.ts',
      fileTs: 1784400000456,
      nameTs: 1784400000456,
      upBody: `await queryRunner.query(\`CREATE INDEX "IDX_foo" ON "foo" ("bar_id")\`);`,
    };
    const violations = checkMigrations(withBaseline([badIndex]));
    expect(violations).toEqual([
      {
        file: badIndex.file,
        rule: 'default-named-object',
        message: expect.stringContaining('IDX_foo'),
      },
    ]);
  });

  it('does not flag a default name when the escape hatch comment is present', () => {
    const escaped: ParsedMigration = {
      file: '1784400000789-EscapedDefaultFk.ts',
      fileTs: 1784400000789,
      nameTs: 1784400000789,
      upBody:
        '// migration-hygiene: allow-default-name legacy rename, no strategy name yet\n' +
        `await queryRunner.query(\`ALTER TABLE "foo" ADD CONSTRAINT "FK_foo_bar" FOREIGN KEY ("bar_id") REFERENCES "bar"("id")\`);`,
    };
    const violations = checkMigrations(withBaseline([escaped]));
    expect(violations).toEqual([]);
  });

  it('accepts a clean added migration', () => {
    const clean: ParsedMigration = {
      file: '1784500000123-CleanAdded.ts',
      fileTs: 1784500000123,
      nameTs: 1784500000123,
      upBody: `await queryRunner.query(\`ALTER TABLE "foo" ADD CONSTRAINT "fk_foo_bar_bar" FOREIGN KEY ("bar_id") REFERENCES "bar"("id")\`);`,
    };
    const violations = checkMigrations(withBaseline([clean]));
    expect(violations).toEqual([]);
  });

  it('accepts a clean added migration whose down() re-adds a default name (upBody excludes down())', () => {
    // ParsedMigration.upBody is constructed directly here to prove checkMigrations only ever
    // looks at what it's given for `upBody` — extraction itself is covered above.
    const cleanWithDirtyDown: ParsedMigration = {
      file: '1784500000456-CleanWithDirtyDown.ts',
      fileTs: 1784500000456,
      nameTs: 1784500000456,
      upBody: 'ALTER TABLE "org_credentials" ADD CONSTRAINT "chk_org_credentials_mode" CHECK (true)',
    };
    const violations = checkMigrations(withBaseline([cleanWithDirtyDown]));
    expect(violations).toEqual([]);
  });

  it('stability: two distinct, valid added migrations both pass together', () => {
    const first: ParsedMigration = {
      file: '1784600000111-First.ts',
      fileTs: 1784600000111,
      nameTs: 1784600000111,
      upBody: 'CREATE TABLE "one" ("id" uuid)',
    };
    const second: ParsedMigration = {
      file: '1784600000222-Second.ts',
      fileTs: 1784600000222,
      nameTs: 1784600000222,
      upBody: 'CREATE TABLE "two" ("id" uuid)',
    };
    const violations = checkMigrations(withBaseline([first, second]));
    expect(violations).toEqual([]);
  });
});
