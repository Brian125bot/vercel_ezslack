import { geminiCall } from './agent/geminiClient.js';
import { resolveModel } from './agent/models.js';
import { attachmentsToGeminiParts } from './agent/attachments.js';
import type { AgentAttachment } from './agent/types.js';

export async function generateSimpleResponse(
  text: string,
  modelName: string,
  threadHistory: any[] = [],
  attachments: AgentAttachment[] = []
): Promise<string> {
  const userParts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    ...attachmentsToGeminiParts(attachments),
    { text }
  ];

  const contents = [
    ...threadHistory.map(m => {
      let combinedText = m.text || '';
      if (m.attachments && m.attachments.length > 0) {
        const attachNames = m.attachments.map((a: any) => a.filename || 'unknown').join(', ');
        combinedText += `\n[Attached: ${attachNames}]`;
      }
      return {
        role: m.role,
        parts: [{ text: combinedText }]
      };
    }),
    { role: 'user', parts: userParts }
  ];

  const responseText = await geminiCall({
    model: resolveModel(modelName),
    contents,
    config: {
      systemInstruction: "You are a helpful Slack AI Agent backend. Keep responses concise and use standard Slack markdown. When an image or PDF is attached, describe or analyze it directly as part of your answer rather than saying you cannot view attachments."
    },
    label: 'directReply'
  });

  return responseText || "(Empty response)";
}
