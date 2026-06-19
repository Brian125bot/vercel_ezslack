import { Cpu, RefreshCw, Lock } from 'lucide-react';
import { ServerStatus } from '../types.js';

interface HeaderProps {
  status: ServerStatus | null;
  loadingStatus: boolean;
  dashboardPassword: string;
  fetchStatus: () => void;
  onLockSession: () => void;
}

export function Header({ status, loadingStatus, dashboardPassword, fetchStatus, onLockSession }: HeaderProps) {
  return (
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

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border font-medium ${
            status?.geminiApiKeyConfigured 
            ? 'bg-emerald-50 text-emerald-700 border-emerald-200' 
            : 'bg-amber-50 text-amber-700 border-amber-200'
          }`}>
            <div className={`w-1.5 h-1.5 rounded-full ${status?.geminiApiKeyConfigured ? 'bg-emerald-500' : 'bg-amber-400'}`} />
            <span className="font-mono">GEMINI_API_KEY</span>
          </div>

          <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border font-medium ${
            status?.slackBotTokenConfigured 
            ? 'bg-emerald-50 text-emerald-700 border-emerald-200' 
            : 'bg-amber-50 text-amber-700 border-amber-200 font-mono'
          }`}>
            <div className={`w-1.5 h-1.5 rounded-full ${status?.slackBotTokenConfigured ? 'bg-emerald-500' : 'bg-amber-400'}`} />
            <span className="font-mono">SLACK_BOT_TOKEN</span>
          </div>

          <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border font-medium ${
            status?.slackSigningSecretConfigured 
            ? 'bg-emerald-50 text-emerald-700 border-emerald-200' 
            : 'bg-slate-50 text-slate-700 border-slate-200'
          }`}>
            <div className={`w-1.5 h-1.5 rounded-full ${status?.slackSigningSecretConfigured ? 'bg-emerald-500' : 'bg-slate-400'}`} />
            <span className="font-mono">SLACK_SIGNING_SECRET</span>
          </div>

          <button 
            onClick={() => fetchStatus()} 
            disabled={loadingStatus}
            className="p-1.5 text-slate-400 hover:text-slate-600 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition-all flex items-center justify-center"
            title="Refresh configuration status"
            id="refresh-secrets-status"
          >
            <RefreshCw className={`w-4 h-4 ${loadingStatus ? 'animate-spin text-slate-600' : ''}`} />
          </button>

          {dashboardPassword && (
            <button 
              onClick={onLockSession}
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
  );
}
