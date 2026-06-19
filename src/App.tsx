import { useState, useEffect } from 'react';
import { 
  Terminal, 
  Send, 
  RefreshCw, 
  Lock, 
  AlertTriangle, 
  CheckCircle, 
  Layers, 
  Settings, 
  Sliders,
  Eye, 
  Trash2, 
  Cpu, 
  Code, 
  ArrowRight, 
  Sparkles, 
  BookOpen, 
  Clock, 
  Activity, 
  FileText,
  ShieldCheck,
  Hash,
  AlertCircle
} from 'lucide-react';

interface ServerStatus {
  geminiApiKeyConfigured: boolean;
  slackBotTokenConfigured: boolean;
  slackSigningSecretConfigured: boolean;
  appUrl: string;
  selectedModel?: string;
  availableModels?: Array<{ id: string; name: string; description: string }>;
  databaseConfigured: boolean;
  databaseAvailable: boolean;
}

interface SlackEventLog {
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
}

// Custom parser to format Slack's specific markdown flavoring safely
function formatSlackMarkdown(text: string) {
  if (!text) return "";
  
  // Escape HTML to prevent XSS in client preview
  let escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Multiline code blocks: ```code```
  escaped = escaped.replace(/```([\s\S]+?)```/g, '<pre class="bg-slate-900 text-slate-100 p-3 rounded-lg font-mono text-xs my-2 overflow-x-auto select-all border border-slate-700 font-light">$1</pre>');

  // Inline code: `code`
  escaped = escaped.replace(/`([^`\n]+?)`/g, '<code class="bg-slate-100 text-pink-600 dark:bg-slate-800 dark:text-pink-400 font-mono text-xs px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-700">$1</code>');

  // Bold: *text*
  escaped = escaped.replace(/\*([^*]+?)\*/g, '<strong class="font-semibold text-slate-900 dark:text-white">$1</strong>');

  // Italics: _text_
  escaped = escaped.replace(/_([^_]+?)_/g, '<em class="italic text-slate-800 dark:text-slate-200">$1</em>');

  // Strikethrough: ~text~
  escaped = escaped.replace(/~([^~]+?)~/g, '<span class="line-through text-slate-400">$1</span>');

  return (
    <div 
      dangerouslySetInnerHTML={{ __html: escaped }} 
      className="space-y-1 font-sans text-slate-700 dark:text-slate-300 leading-relaxed text-sm whitespace-pre-wrap" 
    />
  );
}

export default function App() {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [logs, setLogs] = useState<SlackEventLog[]>([]);
  const [selectedLog, setSelectedLog] = useState<SlackEventLog | null>(null);
  const [activeTab, setActiveTab] = useState<'simulator' | 'guide' | 'runs'>('simulator');
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [clearingLogs, setClearingLogs] = useState(false);
  const [updatingModel, setUpdatingModel] = useState(false);

  // Agent Runs States
  const [runs, setRuns] = useState<any[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runTrace, setRunTrace] = useState<any>(null);
  const [loadingTrace, setLoadingTrace] = useState(false);
  const [resolvingApprovalId, setResolvingApprovalId] = useState<string | null>(null);

  // Authenticated gateway states
  const [dashboardPassword, setDashboardPassword] = useState<string>(() => localStorage.getItem('dashboard_password') || '');
  const [authRequired, setAuthRequired] = useState<boolean>(false);
  const [passwordInput, setPasswordInput] = useState<string>('');
  const [authError, setAuthError] = useState<string>('');

  // Simulator values
  const [simText, setSimText] = useState('Draft an elevator pitch for a serverless startup using the 5 Whys framework.');
  const [simChannel, setSimChannel] = useState('C061EG9SL');
  const [simUser, setSimUser] = useState('U345ALICE');
  const [simCorruptSignature, setSimCorruptSignature] = useState(false);
  const [simReplayAttack, setSimReplayAttack] = useState(false);
  const [simProgress, setSimProgress] = useState<'idle' | 'sending' | 'success' | 'fail'>('idle');
  const [simResult, setSimResult] = useState<{
    statusCode: number;
    responseBody: string;
    simulatedEventId: string;
    signature: string;
    timestamp: string;
  } | null>(null);

  // Fetch API Status
  const fetchStatus = async (currentPassword?: string) => {
    setLoadingStatus(true);
    const passToUse = currentPassword !== undefined ? currentPassword : dashboardPassword;
    try {
      const headers: HeadersInit = {};
      if (passToUse) {
        headers['Authorization'] = `Bearer ${passToUse}`;
      }
      const res = await fetch('/api/status', { headers });
      
      if (res.status === 401) {
        setAuthRequired(true);
        setStatus(null);
        if (currentPassword !== undefined) {
          setAuthError('Invalid password. Please check your configuration and try again.');
        }
        return;
      }

      const text = await res.text();
      try {
        const data = JSON.parse(text);
        setAuthRequired(false);
        setStatus(data);
        if (currentPassword !== undefined) {
          setDashboardPassword(currentPassword);
          localStorage.setItem('dashboard_password', currentPassword);
          setAuthError('');
        }
      } catch (e) {
        console.warn('API restarting, received non-JSON status');
      }
    } catch (e) {
      console.error('Error fetching API configuration status:', e);
    } finally {
      setLoadingStatus(false);
    }
  };

  // Fetch logs
  const fetchLogs = async () => {
    try {
      const headers: HeadersInit = {};
      if (dashboardPassword) {
        headers['Authorization'] = `Bearer ${dashboardPassword}`;
      }
      const res = await fetch('/api/logs', { headers });
      
      if (res.status === 401) {
        setAuthRequired(true);
        return;
      }

      const text = await res.text();
      try {
        const data = JSON.parse(text);
        if (data && data.logs) {
          setLogs(data.logs);
        }
      } catch (e) {
        console.warn('API restarting, received non-JSON logs payload');
      }
    } catch (e) {
      console.error('Error fetching event logs:', e);
    }
  };

  // Clear logs
  const handleClearLogs = async () => {
    setClearingLogs(true);
    try {
      const headers: HeadersInit = {};
      if (dashboardPassword) {
        headers['Authorization'] = `Bearer ${dashboardPassword}`;
      }
      const res = await fetch('/api/logs/clear', { 
        method: 'POST',
        headers 
      });
      if (res.status === 401) {
        alert('Unauthorized action. Please reauthenticate.');
        setAuthRequired(true);
        return;
      }
      setLogs([]);
      setSelectedLog(null);
    } catch (e) {
      console.error('Error clearing logs:', e);
    } finally {
      setClearingLogs(false);
    }
  };

  const handleSelectModel = async (modelId: string) => {
    setUpdatingModel(true);
    try {
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (dashboardPassword) {
        headers['Authorization'] = `Bearer ${dashboardPassword}`;
      }
      const res = await fetch('/api/model/select', {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: modelId }),
      });

      if (res.status === 401) {
        alert('Unauthorized access. Please reauthenticate.');
        setAuthRequired(true);
        return;
      }

      if (res.ok) {
        await fetchStatus();
      } else {
        const err = await res.json();
        alert(`Failed to set model: ${err.error || 'Unknown error'}`);
      }
    } catch (e) {
      console.error('Error selecting model:', e);
    } finally {
      setUpdatingModel(false);
    }
  };

  // Trigger simulated post
  const triggerSimulation = async () => {
    setSimProgress('sending');
    setSimResult(null);
    try {
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (dashboardPassword) {
        headers['Authorization'] = `Bearer ${dashboardPassword}`;
      }
      const res = await fetch('/api/slack/test', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          text: simText,
          channel: simChannel,
          user: simUser,
          generateInvalidSignature: simCorruptSignature,
          timestampOffsetSeconds: simReplayAttack ? -360 : 0, // -360 seconds (6 minutes) triggers replay blocker
        }),
      });

      if (res.status === 401) {
        alert('Unauthorized simulator access. Please reauthenticate.');
        setAuthRequired(true);
        setSimProgress('fail');
        return;
      }

      if (res.ok) {
        const data = await res.json();
        setSimResult(data);
        setSimProgress('success');
        // Refresh logs immediately
        await fetchLogs();
      } else {
        const text = await res.text();
        setSimResult({
          statusCode: res.status,
          responseBody: text,
          simulatedEventId: '',
          signature: '',
          timestamp: '',
        });
        setSimProgress('fail');
      }
    } catch (e: any) {
      console.error('Simulator failure:', e);
      setSimProgress('fail');
    }
  };

  // Fetch Agent Runs
  const fetchRuns = async () => {
    setLoadingRuns(true);
    try {
      const headers: HeadersInit = {};
      if (dashboardPassword) {
        headers['Authorization'] = `Bearer ${dashboardPassword}`;
      }
      const res = await fetch('/api/agent/runs', { headers });
      if (res.ok) {
        const data = await res.json();
        setRuns(data);
      }
    } catch (e) {
      console.error('Error fetching runs:', e);
    } finally {
      setLoadingRuns(false);
    }
  };

  const fetchRunTrace = async (id: string) => {
    setLoadingTrace(true);
    try {
      const headers: HeadersInit = {};
      if (dashboardPassword) {
        headers['Authorization'] = `Bearer ${dashboardPassword}`;
      }
      const res = await fetch(`/api/agent/runs/${id}`, { headers });
      if (res.ok) {
        const data = await res.json();
        setRunTrace(data);
      }
    } catch (e) {
      console.error('Error fetching run trace:', e);
    } finally {
      setLoadingTrace(false);
    }
  };

  const handleResolveApproval = async (approvalId: string, status: 'approved' | 'rejected') => {
    setResolvingApprovalId(approvalId);
    try {
      const headers: HeadersInit = {
        'Content-Type': 'application/json'
      };
      if (dashboardPassword) {
        headers['Authorization'] = `Bearer ${dashboardPassword}`;
      }
      const res = await fetch(`/api/agent/approvals/${approvalId}/resolve`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ status })
      });
      if (res.ok) {
        if (selectedRunId) {
          await fetchRunTrace(selectedRunId);
        }
      } else {
        const errData = await res.json();
        alert(`Failed to resolve approval: ${errData.error || 'Unknown error'}`);
      }
    } catch (e: any) {
      console.error('Error resolving approval:', e);
      alert(`Error resolving approval: ${e.message || String(e)}`);
    } finally {
      setResolvingApprovalId(null);
    }
  };

  useEffect(() => {
    if (activeTab === 'runs') {
      fetchRuns();
      const interval = setInterval(fetchRuns, 5000);
      return () => clearInterval(interval);
    }
  }, [activeTab, dashboardPassword]);

  useEffect(() => {
    if (selectedRunId) {
      fetchRunTrace(selectedRunId);
    } else {
      setRunTrace(null);
    }
  }, [selectedRunId, dashboardPassword]);

  // Poll status and logs
  useEffect(() => {
    fetchStatus();
    fetchLogs();

    const interval = setInterval(() => {
      fetchLogs();
    }, 3000);

    return () => clearInterval(interval);
  }, [dashboardPassword]);

  if (authRequired) {
    return (
      <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col items-center justify-center font-sans p-6">
        <div className="max-w-md w-full bg-slate-950 border border-slate-800 rounded-2xl p-8 shadow-2xl relative overflow-hidden">
          {/* Decorative glowing backdrops */}
          <div className="absolute top-0 left-1/4 w-32 h-32 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none" />
          <div className="absolute bottom-0 right-1/4 w-32 h-32 bg-pink-500/5 rounded-full blur-3xl pointer-events-none" />

          <div className="flex flex-col items-center text-center relative z-10 font-sans">
            <div className="p-4 bg-indigo-500/10 text-indigo-400 rounded-full mb-5 border border-indigo-500/20 shadow-inner">
              <Lock className="w-8 h-8" id="auth-lock-icon" />
            </div>

            <h1 className="text-xl font-bold tracking-tight text-white mb-2 font-sans">
              Dashboard is Secured
            </h1>
            <p className="text-xs text-slate-400 max-w-sm mb-6 leading-relaxed">
              Administrative actions, log inspections, and event simulators are password protected. Please authenticate to gain dashboard access.
            </p>

            <form 
              onSubmit={(e) => {
                e.preventDefault();
                setAuthError('');
                fetchStatus(passwordInput);
              }}
              className="w-full space-y-4 text-left"
            >
              <div>
                <label className="block text-[10px] uppercase tracking-wider font-bold text-slate-400 mb-1.5 font-sans">
                  Dashboard Access Password
                </label>
                <input 
                  type="password"
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  placeholder="Enter your DASHBOARD_PASSWORD"
                  className="w-full bg-slate-900 border border-slate-800 text-white rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-indigo-500 font-mono transition"
                  required
                  autoFocus
                />
              </div>

              {authError && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs font-sans">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{authError}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={loadingStatus}
                className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium py-3 rounded-xl transition shadow-lg shadow-indigo-600/10 hover:shadow-indigo-600/25 flex items-center justify-center gap-2 text-sm"
              >
                {loadingStatus ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin font-sans" />
                    <span>Verifying...</span>
                  </>
                ) : (
                  <>
                    <span>Unlock Dashboard</span>
                    <ArrowRight className="w-4 h-4 font-sans" />
                  </>
                )}
              </button>
            </form>

            <div className="mt-8 border-t border-slate-800/80 pt-5 w-full text-left font-sans">
              <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1 flex items-center gap-1.5">
                <Settings className="w-3.5 h-3.5" /> Setting Up Credentials
              </h4>
              <p className="text-[11px] text-slate-500 leading-relaxed">
                Configure lock security by adding the <code className="text-slate-300 font-mono bg-slate-900 px-1 py-0.5 rounded text-[10px]">DASHBOARD_PASSWORD</code> variable to your backend environment secrets. If left unconfigured, public access is permitted.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 flex flex-col font-sans transition-colors duration-200">
      {/* Top Banner / Navigation */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-40 shadow-xs">
        <div className="max-w-7xl mx-auto px-6 py-4 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-slate-900 rounded-xl text-white shadow-sm flex items-center justify-center">
              <Cpu className="w-6 h-6 animate-pulse" id="header-logo-icon" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-slate-900 font-sans flex items-center gap-2">
                Slack AI Agent <span className="font-mono text-xs px-2 py-0.5 bg-indigo-50 text-indigo-600 rounded-full font-semibold border border-indigo-200">Express & Gemini</span>
              </h1>
              <p className="text-xs text-slate-500 font-sans">
                Highly scalable serverless Slack backend optimized for Google Cloud Run
              </p>
            </div>
          </div>

          {/* Configuration Status Pills */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {/* Gemini Check */}
            <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border font-medium ${
              status?.geminiApiKeyConfigured 
              ? 'bg-emerald-50 text-emerald-700 border-emerald-200' 
              : 'bg-amber-50 text-amber-700 border-amber-200'
            }`}>
              <div className={`w-1.5 h-1.5 rounded-full ${status?.geminiApiKeyConfigured ? 'bg-emerald-500' : 'bg-amber-400'}`} />
              <span className="font-mono">GEMINI_API_KEY</span>
            </div>

            {/* Slack Token Check */}
            <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border font-medium ${
              status?.slackBotTokenConfigured 
              ? 'bg-emerald-50 text-emerald-700 border-emerald-200' 
              : 'bg-amber-50 text-amber-700 border-amber-200 font-mono'
            }`}>
              <div className={`w-1.5 h-1.5 rounded-full ${status?.slackBotTokenConfigured ? 'bg-emerald-500' : 'bg-amber-400'}`} />
              <span className="font-mono">SLACK_BOT_TOKEN</span>
            </div>

            {/* Slack Signing Secret Check */}
            <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border font-medium ${
              status?.slackSigningSecretConfigured 
              ? 'bg-emerald-50 text-emerald-700 border-emerald-200' 
              : 'bg-slate-50 text-slate-700 border-slate-200'
            }`}>
              <div className={`w-1.5 h-1.5 rounded-full ${status?.slackSigningSecretConfigured ? 'bg-emerald-500' : 'bg-slate-400'}`} />
              <span className="font-mono">SLACK_SIGNING_SECRET</span>
            </div>

            {/* Refresh Status */}
            <button 
              onClick={() => fetchStatus()} 
              disabled={loadingStatus}
              className="p-1.5 text-slate-400 hover:text-slate-600 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition-all flex items-center justify-center"
              title="Refresh configuration status"
              id="refresh-secrets-status"
            >
              <RefreshCw className={`w-4 h-4 ${loadingStatus ? 'animate-spin text-slate-600' : ''}`} />
            </button>

            {/* Lock Session */}
            {dashboardPassword && (
              <button 
                onClick={() => {
                  setDashboardPassword('');
                  localStorage.removeItem('dashboard_password');
                  setAuthRequired(true);
                  setStatus(null);
                }}
                className="p-1.5 text-rose-500 hover:text-white hover:bg-rose-500 bg-rose-50 border border-rose-200 rounded-lg transition-all flex items-center justify-center"
                title="Lock Dashboard Session"
                id="lock-dashboard-session"
              >
                <Lock className="w-4 h-4" />
              </button>
            )}
          </div>

        </div>
      </header>

      {/* Main Body */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-6 py-6 grid grid-cols-1 lg:grid-cols-12 gap-6">

        {/* Left Column: Emulator and Developer Guide (7 cols) */}
        <div className="lg:col-span-7 flex flex-col gap-6">
          
          {/* Tabs header */}
          <div className="bg-white p-1 rounded-xl border border-slate-200 flex gap-1">
            <button
              onClick={() => setActiveTab('simulator')}
              className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 text-sm font-medium rounded-lg transition-all ${
                activeTab === 'simulator' 
                  ? 'bg-slate-900 text-white shadow-xs' 
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
              }`}
              id="tab-simulator"
            >
              <Terminal className="w-4 h-4" />
              Webhook Simulator & Tester
            </button>
            <button
              onClick={() => setActiveTab('guide')}
              className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 text-sm font-medium rounded-lg transition-all ${
                activeTab === 'guide' 
                  ? 'bg-slate-900 text-white shadow-xs' 
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
              }`}
              id="tab-guide"
            >
              <BookOpen className="w-4 h-4" />
              Slack Production Guide
            </button>
            <button
              onClick={() => setActiveTab('runs')}
              className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 text-sm font-medium rounded-lg transition-all ${
                activeTab === 'runs' 
                  ? 'bg-slate-900 text-white shadow-xs' 
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
              }`}
              id="tab-runs"
            >
              <Activity className="w-4 h-4" />
              Agent Runs
            </button>
          </div>

          {/* TAB 1: Webhook Simulator & Tester */}
          {activeTab === 'simulator' && (
            <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs flex flex-col gap-5 transition-all">
              
              <div>
                <div className="flex items-center gap-2">
                  <span className="p-1 bg-indigo-50 text-indigo-600 rounded">
                    <Sliders className="w-4 h-4" />
                  </span>
                  <h2 className="text-lg font-bold text-slate-900">Interactive Webhook Emulator</h2>
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  Draft a message payload and sign it perfectly using HMAC-SHA 256. This fires an internal HTTP request hitting your exact <code className="bg-slate-50 font-mono text-xs px-1 text-slate-700 font-bold border border-slate-200 py-0.5 rounded">/api/slack/events</code> route.
                </p>
              </div>

              {!status?.geminiApiKeyConfigured && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex gap-3 text-amber-900 text-sm">
                  <AlertCircle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
                  <div>
                    <h4 className="font-semibold text-amber-950">GEMINI_API_KEY Missing</h4>
                    <p className="text-xs text-amber-800 mt-0.5">
                      The simulator will still reject requests correctly, but Gemini reasoning calls will return errors. Configure the <code className="font-mono bg-amber-100 font-bold text-amber-900 px-1 rounded">GEMINI_API_KEY</code> in the **Secrets** menu.
                    </p>
                  </div>
                </div>
              )}

              {/* Input: Payload message text */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-slate-600 flex items-center gap-1">
                  <span>Message text (User Prompt to AI Agent)</span>
                </label>
                <textarea
                  value={simText}
                  onChange={(e) => setSimText(e.target.value)}
                  placeholder="e.g. Write a brief summary of standard React 19 server components rules..."
                  className="w-full text-sm p-3 border border-slate-200 rounded-xl bg-slate-50 hover:bg-slate-100 focus:bg-white focus:ring-2 focus:ring-slate-900 outline-none transition-all placeholder:text-slate-400 font-sans min-h-[90px] text-slate-800 resize-y"
                  id="simulator-text-input"
                />
              </div>

              {/* Grid: Channel and User simulation metadata */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-slate-600">Simulated Slack Channel ID</label>
                  <input
                    type="text"
                    value={simChannel}
                    onChange={(e) => setSimChannel(e.target.value)}
                    className="w-full text-sm font-mono p-2.5 border border-slate-200 rounded-lg bg-slate-50 hover:bg-slate-100 focus:bg-white focus:ring-2 focus:ring-slate-900 outline-none transition-all"
                    id="simulator-channel-input"
                  />
                  <span className="text-[10px] text-slate-400">Represents physical Slack channel e.g. <span className="font-mono">#general</span></span>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-slate-600">Simulated User ID</label>
                  <input
                    type="text"
                    value={simUser}
                    onChange={(e) => setSimUser(e.target.value)}
                    className="w-full text-sm font-mono p-2.5 border border-slate-200 rounded-lg bg-slate-50 hover:bg-slate-100 focus:bg-white focus:ring-2 focus:ring-slate-900 outline-none transition-all"
                    id="simulator-user-input"
                  />
                  <span className="text-[10px] text-slate-400">Sender User ID: Bot ignores messages from its own bot ID</span>
                </div>
              </div>

              {/* Cryptographic Controls Options */}
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-3">
                <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center gap-1.5">
                  <Lock className="w-3.5 h-3.5 text-slate-500" />
                  Cryptographic Signature Verification Controls
                </h4>

                <div className="space-y-2">
                  <label className="flex items-start gap-2.5 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={simCorruptSignature}
                      onChange={(e) => {
                        setSimCorruptSignature(e.target.checked);
                        if (e.target.checked) setSimReplayAttack(false);
                      }}
                      className="mt-1 accent-indigo-600 rounded"
                      id="checkbox-corrupt-signature"
                    />
                    <div>
                      <span className="text-xs font-semibold text-slate-700">Corrupt HMAC Request Signature</span>
                      <p className="text-[10px] text-slate-400 leading-normal">
                        Fires the webhook event with a scrambled signature to test the backend's cryptographic tamper defense (expect HTTP 401 response).
                      </p>
                    </div>
                  </label>

                  <label className="flex items-start gap-2.5 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={simReplayAttack}
                      onChange={(e) => {
                        setSimReplayAttack(e.target.checked);
                        if (e.target.checked) setSimCorruptSignature(false);
                      }}
                      className="mt-1 accent-indigo-600 rounded"
                      id="checkbox-replay-attack"
                    />
                    <div>
                      <span className="text-xs font-semibold text-slate-700">Simulate Replay Attack (Mismatched Timestamp)</span>
                      <p className="text-[10px] text-slate-400 leading-normal">
                        Pushes the timestamp header back by 6 minutes, violating the 5-minute Slack timing protection window (expect HTTP 401 response).
                      </p>
                    </div>
                  </label>
                </div>
              </div>

              {/* Submit Trigger Webhook Button */}
              <button
                onClick={triggerSimulation}
                disabled={simProgress === 'sending'}
                className="w-full py-3.5 px-4 bg-slate-900 hover:bg-slate-800 text-white font-medium rounded-xl text-sm transition-all flex items-center justify-center gap-2 cursor-pointer disabled:bg-slate-400 shadow-sm"
                id="btn-fire-simulation"
              >
                {simProgress === 'sending' ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Preserving Buffer & Verifying HMAC...
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4" />
                    Dispatch Webhook Event
                  </>
                )}
              </button>

              {/* Simulation Result Log Panel */}
              {simResult && (
                <div className={`rounded-xl border p-4 font-mono text-xs transition-all ${
                  simResult.statusCode === 200 
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-900' 
                    : 'bg-rose-50 border-rose-200 text-rose-900'
                }`}>
                  <div className="flex items-center justify-between border-b border-emerald-200/50 dark:border-rose-200/50 pb-2 mb-2 font-bold font-sans">
                    <span className="flex items-center gap-1">
                      {simResult.statusCode === 200 ? '✅ Slack Handshake Succeeded' : '❌ Pipeline Response Rejected'}
                    </span>
                    <span className={`px-2 py-0.5 rounded text-[10px] ${simResult.statusCode === 200 ? 'bg-emerald-100' : 'bg-rose-100'}`}>
                      HTTP {simResult.statusCode}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-2 leading-relaxed">
                    <div>
                      <p className="text-slate-500 font-sans text-[10px]">WEBHOOK TARGET METHOD:</p>
                      <p className="font-semibold">POST /api/slack/events</p>
                    </div>
                    <div>
                      <p className="text-slate-500 font-sans text-[10px]">EVENT_ID PIPELINE:</p>
                      <p className="truncate font-semibold">{simResult.simulatedEventId || 'N/A: Dropped synchronously'}</p>
                    </div>
                    {simResult.signature && (
                      <div className="md:col-span-2">
                        <p className="text-slate-500 font-sans text-[10px]">HMAC SIGNATURE HEADER SENT (x-slack-signature):</p>
                        <p className="break-all bg-white/60 p-1.5 rounded mt-0.5 text-[10px] text-slate-800">{simResult.signature}</p>
                      </div>
                    )}
                    {simResult.timestamp && (
                      <div>
                        <p className="text-slate-500 font-sans text-[10px]">TIME HEADER (x-slack-request-timestamp):</p>
                        <p className="font-semibold">{simResult.timestamp} ({new Date(parseInt(simResult.timestamp, 10) * 1000).toLocaleTimeString()})</p>
                      </div>
                    )}
                    <div>
                      <p className="text-slate-500 font-sans text-[10px]">ENDPOINT BODY RESPONSE:</p>
                      <p className="font-semibold text-slate-800 bg-white/45 px-2 py-0.5 rounded inline-block truncate max-w-full">
                        "{simResult.responseBody}"
                      </p>
                    </div>
                  </div>
                </div>
              )}

            </div>
          )}

          {/* TAB 2: Slack Production Guide */}
          {activeTab === 'guide' && (
            <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs flex flex-col gap-5 transition-all">
              <div>
                <div className="flex items-center gap-2">
                  <span className="p-1 bg-slate-100 text-slate-700 rounded">
                    <BookOpen className="w-5 h-5" />
                  </span>
                  <h2 className="text-lg font-bold text-slate-900">Cloud Run Integration Instruction Guide</h2>
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  Follow these step-by-step blueprint instructions to connect this serverless stack live with your Slack Workspace.
                </p>
              </div>

              <div className="space-y-4 text-sm text-slate-700">
                <div className="flex gap-3">
                  <div className="w-6 h-6 rounded-full bg-slate-900 text-white font-mono text-xs font-bold flex items-center justify-center shrink-0">1</div>
                  <div className="flex-1">
                    <h4 className="font-semibold text-slate-900">Option A: Create with Slack App Manifest (Fastest!)</h4>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Navigate to the <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer" className="text-indigo-600 font-medium hover:underline">Slack App Console</a>, select <strong>Create New App</strong>, choose <strong>App Manifest</strong>, select your target workspace, and paste the pre-configured JSON configuration block below:
                    </p>
                    
                    <div className="mt-3 bg-slate-905 bg-slate-900 text-slate-200 rounded-xl p-3 border border-slate-800 font-mono text-[11px] relative">
                      <div className="flex items-center justify-between border-b border-slate-800 pb-1.5 mb-2">
                        <span className="text-slate-400 font-sans text-[10px] font-bold">slack-manifest.json</span>
                        <button 
                          onClick={() => {
                            const manifestText = JSON.stringify({
                              "_metadata": {
                                "major_version": 1,
                                "minor_version": 1
                              },
                              "display_information": {
                                "name": "Gemini AI Agent",
                                "description": "Production-ready serverless AI Agent",
                                "background_color": "#0d1117"
                              },
                              "features": {
                                "app_home": {
                                  "home_tab_enabled": false,
                                  "messages_tab_enabled": true,
                                  "messages_tab_read_only_enabled": false
                                },
                                "bot_user": {
                                  "display_name": "Gemini Agent",
                                  "always_online": true
                                }
                              },
                              "oauth_config": {
                                "scopes": {
                                  "bot": [
                                    "app_mention",
                                    "channels:history",
                                    "groups:history",
                                    "im:history",
                                    "chat:write"
                                  ]
                                }
                              },
                              "settings": {
                                "event_subscriptions": {
                                  "request_url": `${status?.appUrl || 'https://YOUR-APP-URL.run.app'}/api/slack/events`,
                                  "bot_events": [
                                    "app_mention",
                                    "message.channels",
                                    "message.groups",
                                    "message.im"
                                  ]
                                },
                                "org_deploy_enabled": false,
                                "socket_mode_enabled": false,
                                "token_rotation_enabled": false
                              }
                            }, null, 2);
                            navigator.clipboard.writeText(manifestText);
                            alert("Copied Slack manifest to clipboard!");
                          }}
                          className="px-2 py-0.5 bg-slate-800 text-slate-300 hover:text-white rounded text-[10px] hover:bg-slate-700 transition"
                          id="btn-copy-manifest-clip"
                        >
                          Copy JSON
                        </button>
                      </div>
                      <pre className="overflow-x-auto whitespace-pre font-light select-all max-h-48 text-[10px]">
{`{
  "_metadata": {
    "major_version": 1,
    "minor_version": 1
  },
  "display_information": {
    "name": "Gemini AI Agent",
    "description": "Production-ready serverless AI Agent",
    "background_color": "#0d1117"
  },
  "features": {
    "app_home": {
      "home_tab_enabled": false,
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "bot_user": {
      "display_name": "Gemini Agent",
      "always_online": true
    }
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "app_mention",
        "channels:history",
        "groups:history",
        "im:history",
        "chat:write"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "request_url": "${status?.appUrl || 'https://YOUR-APP-URL.run.app'}/api/slack/events",
      "bot_events": [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im"
      ]
    },
    "org_deploy_enabled": false,
    "socket_mode_enabled": false,
    "token_rotation_enabled": false
  }
}`}
                      </pre>
                    </div>

                    <h4 className="font-semibold text-slate-900 mt-4 pt-4 border-t border-slate-100">Option B: Create manual app from scratch</h4>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Select <strong>From scratch</strong> in the Slack Dashboard. Provide an app name, bind it to your target workspace, and continue with manual step configuration below.
                    </p>
                  </div>
                </div>

                <div className="flex gap-3 border-t border-slate-100 pt-4">
                  <div className="w-6 h-6 rounded-full bg-slate-900 text-white font-mono text-xs font-bold flex items-center justify-center shrink-0">2</div>
                  <div>
                    <h4 className="font-semibold text-slate-900">Register Secrets in Google Cloud Run / AI Studio</h4>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Retrieve credentials from your Slack Dashboard:
                    </p>
                    <ul className="list-disc list-inside text-xs text-slate-600 mt-1.5 space-y-1">
                      <li>Use <strong className="text-slate-800">Signing Secret</strong> (found under Basic Information) as <code className="font-mono bg-slate-50 px-1 rounded">SLACK_SIGNING_SECRET</code>.</li>
                      <li>Use <strong className="text-slate-800">Bot User OAuth Token</strong> (OAuth & Permissions) as <code className="font-mono bg-slate-50 px-1 rounded">SLACK_BOT_TOKEN</code>.</li>
                    </ul>
                    <p className="text-xs text-slate-400 mt-1.5">
                      Click the "Settings" button inside the AI Studio bar, open the **Secrets** manager panel, and save these values right away.
                    </p>
                  </div>
                </div>

                <div className="flex gap-3 border-t border-slate-100 pt-4">
                  <div className="w-6 h-6 rounded-full bg-slate-900 text-white font-mono text-xs font-bold flex items-center justify-center shrink-0">3</div>
                  <div>
                    <h4 className="font-semibold text-slate-900">Enable Webhook Event Subscriptions</h4>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Inside your Slack developer dashboard, click "Event Subscriptions" and slide the toggle to "Enable Events". Under the URL input, paste your application's public URL appended with the precise events path:
                    </p>
                    <div className="bg-slate-900 text-slate-100 p-2.5 rounded-lg font-mono text-xs my-2 select-all break-all border border-slate-700">
                      {status?.appUrl || 'https://YOUR-APP-URL.run.app'}/api/slack/events
                    </div>
                    <p className="text-xs text-slate-500">
                      Slack issues an instantaneous challenge POST request to verify the route. Thanks to our challenge-response interceptor, your backend handles this verification instantly and resolves green!
                    </p>
                  </div>
                </div>

                <div className="flex gap-3 border-t border-slate-100 pt-4">
                  <div className="w-6 h-6 rounded-full bg-slate-900 text-white font-mono text-xs font-bold flex items-center justify-center shrink-0">4</div>
                  <div>
                    <h4 className="font-semibold text-slate-900">Subscribe Context & Install Bot</h4>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Under "Subscribe to bot events", subscribe to:
                    </p>
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      <span className="font-mono text-[10px] px-2 py-0.5 bg-slate-100 border border-slate-200 rounded">message.channels</span>
                      <span className="font-mono text-[10px] px-2 py-0.5 bg-slate-100 border border-slate-200 rounded">message.groups</span>
                      <span className="font-mono text-[10px] px-2 py-0.5 bg-slate-100 border border-slate-200 rounded">message.im</span>
                      <span className="font-mono text-[10px] px-2 py-0.5 bg-slate-100 border border-slate-200 rounded">app_mention</span>
                    </div>
                    <p className="text-xs text-slate-500 mt-2">
                       Click "Install to Workspace", authorize the agent, and invite the bot to any target Slack channels using <code className="font-mono bg-slate-100 text-slate-800 px-1 py-0.5 rounded">/invite @YourBotName</code>. Now type anything to receive response threads generated using Gemini-2.5-Flash!
                    </p>
                  </div>
                </div>
              </div>

            </div>
          )}

          {/* TAB 3: Agent Runs */}
          {activeTab === 'runs' && (
            <div className="bg-white rounded-2xl border border-slate-200 shadow-xs flex flex-col transition-all overflow-hidden h-[calc(100vh-160px)]">
              <div className="p-4 border-b border-slate-100 flex items-center justify-between shrink-0 bg-slate-50">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-slate-500" />
                  <h2 className="text-sm font-semibold text-slate-800">Agent Runs / Database Status</h2>
                </div>
                {!status?.databaseConfigured ? (
                   <span className="px-2 py-0.5 text-[10px] font-bold uppercase rounded bg-rose-100 text-rose-700">No SQL DB Connected</span>
                ) : !status?.databaseAvailable ? (
                   <span className="px-2 py-0.5 text-[10px] font-bold uppercase rounded bg-amber-100 text-amber-700">DB Offline</span>
                ) : (
                   <span className="px-2 py-0.5 text-[10px] font-bold uppercase rounded bg-emerald-100 text-emerald-700 border border-emerald-200/50 flex gap-1 items-center">
                     <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse border border-emerald-400"></span> DB Connected
                   </span>
                )}
              </div>
              
              {!status?.databaseConfigured && (
                <div className="p-8 text-center text-slate-500">
                  SQL database is not configured. Start the project database by setting <code>DATABASE_URL</code> or <code>CLOUD_SQL_CONNECTION_NAME</code> in the secrets panel.
                </div>
              )}

              {status?.databaseConfigured && status?.databaseAvailable && (
                <div className="flex-1 flex overflow-hidden">
                  {/* Left list */}
                  <div className="w-64 border-r border-slate-100 flex flex-col bg-white overflow-y-auto">
                    {loadingRuns && runs.length === 0 ? (
                      <div className="p-4 text-xs text-slate-400 text-center">Loading runs...</div>
                    ) : runs.length === 0 ? (
                      <div className="p-4 text-xs text-slate-400 text-center">No runs recorded yet.</div>
                    ) : (
                      runs.map((r, i) => (
                        <button 
                          key={r.id || i}
                          onClick={() => setSelectedRunId(r.id)}
                          className={`p-3 text-left border-b border-slate-50 hover:bg-slate-50 transition ${selectedRunId === r.id ? 'bg-indigo-50/50 border-indigo-100' : ''}`}
                        >
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs font-bold font-mono text-slate-700">Run {r.id.substring(0, 8)}</span>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase font-bold
                              ${(r.status === 'completed' || r.status === 'succeeded') ? 'bg-emerald-100 text-emerald-700' : 
                                r.status === 'failed' ? 'bg-rose-100 text-rose-700' : 
                                r.status === 'blocked' ? 'bg-amber-100 text-amber-700' : 
                                'bg-indigo-100 text-indigo-700'}
                            `}>
                              {r.status}
                            </span>
                          </div>
                          <div className="text-[10px] text-slate-400 mt-1 truncate">
                            {new Date(r.created_at).toLocaleString()}
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                  {/* Right trace view */}
                  <div className="flex-1 overflow-y-auto p-4 bg-slate-50/50 pb-8">
                    {selectedRunId ? (
                      loadingTrace ? (
                        <div className="text-xs text-center text-slate-500 pt-8">Loading trace for {selectedRunId.substring(0, 8)}...</div>
                      ) : runTrace ? (
                        <div className="space-y-4">
                          <div className="bg-white p-4 rounded-lg shadow-sm border border-slate-200">
                             <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">Goal Context</h3>
                             <div className="text-sm font-medium text-slate-800">{runTrace.goal?.title || 'Unknown Goal'}</div>
                             <div className="text-xs text-slate-500 mt-1 bg-slate-50 p-2 rounded whitespace-pre-wrap">{runTrace.goal?.original_instruction || 'No original instruction'}</div>
                             
                             {runTrace.run?.result_summary && (
                               <div className="mt-3 pt-3 border-t border-slate-100">
                                 <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Execution Summary</div>
                                 <div className="text-sm text-slate-700 bg-emerald-50 text-emerald-800 border border-emerald-100 p-2.5 rounded-lg">
                                   {runTrace.run.result_summary}
                                 </div>
                               </div>
                             )}
                             {runTrace.run?.failure_reason && (
                               <div className="mt-3 pt-3 border-t border-slate-100">
                                 <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Failure Reason</div>
                                 <div className="text-sm text-rose-700 bg-rose-50 border border-rose-100 p-2.5 rounded-lg">
                                   {runTrace.run.failure_reason}
                                 </div>
                               </div>
                             )}
                          </div>

                          {runTrace.auditEvents?.find((e: any) => e.type === 'run.semantic_verified') && (
                            <div className="bg-white p-4 rounded-lg shadow-sm border border-slate-200 mt-4">
                              <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">Semantic Verification</h3>
                              {(() => {
                                const evt = runTrace.auditEvents.find((e: any) => e.type === 'run.semantic_verified');
                                const semVerify = evt.payload;
                                return (
                                  <div className={`p-3 border rounded-lg ${semVerify.satisfied ? 'bg-emerald-50 border-emerald-100 text-emerald-800' : 'bg-rose-50 border-rose-100 text-rose-800'}`}>
                                    <div className="flex items-center gap-2 mb-1">
                                      <span className="font-bold">{semVerify.satisfied ? 'Satisfied' : 'Not Satisfied'}</span>
                                      <span className="text-xs px-2 py-0.5 rounded-full bg-white bg-opacity-50 border border-current opacity-70">
                                        Confidence: {Math.round(semVerify.confidence * 100)}%
                                      </span>
                                    </div>
                                    <div className="text-sm opacity-90">{semVerify.reasoning}</div>
                                  </div>
                                );
                              })()}
                            </div>
                          )}

                          {runTrace.steps?.length > 0 && (
                            <div>
                               <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest mt-6 mb-3 ml-1">Execution Steps</h3>
                               <div className="space-y-3">
                                 {runTrace.steps.map((step: any) => (
                                   <div key={step.id} className="bg-white p-4 border border-slate-200 rounded-xl shadow-xs text-xs space-y-2">
                                     <div className="flex justify-between items-center pb-2 border-b border-slate-50">
                                       <span className="font-bold text-slate-800">{step.order_index}. {step.title}</span>
                                       <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded
                                         ${step.status === 'succeeded' || step.status === 'completed' ? 'bg-emerald-100 text-emerald-800 border border-emerald-200' :
                                           step.status === 'running' || step.status === 'pending' ? 'bg-indigo-100 text-indigo-800 border border-indigo-200' :
                                           step.status === 'blocked' ? 'bg-amber-100 text-amber-800 border border-amber-200' :
                                           'bg-rose-100 text-rose-800 border border-rose-200'}
                                       `}>
                                         {step.status}
                                       </span>
                                     </div>
                                     {step.description && <p className="text-slate-600 bg-slate-50 p-2 rounded">{step.description}</p>}
                                     {(step.input || step.output) && (
                                        <div className="grid grid-cols-1 gap-2 mt-2">
                                          {step.input && (
                                            <div className="flex flex-col gap-1">
                                              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Input</span>
                                              <pre className="text-[10px] bg-slate-50 p-2 border border-slate-100 rounded text-slate-600 whitespace-pre-wrap font-mono overflow-auto max-h-32">
                                                 {JSON.stringify(step.input, null, 2)}
                                              </pre>
                                            </div>
                                          )}
                                          {step.output && (
                                            <div className="flex flex-col gap-1">
                                              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Output</span>
                                              <pre className="text-[10px] bg-emerald-50 p-2 border border-emerald-100 rounded text-emerald-700 whitespace-pre-wrap font-mono overflow-auto max-h-32">
                                                 {JSON.stringify(step.output, null, 2)}
                                              </pre>
                                            </div>
                                          )}
                                        </div>
                                     )}
                                   </div>
                                 ))}
                               </div>
                            </div>
                          )}

                          {/* Approvals Panel */}
                          {runTrace.approvals?.length > 0 && (
                            <div>
                               <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest mt-6 mb-3 ml-1">Approval Requests</h3>
                               <div className="space-y-3">
                                 {runTrace.approvals.map((app: any) => (
                                   <div key={app.id} className="bg-white p-4 border border-indigo-100 rounded-xl shadow-xs text-xs space-y-3">
                                     <div className="flex justify-between items-center pb-2 border-b border-slate-50">
                                       <span className="font-bold text-slate-800">{app.title}</span>
                                       <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded
                                         ${app.status === 'pending' ? 'bg-amber-100 text-amber-800 border border-amber-200' :
                                           app.status === 'approved' ? 'bg-emerald-100 text-emerald-800 border border-emerald-200' :
                                           'bg-rose-100 text-rose-800 border border-rose-200'}
                                       `}>
                                         {app.status}
                                       </span>
                                     </div>
                                     <p className="text-slate-600 leading-relaxed bg-slate-50 p-2.5 rounded border border-slate-100 whitespace-pre-wrap">{app.description}</p>
                                     <div className="flex items-center gap-2 text-[10px]">
                                       <span className="text-slate-400 uppercase tracking-wider font-semibold">Risk Level:</span>
                                       <span className="font-bold text-rose-600 uppercase font-mono">{app.risk_level}</span>
                                       <span className="text-slate-300">|</span>
                                       <span className="text-slate-400 uppercase tracking-wider font-semibold">Expires:</span>
                                       <span className="text-slate-500 font-mono">{new Date(app.expires_at).toLocaleString()}</span>
                                     </div>
                                     {app.status === 'pending' && (
                                       <div className="flex gap-2 pt-2">
                                         <button
                                           onClick={() => handleResolveApproval(app.id, 'approved')}
                                           disabled={resolvingApprovalId === app.id}
                                           className="flex-1 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white font-bold py-1.5 px-3 rounded-lg text-center transition shadow-xs disabled:opacity-50 cursor-pointer text-xs"
                                         >
                                           {resolvingApprovalId === app.id ? 'Processing...' : '√ Approve Plan'}
                                         </button>
                                         <button
                                           onClick={() => handleResolveApproval(app.id, 'rejected')}
                                           disabled={resolvingApprovalId === app.id}
                                           className="flex-1 bg-white hover:bg-rose-50 border border-slate-200 hover:border-rose-200 text-slate-700 hover:text-rose-700 font-bold py-1.5 px-3 rounded-lg text-center transition shadow-xs disabled:opacity-50 cursor-pointer text-xs"
                                         >
                                           Reject
                                         </button>
                                       </div>
                                     )}
                                   </div>
                                 ))}
                               </div>
                            </div>
                          )}

                          {runTrace.auditEvents?.length > 0 && (
                            <div>
                               <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest mt-6 mb-3 ml-1">Audit Events</h3>
                               <div className="space-y-2">
                                 {runTrace.auditEvents.map((evt: any, i: number) => (
                                   <div key={i} className="bg-white p-3 border border-slate-100 rounded shadow-sm text-xs">
                                     <div className="flex justify-between items-center mb-1 border-b border-slate-50 pb-1">
                                       <span className="font-bold text-slate-700">{evt.type}</span>
                                       <span className="text-slate-400 font-mono text-[10px]">{new Date(evt.created_at).toLocaleTimeString()}</span>
                                     </div>
                                     <div className="text-slate-600 font-medium">{evt.summary}</div>
                                     <pre className="mt-2 text-[10px] text-slate-500 bg-slate-50 p-1.5 rounded overflow-x-auto whitespace-pre-wrap max-h-32">
                                       {JSON.stringify(evt.payload, null, 2)}
                                     </pre>
                                   </div>
                                 ))}
                               </div>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="text-xs text-center text-rose-500 pt-8">Failed to load trace</div>
                      )
                    ) : (
                      <div className="h-full flex items-center justify-center text-xs text-slate-400 font-medium pb-12">
                        Select a run on the left to view database trace
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

        </div>

        {/* Right Column: Event Pipeline logs (5 cols) */}
        <div className="lg:col-span-5 flex flex-col gap-4">

          {/* Active Logic Model Controller */}
          <div className="bg-gradient-to-br from-indigo-950 to-slate-900 border border-slate-800 text-white rounded-2xl p-5 shadow-sm space-y-4 relative overflow-hidden" id="dashboard-model-control-card">
            {/* Decorative soft glow */}
            <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-500/15 rounded-full blur-3xl pointer-events-none" />

            <div className="flex items-center justify-between border-b border-indigo-800/40 pb-3 relative z-10">
              <div className="flex items-center gap-2">
                <span className="p-1.5 bg-indigo-500/20 text-indigo-300 rounded-lg flex items-center justify-center">
                  <Cpu className="w-4 h-4 text-indigo-400 animate-pulse" />
                </span>
                <div>
                  <h3 className="text-sm font-bold text-white font-sans">Active Gemini Model</h3>
                  <p className="text-[10px] text-indigo-200/60 font-sans">Toggle live agentic cognition</p>
                </div>
              </div>
              <span className="text-[9px] font-mono bg-indigo-500/10 border border-indigo-500/30 px-2 py-0.5 rounded text-indigo-300 font-bold uppercase tracking-wide">
                Live Switch
              </span>
            </div>

            <div className="space-y-2 relative z-10">
              <label className="block text-[10px] font-bold text-indigo-300 uppercase tracking-wider font-sans">
                Select Model Engine
              </label>

              <select
                value={status?.selectedModel || 'gemini-3.1-flash-lite'}
                onChange={(e) => handleSelectModel(e.target.value)}
                disabled={updatingModel || loadingStatus}
                className="w-full bg-slate-950/80 border border-indigo-800 text-indigo-200 rounded-xl px-3 py-2.5 text-xs focus:outline-none focus:border-indigo-400 font-sans transition hover:bg-slate-950 cursor-pointer"
                id="dashboard-model-selector"
              >
                {status?.availableModels?.map((opt) => (
                  <option key={opt.id} value={opt.id} className="bg-slate-900 text-slate-100">
                    {opt.name}
                  </option>
                ))}
              </select>
            </div>

            {status?.availableModels && (
              <p className="text-[11px] text-indigo-200/70 leading-relaxed italic border-l-2 border-indigo-500/40 pl-2 font-sans relative z-10">
                {status.availableModels.find(m => m.id === (status.selectedModel || 'gemini-3.1-flash-lite'))?.description}
              </p>
            )}
          </div>
          
          {/* Pipeline Header */}
          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="flex items-center justify-center w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <div>
                <h3 className="text-sm font-bold text-slate-900">Events Logging Pipeline</h3>
                <p className="text-[10px] text-slate-500 leading-none">Auto-refresh active (Polls 3s)</p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {logs.length > 0 && (
                <button
                  onClick={handleClearLogs}
                  disabled={clearingLogs}
                  className="flex items-center gap-1 px-2.5 py-1 text-xs text-slate-500 hover:text-rose-600 hover:bg-rose-50 border border-slate-100 hover:border-rose-100 rounded-lg transition-all"
                  id="btn-clear-logs"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Logs scroll panel */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xs min-h-[300px] flex-1 flex flex-col overflow-hidden max-h-[640px]">
            
            {logs.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-slate-50/50">
                <div className="p-3 bg-white border border-slate-200 rounded-2xl text-slate-400 mb-3 shadow-2xs">
                  <Activity className="w-8 h-8 font-light" />
                </div>
                <h4 className="text-sm font-semibold text-slate-800">No Webhook Events Logged</h4>
                <p className="text-xs text-slate-400 mt-1 max-w-[240px] leading-relaxed">
                  Webhooks received live or issued via the Emulator sandbox will instantly stream here.
                </p>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
                {logs.map((log) => {
                  const isSelected = selectedLog?.id === log.id;
                  let statusBadgeColor = 'bg-slate-100 text-slate-700';
                  if (log.status === 'success') statusBadgeColor = 'bg-emerald-50 text-emerald-700 border border-emerald-100';
                  if (log.status === 'processing') statusBadgeColor = 'bg-blue-50 text-blue-700 border border-blue-100 animate-pulse';
                  if (log.status === 'error') statusBadgeColor = 'bg-rose-50 text-rose-700 border border-rose-100';

                  return (
                    <div 
                      key={log.id} 
                      onClick={() => setSelectedLog(isSelected ? null : log)}
                      className={`p-4 transition-all hover:bg-slate-50/60 cursor-pointer ${
                        isSelected ? 'bg-slate-50' : ''
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="font-mono text-[10px] text-slate-400 flex items-center gap-1">
                          <Clock className="w-3 h-3 text-slate-300" />
                          {new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </span>
                        
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${statusBadgeColor}`}>
                          {log.status === 'success' && 'Processed Threaded'}
                          {log.status === 'processing' && 'Thinking...'}
                          {log.status === 'error' && 'Execution Failed'}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
                        <span className="font-mono text-xs text-slate-700 font-medium truncate shrink-0 max-w-[124px] bg-slate-100 p-0.5 rounded border border-slate-200 flex items-center gap-1">
                          <Hash className="w-3 h-3 text-slate-400" />
                          {log.channel}
                        </span>
                        <span className="text-xs text-slate-400 font-mono">by {log.user}</span>

                        {/* Classified Intent Badge */}
                        {log.intent && (
                          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded flex items-center gap-1 border ${
                            log.intent === 'direct_reply' ? 'bg-slate-50 text-slate-600 border-slate-200/60' :
                            log.intent === 'durable_task' ? 'bg-teal-50 text-teal-600 border-teal-100' :
                            log.intent === 'status_query' ? 'bg-violet-50 text-violet-600 border-violet-100' :
                            log.intent === 'approval_response' ? 'bg-amber-50 text-amber-600 border-amber-100' :
                            log.intent === 'cancel_or_update' ? 'bg-rose-50 text-rose-600 border-rose-100' :
                            log.intent === 'unsafe_or_unsupported' ? 'bg-red-100 text-red-800 border-red-200' :
                            'bg-slate-50 text-slate-600 border-slate-200'
                          }`}>
                            {log.intent} ({log.confidence || 'high'}{log.source ? ` • ${log.source}` : ''})
                          </span>
                        )}

                        {/* Thread Size Context indicator badge */}
                        {log.threadHistoryCount !== undefined && log.threadHistoryCount > 0 && (
                          <span className="text-[10px] font-mono bg-violet-50 text-violet-600 border border-violet-100 px-1.5 py-0.5 rounded">
                            Memory: {log.threadHistoryCount} turns recalled
                          </span>
                        )}
                      </div>

                      <p className="text-slate-800 text-sm font-semibold truncate mt-1">
                        "{log.text}"
                      </p>

                      <div className="flex items-center justify-between mt-2.5 pt-2 border-t border-slate-100/60 text-[10px] text-slate-400">
                        <span className="flex items-center gap-1">
                          {log.signatureVerified ? (
                            <span className="flex items-center gap-1.5 text-emerald-600 font-semibold bg-emerald-50 px-1.5 py-0.5 rounded">
                              <ShieldCheck className="w-3.5 h-3.5" />
                              HMAC Secured
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-amber-600 font-medium bg-amber-50 px-1.5 py-0.5 rounded">
                              <AlertTriangle className="w-3.5 h-3.5" />
                              Sandbox Check
                            </span>
                          )}
                        </span>

                        <span className="text-indigo-600 font-medium hover:underline flex items-center gap-0.5">
                          {isSelected ? 'Collapse details' : 'Inspect raw response'}
                        </span>
                      </div>

                      {/* Expanded Details inside list item */}
                      {isSelected && (
                        <div className="mt-3 bg-white border border-slate-200 rounded-xl p-4 space-y-4 shadow-sm animate-fadeIn" onClick={(e) => e.stopPropagation()}>
                          <div className="space-y-1.5">
                            <h5 className="text-[10px] text-slate-400 uppercase tracking-wider font-bold">Prompt Sent:</h5>
                            <blockquote className="border-l-2 border-indigo-200 pl-3 italic text-xs text-slate-600 py-1 font-sans">
                              "{log.text}"
                            </blockquote>
                          </div>

                          {log.status === 'success' && log.aiResponse && (
                            <div className="space-y-1.5">
                              <div className="flex items-center gap-1.5">
                                <Sparkles className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
                                <h5 className="text-[10px] text-indigo-600 uppercase tracking-wider font-bold">Threaded response from Gemini ({status?.selectedModel || 'gemini-3.1-flash-lite'}):</h5>
                              </div>
                              <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-slate-700">
                                {formatSlackMarkdown(log.aiResponse)}
                              </div>
                            </div>
                          )}

                          {log.status === 'error' && log.error && (
                            <div className="space-y-1.5">
                              <div className="flex items-center gap-1.5 text-rose-600">
                                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                                <h5 className="text-[10px] uppercase tracking-wider font-bold">Error Detail Logged:</h5>
                              </div>
                              <div className="p-3 bg-rose-50 border border-rose-100 rounded-lg text-rose-700 text-xs font-mono break-all leading-normal">
                                {log.error}
                              </div>
                            </div>
                          )}

                          <div className="grid grid-cols-2 gap-3 text-[9px] font-mono leading-tight pt-2.5 border-t border-slate-200 text-slate-500 bg-slate-50/70 p-3 rounded-lg border border-slate-100">
                            <div>
                              <p className="text-slate-400 font-sans font-bold">INTERNAL LOG ID:</p>
                              <p className="font-semibold text-slate-700">{log.id}</p>
                            </div>
                            <div>
                              <p className="text-slate-400 font-sans font-bold">SLACK EVENT ID:</p>
                              <p className="font-semibold text-slate-700 truncate">{log.eventId}</p>
                            </div>
                            <div>
                              <p className="text-slate-400 font-sans font-bold">EVENT TIMESTAMP:</p>
                              <p className="font-semibold text-slate-700">{new Date(log.timestamp).toLocaleString()}</p>
                            </div>
                            <div>
                              <p className="text-slate-400 font-sans font-bold">INTEGRITY STATUS:</p>
                              <p className="font-semibold text-slate-700">
                                {log.signatureVerified ? 'Verified Standard' : 'Sandbox (No Key)'}
                              </p>
                            </div>
                            {log.processingTimeMs !== undefined && (
                              <div>
                                <p className="text-indigo-400 font-sans font-bold">COGNITION LATENCY:</p>
                                <p className="font-bold text-indigo-700">{log.processingTimeMs} ms</p>
                              </div>
                            )}
                            {log.threadKey && (
                              <div className="col-span-2">
                                <p className="text-slate-400 font-sans font-bold">RESOLVED MEMORY THREAD KEY:</p>
                                <p className="font-semibold text-slate-600 truncate">{log.threadKey}</p>
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                    </div>
                  );
                })}
              </div>
            )}

          </div>

        </div>

      </main>

      {/* Slack Integration Handshake Quick Fact Card */}
      <footer className="bg-white border-t border-slate-200 py-4 mt-auto">
        <div className="max-w-7xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-2.5 text-xs text-slate-400">
          <p className="flex items-center gap-1.5">
            <ShieldCheck className="w-4 h-4 text-emerald-500" />
            Express Server is listening on port <span className="font-mono bg-slate-100 font-bold px-1 rounded text-slate-700">3000</span> (Cloud Run auto-ingress).
          </p>
          <p className="font-sans">
            Ready for Google Cloud Run Serverless Deployments.
          </p>
        </div>
      </footer>
    </div>
  );
}
