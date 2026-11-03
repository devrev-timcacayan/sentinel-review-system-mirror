export function parseStrictJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  let index = 0;
  const whitespace = (): void => {
    while (index < text.length && /[ \t\r\n]/.test(text[index])) index += 1;
  };
  const stringEnd = (): number => {
    const start = index;
    index += 1;
    while (index < text.length) {
      if (text[index] === '\\') index += 2;
      else if (text[index++] === '"') return start;
    }
    throw new Error('Unterminated JSON string.');
  };
  const value = (depth: number): void => {
    if (depth > 128) throw new Error('JSON nesting exceeds the safety limit.');
    whitespace();
    if (text[index] === '"') {
      stringEnd();
      return;
    }
    if (text[index] === '{') {
      index += 1;
      whitespace();
      const keys = new Set<string>();
      if (text[index] === '}') { index += 1; return; }
      while (index < text.length) {
        whitespace();
        const start = stringEnd();
        const key = JSON.parse(text.slice(start, index)) as string;
        if (keys.has(key)) throw new Error(`Duplicate JSON object key: ${key}`);
        keys.add(key);
        whitespace();
        index += 1;
        value(depth + 1);
        whitespace();
        if (text[index++] === '}') return;
      }
    } else if (text[index] === '[') {
      index += 1;
      whitespace();
      if (text[index] === ']') { index += 1; return; }
      while (index < text.length) {
        value(depth + 1);
        whitespace();
        if (text[index++] === ']') return;
      }
    } else {
      while (index < text.length && !/[,}\] \t\r\n]/.test(text[index])) index += 1;
    }
  };
  value(0);
  return parsed;
}
