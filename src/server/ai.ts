export async function classifyIntent(text: string, model: string, ai: any): Promise<{ intent: string; confidence: string }> {
  try {
    const classificationPrompt = `Analyze the following message and classify its primary intent into exactly one of these categories: [GENERAL_CHITCHAT, TECH_SUPPORT, TASKS_AND_TODO, DATA_ANALYTICS, ADMIN_ALERT].
Message: "${text}"

Respond with EXACTLY a JSON block matching this structure:
{
  "intent": "INTENT_NAME",
  "confidence": "XX%"
}`;
    
    const response = await ai.models.generateContent({
      model: model,
      contents: classificationPrompt,
      config: {
        responseMimeType: 'application/json'
      }
    });
    
    try {
      const parsed = JSON.parse(response.text?.trim() || "{}");
      return {
        intent: parsed.intent || 'GENERAL_CHITCHAT',
        confidence: parsed.confidence || '90%'
      };
    } catch {
      const raw = response.text || '';
      for (const cat of ['GENERAL_CHITCHAT', 'TECH_SUPPORT', 'TASKS_AND_TODO', 'DATA_ANALYTICS', 'ADMIN_ALERT']) {
        if (raw.toUpperCase().includes(cat)) {
          return { intent: cat, confidence: '85%' };
        }
      }
      return { intent: 'GENERAL_CHITCHAT', confidence: '75%' };
    }
  } catch (err) {
    console.warn(`[Intent Routing Warning] Could not classify intent:`, err);
    return { intent: 'GENERAL_CHITCHAT', confidence: 'N/A' };
  }
}
