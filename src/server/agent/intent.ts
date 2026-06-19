import { classifyIntent as generateIntent } from '../ai.js';

export type IntentCategory = 
  | 'direct_reply'
  | 'durable_task'
  | 'status_query'
  | 'approval_response'
  | 'cancel_or_update'
  | 'unsafe_or_unsupported';

export async function classifyIntent(text: string, selectedModel: string, ai?: any): Promise<IntentCategory> {
  const lowercase = text.toLowerCase();
  
  // Heuristic overrides
  const approvalWords = ['approve', 'reject', 'cancel', 'stop', 'resume'];
  if (approvalWords.some(w => lowercase.startsWith(w) || lowercase === w)) {
    return 'approval_response';
  }

  const durableWords = ['remind', 'schedule', 'create', 'track', 'watch', 'follow up', 'summarize this thread', 'draft', 'investigate', 'open a task', 'notify me'];
  if (durableWords.some(w => lowercase.includes(w))) {
    return 'durable_task';
  }

  if (text.length < 15) {
    return 'direct_reply'; // very short
  }

  // Fallback to LLM
  if (!ai) {
    const { GoogleGenAI } = await import('@google/genai');
    ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  try {
    const { intent: rawIntent } = await generateIntent(text, selectedModel, ai);
    switch (rawIntent) {
      case 'GENERAL_CHITCHAT': return 'direct_reply';
      case 'TECH_SUPPORT': 
        if (text.includes('fix') || text.includes('investigate')) return 'durable_task';
        return 'direct_reply';
      case 'TASKS_AND_TODO': return 'durable_task';
      case 'DATA_ANALYTICS': 
        if (text.includes('report') || text.includes('analyze')) return 'durable_task';
        return 'direct_reply';
      case 'ADMIN_ALERT': return 'durable_task';
      default: return 'direct_reply';
    }
  } catch (err) {
    console.error('Intent classification failed:', err);
    return 'direct_reply';
  }
}
