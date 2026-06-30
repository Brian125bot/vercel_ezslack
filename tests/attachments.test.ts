import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { processSlackFiles, attachmentsToGeminiParts } from '../src/server/agent/attachments.js';

describe('processSlackFiles', () => {
  const originalEnv = process.env;
  const mockBotToken = 'xoxb-real-token';
  const MAX_ATTACHMENTS_PER_MESSAGE = 4;
  const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.MAX_ATTACHMENTS_PER_MESSAGE = String(MAX_ATTACHMENTS_PER_MESSAGE);
    process.env.MAX_ATTACHMENT_BYTES = String(MAX_ATTACHMENT_BYTES);

    global.fetch = vi.fn();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const createMockFile = (overrides: any = {}) => ({
    id: 'F0001',
    name: 'screenshot.png',
    mimetype: 'image/png',
    size: 102400,
    url_private: 'https://files.slack.com/files-pri/T123-F0001/screenshot.png',
    url_private_download: 'https://files.slack.com/files-pri/T123-F0001/download/screenshot.png',
    ...overrides
  });

  it('returns empty result when files is undefined', async () => {
    const result = await processSlackFiles(undefined, mockBotToken);
    expect(result.attachments).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it('returns empty result when files is an empty array', async () => {
    const result = await processSlackFiles([], mockBotToken);
    expect(result.attachments).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it('returns empty result when botToken is undefined', async () => {
    const result = await processSlackFiles([createMockFile()], undefined);
    expect(result.attachments).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it('returns empty result when botToken starts with "xoxb-mock"', async () => {
    const result = await processSlackFiles([createMockFile()], 'xoxb-mock-token');
    expect(result.attachments).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it('downloads and base64-encodes a supported image file', async () => {
    const mockFile = createMockFile();
    const arrayBuffer = new Uint8Array([1, 2, 3]).buffer;
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => arrayBuffer
    });

    const result = await processSlackFiles([mockFile], mockBotToken);

    expect(global.fetch).toHaveBeenCalledWith(
      mockFile.url_private_download,
      expect.objectContaining({
        headers: { Authorization: `Bearer ${mockBotToken}` }
      })
    );
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].mimeType).toBe('image/png');
    expect(result.attachments[0].base64Data).toBe(Buffer.from(arrayBuffer).toString('base64'));
    expect(result.attachments[0].sizeBytes).toBe(mockFile.size);
    expect(result.skipped).toHaveLength(0);
  });

  it('skips a file with an unsupported mime type without attempting download', async () => {
    const mockFile = createMockFile({ mimetype: 'video/mp4' });
    const result = await processSlackFiles([mockFile], mockBotToken);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.attachments).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain('unsupported file type');
  });

  it('skips a file exceeding MAX_ATTACHMENT_BYTES without attempting download', async () => {
    const mockFile = createMockFile({ size: MAX_ATTACHMENT_BYTES + 1 });
    const result = await processSlackFiles([mockFile], mockBotToken);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.attachments).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain('byte limit');
  });

  it('skips a file when the download request fails (non-ok response)', async () => {
    const mockFile = createMockFile();
    (global.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 403
    });

    const result = await processSlackFiles([mockFile], mockBotToken);

    expect(result.attachments).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain('403');
  });

  it('caps processing at MAX_ATTACHMENTS_PER_MESSAGE and skips the rest', async () => {
    const files = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 2 }, (_, i) => createMockFile({ id: `F000${i}` }));

    const arrayBuffer = new Uint8Array([1]).buffer;
    (global.fetch as any).mockResolvedValue({
      ok: true,
      arrayBuffer: async () => arrayBuffer
    });

    const result = await processSlackFiles(files, mockBotToken);

    expect(result.attachments).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0].reason).toContain('max attachments per message');
    expect(global.fetch).toHaveBeenCalledTimes(MAX_ATTACHMENTS_PER_MESSAGE);
  });

  it('continues processing remaining files when one file throws unexpectedly', async () => {
    const file1 = createMockFile({ id: 'F0001' });
    const file2 = createMockFile({ id: 'F0002' });

    (global.fetch as any).mockRejectedValueOnce(new Error('Network error'));

    const arrayBuffer = new Uint8Array([1]).buffer;
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => arrayBuffer
    });

    const result = await processSlackFiles([file1, file2], mockBotToken);

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].filename).toBe(file2.name);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain('unexpected error: Network error');
  });

});

describe('attachmentsToGeminiParts', () => {
  it('returns an empty array for an empty input', () => {
    expect(attachmentsToGeminiParts([])).toEqual([]);
  });

  it('maps a single attachment to a single inlineData part with correct shape', () => {
    const attachment = {
      filename: 'test.png',
      mimeType: 'image/png',
      base64Data: 'dGVzdA==',
      sizeBytes: 4
    };
    const parts = attachmentsToGeminiParts([attachment]);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({
      inlineData: {
        mimeType: 'image/png',
        data: 'dGVzdA=='
      }
    });
  });

  it('maps multiple attachments to multiple parts in the same order', () => {
    const attachment1 = { filename: '1', mimeType: 'image/png', base64Data: 'a1', sizeBytes: 1 };
    const attachment2 = { filename: '2', mimeType: 'application/pdf', base64Data: 'a2', sizeBytes: 2 };

    const parts = attachmentsToGeminiParts([attachment1, attachment2]);
    expect(parts).toHaveLength(2);
    expect(parts[0].inlineData.data).toBe('a1');
    expect(parts[1].inlineData.data).toBe('a2');
  });
});
