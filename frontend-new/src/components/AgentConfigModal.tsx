import React, { useState, useEffect } from 'react';
import { X, Lightbulb, Copy, ChevronDown, Search } from 'lucide-react';
import { motion } from 'motion/react';
import type { AgentConfigResponse, LLMProviderResponse } from '../types';
import { updateAgent } from '../services/api';
import { copyTextWithFallback } from '../utils/clipboard';

interface AgentConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  agent: AgentConfigResponse | null;
  discussionId: number | null;
  onSave: (agent: AgentConfigResponse) => void;
  providers: LLMProviderResponse[];
  onCopy?: (text: string) => void | Promise<void>;
}

export function AgentConfigModal({ isOpen, onClose, agent, discussionId, onSave, providers, onCopy }: AgentConfigModalProps) {
  const [name, setName] = useState('');
  const [persona, setPersona] = useState('');
  const [selectedProviderId, setSelectedProviderId] = useState<number | null>(null);
  const [model, setModel] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (agent) {
      setName(agent.name);
      setPersona(agent.persona || '');
      setModel(agent.model);
      // Find matching provider by provider string
      const match = providers.find(p => p.provider === agent.provider || p.name === agent.provider);
      setSelectedProviderId(match?.id ?? null);
    }
  }, [agent, providers]);

  if (!isOpen || !agent) return null;

  const selectedProvider = providers.find(p => p.id === selectedProviderId);
  const models = selectedProvider?.models ?? [];

  const handleSave = async () => {
    if (!discussionId || !selectedProvider) return;
    setSaving(true);
    try {
      const result = await updateAgent(discussionId, agent.id, {
        name,
        persona,
        provider: selectedProvider.provider,
        model,
        provider_id: selectedProvider.id,
      });
      onSave(result);
      onClose();
    } catch (err) {
      console.error('Failed to update agent', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-slate-900 w-full max-w-2xl rounded-2xl shadow-2xl overflow-hidden flex flex-col border border-white/20"
      >
        <div className="flex items-center justify-between p-5 border-b border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800/50">
          <h3 className="font-bold text-lg text-slate-800 dark:text-slate-100">Edit {agent.role === 'host' ? 'Host' : agent.role === 'critic' ? 'Critic' : 'Expert'} Configuration</h3>
          <button onClick={onClose} className="p-1.5 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
            <X className="w-4 h-4 text-slate-500" />
          </button>
        </div>

        <div className="p-6 space-y-6 overflow-y-auto custom-scrollbar">
          <div className={`flex items-center gap-2 font-medium ${
            agent.role === 'host' ? 'text-blue-600 dark:text-blue-400' :
            agent.role === 'critic' ? 'text-orange-600 dark:text-orange-400' :
            'text-violet-600 dark:text-violet-400'
          }`}>
            {agent.role === 'critic' ? <Search className="w-5 h-5" /> : <Lightbulb className="w-5 h-5" />}
            <span>{agent.role === 'host' ? 'Host' : agent.role === 'critic' ? 'Critic' : 'Expert'}</span>
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-violet-500 outline-none"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">Persona</label>
              <button
                onClick={() => {
                  if (onCopy) {
                    void onCopy(persona);
                    return;
                  }
                  void copyTextWithFallback(persona);
                }}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
                title="Copy persona"
              >
                <Copy className="w-4 h-4" />
              </button>
            </div>
            <textarea
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
              className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-violet-500 outline-none min-h-[120px] resize-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">Provider</label>
              <div className="relative">
                <select
                  value={selectedProviderId ?? ''}
                  onChange={(e) => {
                    const pid = Number(e.target.value) || null;
                    setSelectedProviderId(pid);
                    const prov = providers.find(p => p.id === pid);
                    if (prov?.models.length) setModel(prov.models[0].model);
                    else setModel('');
                  }}
                  className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl pl-4 pr-10 py-3 text-sm focus:ring-2 focus:ring-violet-500 outline-none appearance-none"
                >
                  <option value="">Select provider</option>
                  {providers.map(p => (
                    <option key={p.id} value={p.id}>{p.name} ({p.provider})</option>
                  ))}
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
              </div>
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">Model</label>
              <div className="relative">
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl pl-4 pr-10 py-3 text-sm focus:ring-2 focus:ring-violet-500 outline-none appearance-none"
                >
                  {models.length === 0 && <option value="">No models</option>}
                  {models.map(m => (
                    <option key={m.id} value={m.model}>{m.name || m.model}</option>
                  ))}
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
              </div>
            </div>
          </div>
        </div>

        <div className="p-4 border-t border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800/50 flex justify-end">
          <button
            onClick={handleSave}
            disabled={saving || !selectedProvider}
            className="bg-violet-600 hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed text-white px-6 py-2.5 rounded-xl font-medium shadow-lg shadow-violet-500/20 transition-all transform active:scale-95"
          >
            {saving ? 'Saving...' : 'Save Configuration'}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
