import { linkSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export function writePacketFile(filePath: string, content: string): 'written' | 'unchanged' {
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, content, { mode: 0o600 });
  try {
    linkSync(temp, filePath);
    return 'written';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const existing = readFileSync(filePath, 'utf8');
      if (existing === content) return 'unchanged';
      throw new Error(`Refusing to overwrite different packet data at ${filePath}.`);
    }
    throw error;
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // Temp already moved or removed; only our own temp is ever cleaned.
    }
  }
}
