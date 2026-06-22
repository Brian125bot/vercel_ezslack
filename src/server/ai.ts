import { resolveModel } from './agent/models.js';

export async function generateSimpleResponse(text: string, modelName: string, threadHistory: any[] = []): Promise<string> {
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  
  const contents = [...threadHistory.map(m => ({ role: m.role, parts: [{ text: m.text }] })), { role: 'user', parts: [{ text }] }];

  const response = await ai.models.generateContent({
    model: resolveModel(modelName),
    contents,
    config: {
      systemInstruction: "You are a helpful Slack AI Agent backend. Keep responses concise and use standard Slack markdown."
    }
  });

  return response.text || "(Empty response)";
}

