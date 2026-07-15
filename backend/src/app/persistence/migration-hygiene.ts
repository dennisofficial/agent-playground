/**
 * Migration hygiene rules — pure, git-free. Callers (the "real tree" spec case, and the
 * `db:migration:check` CLI) resolve `all` (every migration in `backend/migrations/`) and
 * `added` (the subset added in the current PR, via `git diff --diff-filter=A`) and pass them
 * in here. Everything already on the base branch is grandfathered: rules only fire for
 * migrations in `added`.
 */

export interface ParsedMigration {
  file: string;
  fileTs: number;
  nameTs: number;
  upBody: string;
}

export interface Violation {
  file: string;
  rule: string;
  message: string;
}

const FILENAME_PATTERN = /^(\d+)-(.+)\.ts$/;
const NAME_PROPERTY_PATTERN = /name\s*=\s*['"]([^'"]+)['"]/;
const NAME_TIMESTAMP_LENGTH = 13;
const ROUND_TIMESTAMP_DIVISOR = 1_000_000;
const ALLOW_DEFAULT_NAME_ESCAPE_HATCH = 'migration-hygiene: allow-default-name';
// Intentionally case-sensitive on the quoted identifier prefix: TypeORM's default names are
// upper-cased (FK_/CHK_/PK_/UQ_/IDX_/REL_) while CustomNamingStrategy names are lowercase
// (fk_/chk_/idx_/uq_) — case is exactly what distinguishes a violation from a clean rename.
const DEFAULT_NAME_CREATION_PATTERN =
  /ADD CONSTRAINT "(?:FK_|CHK_|PK_|UQ_)|CREATE (?:UNIQUE )?INDEX "(?:IDX_|UQ_|REL_)/;

const GENERATE_HINT = 'run `pnpm db:migration:generate` instead of hand-writing the migration';

export function parseMigrationFilename(
  basename: string,
): { fileTs: number; slug: string } | null {
  const match = FILENAME_PATTERN.exec(basename);
  if (!match) return null;
  return { fileTs: parseInt(match[1], 10), slug: match[2] };
}

export function extractNameTimestamp(source: string): number | null {
  const match = NAME_PROPERTY_PATTERN.exec(source);
  if (!match) return null;
  const tail = match[1].slice(-NAME_TIMESTAMP_LENGTH);
  if (!/^\d{13}$/.test(tail)) return null;
  return parseInt(tail, 10);
}

