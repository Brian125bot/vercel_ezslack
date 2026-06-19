import { Cpu } from 'lucide-react';
import { ServerStatus } from '../types.js';

interface ModelControlCardProps {
  status: ServerStatus | null;
  updatingModel: boolean;
  loadingStatus: boolean;
  handleSelectModel: (modelId: string) => void;
}

export function ModelControlCard({ status, updatingModel, loadingStatus, handleSelectModel }: ModelControlCardProps) {
  return (
    <div className="bg-gradient-to-br from-indigo-950 to-slate-900 border border-slate-800 text-white rounded-2xl p-5 shadow-sm space-y-4 relative overflow-hidden" id="dashboard-model-control-card">
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
  );
}
