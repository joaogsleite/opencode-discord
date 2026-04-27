const MAX_CHUNK_SIZE = 1800;
const MAX_CODE_FENCE_LANGUAGE_LENGTH = 64;

/**
 * Split a message into Discord-safe chunks.
 * @param text - Full message text.
 * @returns Array of message chunks.
 */
export function splitMessage(text: string): string[] {
  if (text.length <= MAX_CHUNK_SIZE) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_CHUNK_SIZE) {
      chunks.push(remaining);
      break;
    }

    const splitAt = findSplitPoint(remaining, MAX_CHUNK_SIZE);
    let chunk = remaining.slice(0, splitAt);
    const blockState = getCodeBlockState(chunk);

    if (blockState.unclosed) {
      chunk += '\n```';
    }

    chunks.push(chunk);
    remaining = remaining.slice(splitAt).trimStart();

    if (blockState.unclosed && remaining.length > 0) {
      remaining = `\`\`\`${formatCodeFenceLanguage(blockState.language)}\n${remaining}`;
    }
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

function findSplitPoint(text: string, maxLength: number): number {
  const paragraphBreak = text.lastIndexOf('\n\n', maxLength);
  if (paragraphBreak > maxLength * 0.5) {
    return paragraphBreak;
  }

  const newline = text.lastIndexOf('\n', maxLength);
  if (newline > maxLength * 0.5) {
    return newline;
  }

  const space = text.lastIndexOf(' ', maxLength);
  if (space > maxLength * 0.5) {
    return space;
  }

  return maxLength;
}

function getCodeBlockState(text: string): { unclosed: boolean; language: string | null } {
  const fences = [...text.matchAll(/```(\w*)/g)];
  if (fences.length % 2 === 0) {
    return { unclosed: false, language: null };
  }

  const language = fences.at(-1)?.[1] ?? null;
  return { unclosed: true, language };
}

function formatCodeFenceLanguage(language: string | null): string {
  if (language && language.length <= MAX_CODE_FENCE_LANGUAGE_LENGTH) {
    return language;
  }

  return '';
}

/**
 * Detect if text contains a markdown table.
 * @param text - Text to check.
 * @returns True when a markdown table structure is detected.
 */
export function detectTable(text: string): boolean {
  const lines = text.split('\n');
  if (lines.length < 3) {
    return false;
  }

  for (let index = 0; index < lines.length - 2; index++) {
    const header = lines[index];
    const separator = lines[index + 1];

    if (header?.trim().startsWith('|') && separator?.match(/^\|[\s\-:|]+\|/)) {
      return true;
    }
  }

  return false;
}

/**
 * Format a history message for Discord replay.
 * @param role - Message role.
 * @param content - Message text content.
 * @returns Formatted Discord message string.
 */
export function formatHistoryMessage(role: string, content: string): string {
  if (role === 'user') {
    const quoted = content
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    return `**User:**\n${quoted}`;
  }

  return `**Assistant:**\n${content}`;
}
