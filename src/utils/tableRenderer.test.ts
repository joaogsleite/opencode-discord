import { describe, expect, it } from 'vitest';
import { BotError, ErrorCode } from './errors.js';
import { renderTableToPng } from './tableRenderer.js';

const pngMagicBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('renderTableToPng', () => {
  it('renders a multi-column markdown table to PNG data', async () => {
    const table = `| Name | Status | Count |
| --- | --- | --- |
| Bot | Running | 3 |
| Worker | Idle | 12 |`;

    const result = await renderTableToPng(table);

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.subarray(0, pngMagicBytes.length)).toEqual(pngMagicBytes);
  });

  it('renders table cells containing special characters to PNG data', async () => {
    const table = `| Input | Output |
| --- | --- |
| Tom & Jerry | <ok> "quoted" |
| Pipe text | A \\| B |`;

    const result = await renderTableToPng(table);

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.subarray(0, pngMagicBytes.length)).toEqual(pngMagicBytes);
  });

  it('throws a structured error for invalid markdown tables', async () => {
    await expect(renderTableToPng('not a table')).rejects.toMatchObject({
      code: ErrorCode.TABLE_RENDER_FAILED,
    });
    await expect(renderTableToPng('not a table')).rejects.toBeInstanceOf(BotError);
  });
});
