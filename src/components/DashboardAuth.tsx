import { RefreshCw, ArrowRight, Lock, AlertCircle, Settings } from 'lucide-react';

interface DashboardAuthProps {
  authError: string;
  loadingStatus: boolean;
  passwordInput: string;
  setPasswordInput: (val: string) => void;
  onSubmit: (password: string) => void;
}

export function DashboardAuth({ authError, loadingStatus, passwordInput, setPasswordInput, onSubmit }: DashboardAuthProps) {
  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col items-center justify-center font-sans p-6">
      <div className="max-w-md w-full bg-slate-950 border border-slate-800 rounded-2xl p-8 shadow-2xl relative overflow-hidden">
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
              onSubmit(passwordInput);
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
