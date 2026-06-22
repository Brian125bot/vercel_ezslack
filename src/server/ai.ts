import { geminiCall } from './agent/geminiClient.js';

export async function generateSimpleResponse(text: string, modelName: string, threadHistory: any[] = []): Promise<string> {
  const contents = [...threadHistory.map(m => ({ role: m.role, parts: [{ text: m.text }] })), { role: 'user', parts: [{ text }] }];

  const responseText = await geminiCall({
    model: modelName,
    contents,
    config: {
      systemInstruction: "You are a helpful Slack AI Agent backend. Keep responses concise and use standard Slack markdown."
    },
    label: 'directReply'
  });

  return responseText || "(Empty response)";
}

