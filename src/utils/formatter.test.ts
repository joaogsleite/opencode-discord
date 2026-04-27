import { describe, expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import { detectTable, formatHistoryMessage, splitMessage } from './formatter.js';

describe('splitMessage', () => {
  it('returns single chunk for short messages', () => {
    const result = splitMessage('Hello world');

    expect(result).toEqual(['Hello world']);
  });

  it('splits at paragraph boundary near 1800 chars', () => {
    const para1 = 'A'.repeat(1700);
    const para2 = 'B'.repeat(200);
    const text = `${para1}\n\n${para2}`;

    const result = splitMessage(text);

    expect(result.length).toBe(2);
    expect(result[0]).toBe(para1);
    expect(result[1]).toBe(para2);
  });

  it('maintains code block continuity across splits', () => {
    const code = '```typescript\n' + 'x\n'.repeat(300) + '```';

    const result = splitMessage(code);

    for (const chunk of result) {
      const opens = chunk.match(/```/g) ?? [];
      expect(opens.length % 2).toBe(0);
    }
  });

  it('re-opens code block with same language in next chunk', () => {
    const longCode = '```python\n' + 'print("hello")\n'.repeat(200) + '```';

    const result = splitMessage(longCode);

    if (result.length > 1) {
      expect(result[1]).toMatch(/^```python/);
    }
  });

  it('terminates when code fence language exceeds chunk size', async () => {
    const result = await runSplitMessageInWorker('```' + 'a'.repeat(5000) + '\nbody\n```');

    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThan(10);
  });
});

function runSplitMessageInWorker(text: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      `
        import { parentPort, workerData } from 'node:worker_threads';
        import { splitMessage } from ${JSON.stringify(new URL('./formatter.ts', import.meta.url).href)};

        parentPort.postMessage(splitMessage(workerData));
      `,
      { eval: true, workerData: text },
    );
    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(new Error('splitMessage did not terminate'));
    }, 250);

    worker.once('message', (chunks: string[]) => {
      clearTimeout(timeout);
      void worker.terminate();
      resolve(chunks);
    });
    worker.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    worker.once('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Worker exited with code ${code}`));
      }
    });
  });
}

describe('detectTable', () => {
  it('detects a markdown table', () => {
    const table = '| A | B |\n|---|---|\n| 1 | 2 |';

    expect(detectTable(table)).toBe(true);
  });

  it('rejects non-table pipe content', () => {
    expect(detectTable('this | is | not | a table')).toBe(false);
  });

  it('rejects text without separator row', () => {
    expect(detectTable('| A | B |\n| 1 | 2 |')).toBe(false);
  });
});

describe('formatHistoryMessage', () => {
  it('formats user messages with blockquote', () => {
    const result = formatHistoryMessage('user', 'hello');

    expect(result).toBe('**User:**\n> hello');
  });

  it('formats assistant messages without blockquote', () => {
    const result = formatHistoryMessage('assistant', 'response');

    expect(result).toBe('**Assistant:**\nresponse');
  });
});