export function extractUpBody(source: string): string {
  const upMatch = /\basync\s+up\s*\(/.exec(source);
  if (!upMatch) return '';
  const upStart = upMatch.index;
  const downMatch = /\basync\s+down\s*\(/.exec(source.slice(upStart));
  const downStart = downMatch ? upStart + downMatch.index : undefined;
  return source.slice(upStart, downStart ?? source.length);
}

export function parseMigrationSource(
  basename: string,
  source: string,
): ParsedMigration | null {
  const filename = parseMigrationFilename(basename);
  if (!filename) return null;
  const nameTs = extractNameTimestamp(source);
  if (nameTs === null) return null;
  return {
    file: basename,
    fileTs: filename.fileTs,
    nameTs,
    upBody: extractUpBody(source),
  };
}

function hasEscapeHatch(lines: string[], index: number): boolean {
  return (
    lines[index].includes(ALLOW_DEFAULT_NAME_ESCAPE_HATCH) ||
    (index > 0 && lines[index - 1].includes(ALLOW_DEFAULT_NAME_ESCAPE_HATCH))
  );
}

function checkDefaultNamedObjects(migration: ParsedMigration): Violation[] {
  const lines = migration.upBody.split('\n');
  const violations: Violation[] = [];
  lines.forEach((line, index) => {
    if (!DEFAULT_NAME_CREATION_PATTERN.test(line)) return;
    if (hasEscapeHatch(lines, index)) return;
    violations.push({
      file: migration.file,
      rule: 'default-named-object',
      message:
        `${migration.file}: up() creates a default-named object ("${line.trim()}") instead of a ` +
        `CustomNamingStrategy lowercase name — ${GENERATE_HINT}, or add a ` +
        `\`// ${ALLOW_DEFAULT_NAME_ESCAPE_HATCH} <reason>\` comment on (or above) the line if intentional.`,
    });
  });
  return violations;
}

export function checkMigrations(args: {
  all: ParsedMigration[];
  added: ParsedMigration[];
}): Violation[] {
  const { all, added } = args;
  const addedFiles = new Set(added.map((m) => m.file));
  const baseline = all.filter((m) => !addedFiles.has(m.file));
  const baseMax = baseline.length
    ? Math.max(...baseline.map((m) => m.nameTs))
    : -Infinity;

  // Migrations within `added` must also be monotonic relative to each other, not just
  // relative to the baseline — a PR can add several migrations at once (e.g. a dependent
  // follow-up) where a later-ordered file ends up with an earlier nameTs. Walk `added` in
  // filename (fileTs) order, the order TypeORM's own file listing implies, tracking a running
  // max so each migration is compared against everything before it, not just the baseline.
  const requiredMaxByFile = new Map<string, number>();
  let runningMax = baseMax;
  for (const migration of [...added].sort((a, b) => a.fileTs - b.fileTs)) {
    requiredMaxByFile.set(migration.file, runningMax);
    if (migration.nameTs > runningMax) runningMax = migration.nameTs;
  }

  const violations: Violation[] = [];

  for (const migration of added) {
    const fileTsCollision = all.find(
      (m) => m.file !== migration.file && m.fileTs === migration.fileTs,
    );
    if (fileTsCollision) {
      violations.push({
        file: migration.file,
        rule: 'unique-filename-timestamp',
        message:
          `${migration.file}: filename timestamp ${migration.fileTs} collides with ` +
          `${fileTsCollision.file} — ${GENERATE_HINT}.`,
      });
    }

    const nameTsCollision = all.find(
      (m) => m.file !== migration.file && m.nameTs === migration.nameTs,
    );
    if (nameTsCollision) {
      violations.push({
        file: migration.file,
        rule: 'unique-name-timestamp',
        message:
          `${migration.file}: class name timestamp ${migration.nameTs} collides with ` +
          `${nameTsCollision.file} — ${GENERATE_HINT}.`,
      });
    }

    if (migration.fileTs !== migration.nameTs) {
      violations.push({
        file: migration.file,
        rule: 'filename-name-mismatch',
        message:
          `${migration.file}: filename timestamp ${migration.fileTs} does not match the class ` +
          `name timestamp ${migration.nameTs} — TypeORM sorts and matches by the name timestamp, so ` +
          `a mismatch silently mis-sorts this migration — ${GENERATE_HINT}.`,
      });
    }

    const requiredMax = requiredMaxByFile.get(migration.file) ?? baseMax;
    if (Number.isFinite(requiredMax) && !(migration.nameTs > requiredMax)) {
      violations.push({
        file: migration.file,
        rule: 'not-monotonic',
        message:
          `${migration.file}: class name timestamp ${migration.nameTs} does not sort after the ` +
          `latest migration already on the base branch or earlier in this PR (${requiredMax}) — ${GENERATE_HINT}.`,
      });
    }

    if (migration.fileTs % ROUND_TIMESTAMP_DIVISOR === 0) {
      violations.push({
        file: migration.file,
        rule: 'round-timestamp',
        message:
          `${migration.file}: filename timestamp ${migration.fileTs} is a round value (a real ` +
          `Date.now() essentially never lands on a ${ROUND_TIMESTAMP_DIVISOR}-boundary) — ${GENERATE_HINT}.`,
      });
    }

    violations.push(...checkDefaultNamedObjects(migration));
  }

  return violations;
}
