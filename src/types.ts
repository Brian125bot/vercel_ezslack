export interface ServerStatus {
  geminiApiKeyConfigured: boolean;
  slackBotTokenConfigured: boolean;
  slackSigningSecretConfigured: boolean;
  appUrl: string;
  selectedModel?: string;
  availableModels?: Array<{ id: string; name: string; description: string }>;
  dashboardPasswordRequired: boolean;
}

export interface SlackEventLog {
  id: string;
  timestamp: string;
  eventId: string;
  eventType: string;
  channel: string;
  user: string;
  text: string;
  status: 'ignored_bot' | 'ignored_duplicate' | 'error' | 'success' | 'processing';
  signatureVerified: boolean;
  aiResponse?: string;
  error?: string;
  intent?: string;           // Dynamically classified intent
  confidence?: string;       // Confidence score
  processingTimeMs?: number; // Background task latency recording
  threadKey?: string;        // Resolved thread identification key
  threadHistoryCount?: number; // Size of thread history recalled
}

export interface ThreadMessage {
  role: 'user' | 'model';
  text: string;
}
