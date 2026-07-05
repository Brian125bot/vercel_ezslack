import { slog } from './log.js';

const MAX_ATTACHMENT_BYTES = parseInt(process.env.MAX_ATTACHMENT_BYTES || `${15 * 1024 * 1024}`); // 15MB default
const MAX_ATTACHMENTS_PER_MESSAGE = parseInt(process.env.MAX_ATTACHMENTS_PER_MESSAGE || '4');
const SUPPORTED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
]);
const DOWNLOAD_TIMEOUT_MS = parseInt(process.env.ATTACHMENT_DOWNLOAD_TIMEOUT_MS || '20000');

// Keep in sync with AgentAttachment in types.ts
export interface AgentAttachment {
  filename: string;
  mimeType: string;
  base64Data: string;
  sizeBytes: number;
  sourceUrl?: string; // Slack's url_private, retained for audit/debug only
}

export interface AttachmentProcessingResult {
  attachments: AgentAttachment[];
  skipped: Array<{ filename: string; reason: string }>;
}

export async function processSlackFiles(
  files: any[] | undefined,
  botToken: string | undefined
): Promise<AttachmentProcessingResult> {
  const result: AttachmentProcessingResult = { attachments: [], skipped: [] };

  if (!files || files.length === 0 || !botToken || botToken.startsWith('xoxb-mock') || botToken.startsWith('mock:')) {
    return result;
  }

  for (const file of files) {
    if (result.attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      result.skipped.push({ filename: file.name, reason: 'exceeded max attachments per message' });
      continue;
    }

    if (!SUPPORTED_MIME_TYPES.has(file.mimetype)) {
      result.skipped.push({ filename: file.name, reason: 'unsupported file type: ' + file.mimetype });
      continue;
    }

    if (file.size > MAX_ATTACHMENT_BYTES) {
      result.skipped.push({ filename: file.name, reason: 'file exceeds ' + MAX_ATTACHMENT_BYTES + ' byte limit' });
      continue;
    }

    try {
      const response = await fetch(file.url_private_download, {
        headers: { Authorization: `Bearer ${botToken}` },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
      });

      if (!response.ok) {
        result.skipped.push({ filename: file.name, reason: 'download failed: ' + response.status });
        continue;
      }

      const arrayBuffer = await response.arrayBuffer();
      const base64Data = Buffer.from(arrayBuffer).toString('base64');

      result.attachments.push({
        filename: file.name,
        mimeType: file.mimetype,
        base64Data,
        sizeBytes: file.size,
        sourceUrl: file.url_private
      });
    } catch (err: any) {
      result.skipped.push({ filename: file.name, reason: 'unexpected error: ' + err.message });
    }
  }

  slog('attachments', 'processed', { total: files.length, accepted: result.attachments.length, skipped: result.skipped.length });

  return result;
}

export function attachmentsToGeminiParts(attachments: AgentAttachment[]): Array<{ inlineData: { mimeType: string; data: string } }> {
  return attachments.map(a => ({
    inlineData: {
      mimeType: a.mimeType,
      data: a.base64Data
    }
  }));
}

// Durable Task Fallback Cache
// Since AgentGoal schema currently lacks a flexible JSON column, we use an in-memory cache keyed by goalId
// to pass attachments from initial creation into the planner loop.
// Note: These attachments will not survive a cold start / run resume.
export const attachmentCache = new Map<string, AgentAttachment[]>();
