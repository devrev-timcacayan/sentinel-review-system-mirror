import type { Change } from './contracts.ts';

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

export interface FileDelta {
  headPath: string;
  oldPath: string;
  added: boolean;
  deleted: boolean;
  hunks: DiffHunk[];
  changedHeadLines: Set<number>;
}

export function changedAndPreviousPaths(changes: Change[]): Set<string> {
  return new Set(changes.flatMap((change): string[] => [
    change.path,
    ...(change.previousPath !== undefined ? [change.previousPath] : []),
  ]));
}

const HUNK_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// Parses a `git diff` style unified diff into per-file head-side deltas. Lines
// outside the diff grammar (for example the `# informational: ...` prefix a
// non-ancestor previous-head delta carries) are ignored. Entries are keyed by
// head path, except deleted files which are keyed by their old path.
export function parseDiffLines(diffText: string): Map<string, FileDelta> {
  const files = new Map<string, FileDelta>();
  const lines = diffText.split('\n');
  let current: FileDelta | null = null;
  let oldPath = '';
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith('--- ')) {
      const old = line.slice(4).trimEnd();
      oldPath = old === '/dev/null' ? '' : old.startsWith('a/') ? old.slice(2) : old;
      index += 1;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const head = line.slice(4).trimEnd();
      if (head === '/dev/null') {
        current = { headPath: oldPath, oldPath, added: false, deleted: true, hunks: [], changedHeadLines: new Set() };
        files.set(oldPath, current);
      } else {
        const headPath = head.startsWith('b/') ? head.slice(2) : head;
        current = { headPath, oldPath, added: oldPath === '', deleted: false, hunks: [], changedHeadLines: new Set() };
        files.set(headPath, current);
      }
      index += 1;
      continue;
    }
    const file = current;
    const hunk = file !== null ? HUNK_PATTERN.exec(line) : null;
    if (hunk === null || file === null) {
      index += 1;
      continue;
    }
    const parsed: DiffHunk = {
      oldStart: Number(hunk[1]),
      oldCount: hunk[2] === undefined ? 1 : Number(hunk[2]),
      newStart: Number(hunk[3]),
      newCount: hunk[4] === undefined ? 1 : Number(hunk[4]),
    };
    file.hunks.push(parsed);
    index += 1;
    let headLine = parsed.newStart;
    let deletionAt = -1;
    const closeDeletion = (replaced: boolean): void => {
      if (deletionAt >= 0 && !replaced) {
        // A deletion with no replacement leaves no head lines to cite; anchor it
        // to the head lines immediately around the removal point.
        file.changedHeadLines.add(Math.max(1, deletionAt - 1));
        file.changedHeadLines.add(deletionAt);
      }
      deletionAt = -1;
    };
    while (index < lines.length) {
      const body = lines[index];
      if (body.startsWith('-')) {
        if (deletionAt < 0) deletionAt = headLine;
        index += 1;
        continue;
      }
      if (body.startsWith('+')) {
        closeDeletion(true);
        file.changedHeadLines.add(headLine);
        headLine += 1;
        index += 1;
        continue;
      }
      if (body.startsWith(' ') || body.startsWith('\\')) {
        closeDeletion(false);
        if (body.startsWith(' ')) headLine += 1;
        index += 1;
        continue;
      }
      break;
    }
    closeDeletion(false);
  }
  return files;
}

// Maps a line range in previous-head (old) coordinates to head coordinates for
// one file delta. A line inside a hunk's old range maps to that hunk's whole
// new range; a line after a hunk shifts by the cumulative newCount - oldCount
// of earlier hunks. Pass null for a file absent from the delta to get the
// range back unchanged.
export function shiftLineRange(
  file: FileDelta | null | undefined,
  startLine: number,
  endLine: number,
): { startLine: number; endLine: number } {
  if (file === null || file === undefined) return { startLine, endLine };
  const mapLine = (line: number): { start: number; end: number } => {
    let shift = 0;
    for (const hunk of file.hunks) {
      if (hunk.oldCount === 0) {
        // Pure insertion: only lines after the insertion point shift.
        if (line <= hunk.oldStart) break;
        shift += hunk.newCount;
        continue;
      }
      const oldEnd = hunk.oldStart + hunk.oldCount - 1;
      if (line < hunk.oldStart) break;
      if (line <= oldEnd) {
        return { start: hunk.newStart, end: Math.max(hunk.newStart, hunk.newStart + hunk.newCount - 1) };
      }
      shift += hunk.newCount - hunk.oldCount;
    }
    const mapped = line + shift;
    return { start: mapped, end: mapped };
  };
  const start = mapLine(startLine);
  const end = mapLine(endLine);
  return { startLine: start.start, endLine: end.end };
}
