import { describe, expect, it } from 'vitest';
import { parseGitDiff, type JobDiffNumstatEntry } from './job-diff';

const RAW_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index 111111..222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 line1
+added1
 line2
 line3
@@ -10,3 +11,4 @@
 line10
+added2
 line11
 line12
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+hello
+world
diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 444444..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-bye
-world
diff --git a/src/renamed-from.ts b/src/renamed-to.ts
similarity index 90%
rename from src/renamed-from.ts
rename to src/renamed-to.ts
index 555555..666666 100644
--- a/src/renamed-from.ts
+++ b/src/renamed-to.ts
@@ -1,2 +1,2 @@
-old content
+new content
 unchanged
diff --git a/src/image.png b/src/image.png
index 777777..888888 100644
Binary files a/src/image.png and b/src/image.png differ
`;

const NUMSTAT: JobDiffNumstatEntry[] = [
  { path: 'src/foo.ts', additions: 2, deletions: 0, binary: false },
  { path: 'src/new.ts', additions: 2, deletions: 0, binary: false },
  { path: 'src/old.ts', additions: 0, deletions: 2, binary: false },
  { path: 'src/renamed-to.ts', additions: 1, deletions: 1, binary: false },
  { path: 'src/image.png', additions: 0, deletions: 0, binary: true },
];

describe('parseGitDiff', () => {
  it('parses a modified file with two hunks and real line offsets', () => {
    const result = parseGitDiff(RAW_DIFF, NUMSTAT, { maxBytes: 2_000_000 });
    const file = result.files.find((f) => f.path === 'src/foo.ts');
    expect(file).toBeDefined();
    expect(file?.status).toBe('modified');
    expect(file?.additions).toBe(2);
    expect(file?.deletions).toBe(0);
    expect(file?.hunks).toHaveLength(2);
    expect(file?.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4 });
    expect(file?.hunks[1]).toMatchObject({ oldStart: 10, oldLines: 3, newStart: 11, newLines: 4 });
    expect(result.truncated).toBe(false);
  });

  it('treats a /dev/null old side as an added file', () => {
    const result = parseGitDiff(RAW_DIFF, NUMSTAT, { maxBytes: 2_000_000 });
    const file = result.files.find((f) => f.path === 'src/new.ts');
    expect(file?.status).toBe('added');
    expect(file?.additions).toBe(2);
    expect(file?.hunks).toHaveLength(1);
  });

  it('treats a /dev/null new side as a deleted file', () => {
    const result = parseGitDiff(RAW_DIFF, NUMSTAT, { maxBytes: 2_000_000 });
    const file = result.files.find((f) => f.path === 'src/old.ts');
    expect(file?.status).toBe('deleted');
    expect(file?.deletions).toBe(2);
    expect(file?.hunks).toHaveLength(1);
  });

  it('detects a rename by differing old/new paths', () => {
    const result = parseGitDiff(RAW_DIFF, NUMSTAT, { maxBytes: 2_000_000 });
    const file = result.files.find((f) => f.path === 'src/renamed-to.ts');
    expect(file?.status).toBe('renamed');
    expect(file?.oldPath).toBe('src/renamed-from.ts');
    expect(file?.additions).toBe(1);
    expect(file?.deletions).toBe(1);
  });

  it('marks a numstat-binary file as binary with no hunks', () => {
    const result = parseGitDiff(RAW_DIFF, NUMSTAT, { maxBytes: 2_000_000 });
    const file = result.files.find((f) => f.path === 'src/image.png');
    expect(file?.binary).toBe(true);
    expect(file?.hunks).toEqual([]);
  });

  it('truncates when the raw diff exceeds maxBytes, dropping hunks but keeping status/counts', () => {
    const result = parseGitDiff(RAW_DIFF, NUMSTAT, { maxBytes: 10 });
    expect(result.truncated).toBe(true);
    expect(result.files.length).toBeGreaterThan(0);
    for (const file of result.files) {
      expect(file.hunks).toEqual([]);
    }
    const modified = result.files.find((f) => f.path === 'src/foo.ts');
    expect(modified?.status).toBe('modified');
    expect(modified?.additions).toBe(2);
  });
});
