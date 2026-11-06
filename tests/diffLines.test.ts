import assert from 'node:assert/strict';
import test from 'node:test';
import { changedAndPreviousPaths, parseDiffLines, shiftLineRange } from '../src/diffLines.ts';

test('added head lines, context lines, and multiple hunks are parsed per file', (): void => {
  const delta = parseDiffLines([
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,4 @@',
    ' line1',
    '-old2',
    '+new2',
    '+new3',
    ' line4',
    '@@ -10,2 +11,2 @@',
    ' c1',
    '-old',
    '+new',
    '',
  ].join('\n'));
  const file = delta.get('src/a.ts');
  assert.ok(file);
  assert.equal(file.oldPath, 'src/a.ts');
  assert.equal(file.added, false);
  assert.equal(file.deleted, false);
  assert.deepEqual(file.hunks, [
    { oldStart: 1, oldCount: 3, newStart: 1, newCount: 4 },
    { oldStart: 10, oldCount: 2, newStart: 11, newCount: 2 },
  ]);
  assert.deepEqual([...file.changedHeadLines].sort((a, b) => a - b), [2, 3, 12]);
});

test('a deletion without replacement anchors the adjacent head lines', (): void => {
  const delta = parseDiffLines([
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,1 @@',
    ' keep1',
    '-gone1',
    '-gone2',
    '',
  ].join('\n'));
  const file = delta.get('src/a.ts');
  assert.ok(file);
  assert.deepEqual([...file.changedHeadLines].sort((a, b) => a - b), [1, 2]);
});

test('a leading deletion clamps the before anchor to line 1', (): void => {
  const delta = parseDiffLines([
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,1 @@',
    '-gone',
    ' keep',
    '',
  ].join('\n'));
  assert.deepEqual([...delta.get('src/a.ts')!.changedHeadLines].sort((a, b) => a - b), [1]);
});

test('renames, deletions, additions, and the informational prefix are handled', (): void => {
  const delta = parseDiffLines([
    '# informational: previous head deadbeef is not an ancestor of head',
    'diff --git a/src/old.ts b/src/new.ts',
    '--- a/src/old.ts',
    '+++ b/src/new.ts',
    '@@ -1,1 +1,1 @@',
    '-before',
    '+after',
    'diff --git a/src/gone.ts b/src/gone.ts',
    '--- a/src/gone.ts',
    '+++ /dev/null',
    '@@ -1,1 +0,0 @@',
    '-content',
    'diff --git a/src/made.ts b/src/made.ts',
    '--- /dev/null',
    '+++ b/src/made.ts',
    '@@ -0,0 +1,1 @@',
    '+created',
    '',
  ].join('\n'));
  const renamed = delta.get('src/new.ts');
  assert.ok(renamed);
  assert.equal(renamed.oldPath, 'src/old.ts');
  assert.deepEqual([...renamed.changedHeadLines], [1]);
  const deleted = delta.get('src/gone.ts');
  assert.ok(deleted);
  assert.equal(deleted.deleted, true);
  const added = delta.get('src/made.ts');
  assert.ok(added);
  assert.equal(added.added, true);
  assert.deepEqual([...added.changedHeadLines], [1]);
});

test('shiftLineRange maps previous-head lines before, inside, and after hunks', (): void => {
  const delta = parseDiffLines([
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,5 @@',
    ' keep',
    '+i1',
    '+i2',
    ' keep2',
    ' keep3',
    '@@ -20,1 +22,2 @@',
    '-old',
    '+n1',
    '+n2',
    '',
  ].join('\n'));
  const file = delta.get('src/a.ts');
  assert.ok(file);
  // Inside the first hunk's old range: widened to the hunk's whole new range.
  assert.deepEqual(shiftLineRange(file, 2, 2), { startLine: 1, endLine: 5 });
  // Between the hunks: shifted by +2.
  assert.deepEqual(shiftLineRange(file, 10, 12), { startLine: 12, endLine: 14 });
  // After both hunks: shifted by +3.
  assert.deepEqual(shiftLineRange(file, 30, 31), { startLine: 33, endLine: 34 });
  // A file absent from the delta keeps its coordinates.
  assert.deepEqual(shiftLineRange(null, 7, 9), { startLine: 7, endLine: 9 });
});

test('changedAndPreviousPaths includes rename sources', (): void => {
  assert.deepEqual(
    [...changedAndPreviousPaths([
      { path: 'b.ts', status: 'renamed', previousPath: 'a.ts' },
      { path: 'c.ts', status: 'modified' },
    ])].sort(),
    ['a.ts', 'b.ts', 'c.ts'],
  );
});
