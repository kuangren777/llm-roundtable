import React, { useState, useEffect, useCallback } from 'react';
import { X, Plus, Trash2, Server, Cpu, Check, Edit2, Settings as SettingsIcon, ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import {
  listLLMProviders, addLLMProvider, updateLLMProvider, deleteLLMProvider,
  addLLMModel, updateLLMModel, deleteLLMModel,
  getSystemSetting, setSystemSetting,
} from '../services/api';
import type { LLMProviderResponse, LLMModelResponse } from '../types';

const PROVIDER_PRESETS = [
  { label: 'OpenAI', provider: 'openai', models: ['gpt-4o', 'gpt-4o-mini'] },
  { label: 'Anthropic', provider: 'anthropic', models: ['claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'] },
  { label: 'Gemini', provider: 'gemini', models: ['gemini-2.0-flash', 'gemini-2.5-pro-preview-06-05'] },
  { label: 'DeepSeek', provider: 'deepseek', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { label: 'Groq', provider: 'groq', models: ['llama-3.3-70b-versatile'] },
  { label: 'Ollama', provider: 'ollama', models: ['llama3'] },
];

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onProvidersChange?: () => void;
}

function parseSummaryModelSetting(raw: unknown): { provider_id: number; provider: string; model: string } | null {
  if (!raw) return null;
  try {
    let parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as { provider_id?: unknown; provider?: unknown; model?: unknown };
    if (typeof obj.provider_id !== 'number' || typeof obj.provider !== 'string' || typeof obj.model !== 'string') {
      return null;
    }
    return { provider_id: obj.provider_id, provider: obj.provider, model: obj.model };
  } catch {
    return null;
  }
}

export function SettingsModal({ isOpen, onClose, onProvidersChange }: Props) {
  const [providers, setProviders] = useState<LLMProviderResponse[]>([]);
  const [activeTab, setActiveTab] = useState<'providers' | 'models'>('providers');
  const [loading, setLoading] = useState(false);

  // Add provider form
  const [formName, setFormName] = useState('');
  const [formProvider, setFormProvider] = useState('');
  const [formApiKey, setFormApiKey] = useState('');
  const [formBaseUrl, setFormBaseUrl] = useState('');

  // Models tab
  const [selectedProviderId, setSelectedProviderId] = useState<number | null>(null);
  const [newModelName, setNewModelName] = useState('');

  // Inline editing
  const [editingProvider, setEditingProvider] = useState<number | null>(null);
  const [editFields, setEditFields] = useState<{ name: string; api_key: string; base_url: string }>({ name: '', api_key: '', base_url: '' });
  const [editingModel, setEditingModel] = useState<{ providerId: number; modelId: number } | null>(null);
  const [editModelName, setEditModelName] = useState('');

  // Summary model
  const [summaryModel, setSummaryModel] = useState<{ provider_id: number; provider: string; model: string } | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [provs, setting] = await Promise.all([
        listLLMProviders(),
        getSystemSetting('summary_model').catch(() => ({ key: 'summary_model', value: null })),
      ]);
      setProviders(provs);
      setSummaryModel(parseSummaryModelSetting(setting.value));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (isOpen) fetchData(); }, [isOpen, fetchData]);

  const mutate = useCallback(async (fn: () => Promise<unknown>) => {
    await fn();
    const provs = await listLLMProviders();
    setProviders(provs);
    onProvidersChange?.();
  }, [onProvidersChange]);

  const handleAddProvider = async () => {
    if (!formName || !formProvider) return;
    await mutate(async () => {
      const created = await addLLMProvider({
        name: formName, provider: formProvider,
        ...(formApiKey && { api_key: formApiKey }),
        ...(formBaseUrl && { base_url: formBaseUrl }),
      });
      const preset = PROVIDER_PRESETS.find(p => p.provider === formProvider);
      if (preset) {
        for (const m of preset.models) await addLLMModel(created.id, { model: m });
      }
    });
    setFormName(''); setFormProvider(''); setFormApiKey(''); setFormBaseUrl('');
  };

  const handlePresetClick = (preset: typeof PROVIDER_PRESETS[0]) => {
    setFormName(preset.label);
    setFormProvider(preset.provider);
  };

  const startEditProvider = (p: LLMProviderResponse) => {
    setEditingProvider(p.id);
    setEditFields({ name: p.name, api_key: '', base_url: p.base_url || '' });
  };

  const saveEditProvider = async () => {
    if (!editingProvider) return;
    const data: Record<string, unknown> = { name: editFields.name, base_url: editFields.base_url || null };
    if (editFields.api_key) data.api_key = editFields.api_key;
    await mutate(() => updateLLMProvider(editingProvider, data));
    setEditingProvider(null);
  };

  const startEditModel = (providerId: number, m: LLMModelResponse) => {
    setEditingModel({ providerId, modelId: m.id });
    setEditModelName(m.name || m.model);
  };

  const saveEditModel = async () => {
    if (!editingModel) return;
    await mutate(() => updateLLMModel(editingModel.providerId, editingModel.modelId, { name: editModelName }));
    setEditingModel(null);
  };

  const handleAddModel = async () => {
    if (!newModelName || !selectedProviderId) return;
    await mutate(() => addLLMModel(selectedProviderId, { model: newModelName }));
    setNewModelName('');
  };

  const handleSummaryModelChange = async (value: string) => {
    if (!value) return;
    const [pidStr, provider, model] = value.split('::');
    const obj = { provider_id: Number(pidStr), provider, model };
    await setSystemSetting('summary_model', obj);
    setSummaryModel(obj);
  };

  const summaryValue = summaryModel ? `${summaryModel.provider_id}::${summaryModel.provider}::${summaryModel.model}` : '';

  const inputCls = 'w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-violet-500 outline-none';
  const labelCls = 'block text-xs font-medium text-slate-500 mb-1';

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-slate-900 w-full max-w-3xl max-h-[85vh] rounded-2xl shadow-2xl overflow-hidden flex flex-col border border-white/20"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800/50">
          <h3 className="font-bold text-lg text-slate-800 dark:text-slate-100 flex items-center gap-2">
            <SettingsIcon className="w-5 h-5 text-violet-500" />
            Settings
          </h3>
          <button onClick={onClose} className="p-1 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-full transition-colors">
            <X className="w-5 h-5 text-slate-500" />
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Sidebar */}
          <div className="w-48 border-r border-slate-200 dark:border-slate-700 bg-slate-50/30 dark:bg-slate-800/30 p-4 space-y-2">
            {(['providers', 'models'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  activeTab === tab
                    ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300'
                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                {tab === 'providers' ? <Server className="w-4 h-4" /> : <Cpu className="w-4 h-4" />}
                {tab === 'providers' ? 'Providers' : 'Models'}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="flex-1 p-6 overflow-y-auto custom-scrollbar bg-white dark:bg-slate-900">
            {loading && <div className="text-sm text-slate-400 text-center py-8">Loading...</div>}

            {!loading && activeTab === 'providers' && (
              <div className="space-y-6">
                {/* Preset buttons */}
                <div>
                  <label className={labelCls}>Quick Add</label>
                  <div className="flex flex-wrap gap-2">
                    {PROVIDER_PRESETS.map(p => (
                      <button key={p.provider} onClick={() => handlePresetClick(p)}
                        className="px-3 py-1 text-xs rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-violet-50 dark:hover:bg-violet-900/20 hover:border-violet-300 dark:hover:border-violet-700 transition-colors text-slate-600 dark:text-slate-400">
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Add provider form */}
                <div className="border border-dashed border-slate-300 dark:border-slate-600 rounded-xl p-4 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={labelCls}>Name</label>
                      <input type="text" value={formName} onChange={e => setFormName(e.target.value)} placeholder="e.g. OpenAI" className={inputCls} />
                    </div>
                    <div>
                      <label className={labelCls}>Provider Type</label>
                      <input type="text" value={formProvider} onChange={e => setFormProvider(e.target.value)} placeholder="e.g. openai" className={inputCls} />
                    </div>
                    <div>
                      <label className={labelCls}>API Key</label>
                      <input type="password" value={formApiKey} onChange={e => setFormApiKey(e.target.value)} placeholder="Optional" className={inputCls} />
                    </div>
                    <div>
                      <label className={labelCls}>Base URL</label>
                      <input type="text" value={formBaseUrl} onChange={e => setFormBaseUrl(e.target.value)} placeholder="Optional" className={inputCls} />
                    </div>
                  </div>
                  <button onClick={handleAddProvider} disabled={!formName || !formProvider}
                    className="bg-violet-600 hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors">
                    <Plus className="w-4 h-4" /> Add Provider
                  </button>
                </div>

                {/* Provider cards */}
                <div className="space-y-4">
                  {providers.map(provider => (
                    <div key={provider.id} className="border border-slate-200 dark:border-slate-700 rounded-xl p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        {editingProvider === provider.id ? (
                          <input type="text" value={editFields.name} onChange={e => setEditFields({ ...editFields, name: e.target.value })} className={inputCls + ' !w-48'} />
                        ) : (
                          <h4 className="font-semibold text-slate-800 dark:text-slate-100">
                            {provider.name}
                            <span className="ml-2 text-xs text-slate-400 font-normal">{provider.provider}</span>
                          </h4>
                        )}
                        <div className="flex items-center gap-1">
                          {editingProvider === provider.id ? (
                            <button onClick={saveEditProvider} className="text-green-500 hover:bg-green-50 dark:hover:bg-green-900/20 p-1.5 rounded-lg transition-colors">
                              <Check className="w-4 h-4" />
                            </button>
                          ) : (
                            <button onClick={() => startEditProvider(provider)} className="text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 p-1.5 rounded-lg transition-colors">
                              <Edit2 className="w-4 h-4" />
                            </button>
                          )}
                          <button onClick={() => mutate(() => deleteLLMProvider(provider.id))}
                            className="text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 p-1.5 rounded-lg transition-colors">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                      {editingProvider === provider.id && (
                        <div className="grid grid-cols-1 gap-3">
                          <div>
                            <label className={labelCls}>API Key {provider.has_api_key && '(set - leave blank to keep)'}</label>
                            <input type="password" value={editFields.api_key} onChange={e => setEditFields({ ...editFields, api_key: e.target.value })} className={inputCls} />
                          </div>
                          <div>
                            <label className={labelCls}>Base URL</label>
                            <input type="text" value={editFields.base_url} onChange={e => setEditFields({ ...editFields, base_url: e.target.value })} className={inputCls} />
                          </div>
                        </div>
                      )}
                      <div className="flex flex-wrap gap-1.5">
                        {provider.models.map(m => (
                          <span key={m.id} className="text-xs bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 px-2 py-0.5 rounded-md">
                            {m.name || m.model}
                          </span>
                        ))}
                        {provider.models.length === 0 && <span className="text-xs text-slate-400 italic">No models</span>}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Summary model */}
                <div className="border border-slate-200 dark:border-slate-700 rounded-xl p-4 space-y-2">
                  <label className={labelCls}>Summary Model</label>
                  <div className="relative">
                    <select value={summaryValue} onChange={e => handleSummaryModelChange(e.target.value)}
                      className={inputCls + ' appearance-none pr-8'}>
                      <option value="">Select summary model</option>
                      {providers.map(p => p.models.map(m => (
                        <option key={`${p.id}-${m.id}`} value={`${p.id}::${p.provider}::${m.model}`}>
                          {p.name} / {m.name || m.model}
                        </option>
                      )))}
                    </select>
                    <ChevronDown className="w-4 h-4 absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                  </div>
                </div>
              </div>
            )}

            {!loading && activeTab === 'models' && (
              <div className="space-y-6">
                <div className="flex gap-2">
                  <div className="relative">
                    <select value={selectedProviderId ?? ''} onChange={e => setSelectedProviderId(Number(e.target.value) || null)}
                      className="bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-4 py-2 text-sm focus:ring-2 focus:ring-violet-500 outline-none appearance-none pr-8">
                      <option value="" disabled>Select Provider</option>
                      {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                    <ChevronDown className="w-4 h-4 absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                  </div>
                  <input type="text" value={newModelName} onChange={e => setNewModelName(e.target.value)}
                    placeholder="Model ID (e.g. gpt-4o)" className={'flex-1 ' + inputCls} />
                  <button onClick={handleAddModel} disabled={!selectedProviderId || !newModelName}
                    className="bg-violet-600 hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-colors">
                    <Plus className="w-4 h-4" /> Add
                  </button>
                </div>

                <div className="space-y-6">
                  {providers.map(provider => (
                    <div key={provider.id}>
                      <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">{provider.name}</h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {provider.models.map(model => (
                          <div key={model.id} className="flex items-center justify-between bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2">
                            {editingModel?.modelId === model.id ? (
                              <>
                                <input type="text" value={editModelName} onChange={e => setEditModelName(e.target.value)}
                                  className="bg-transparent text-sm flex-1 outline-none mr-2" autoFocus />
                                <button onClick={saveEditModel} className="text-green-500 hover:text-green-600 mr-1"><Check className="w-3.5 h-3.5" /></button>
                              </>
                            ) : (
                              <>
                                <div className="flex-1 min-w-0">
                                  <span className="text-sm text-slate-700 dark:text-slate-300 block truncate">{model.name || model.model}</span>
                                  {model.name && <span className="text-xs text-slate-400 block truncate">{model.model}</span>}
                                </div>
                                <button onClick={() => startEditModel(provider.id, model)} className="text-slate-400 hover:text-violet-500 transition-colors mr-1">
                                  <Edit2 className="w-3.5 h-3.5" />
                                </button>
                              </>
                            )}
                            <button onClick={() => mutate(() => deleteLLMModel(provider.id, model.id))}
                              className="text-slate-400 hover:text-red-500 transition-colors">
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                        {provider.models.length === 0 && (
                          <div className="text-sm text-slate-400 italic">No models configured</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800/50 flex justify-end">
          <button onClick={onClose}
            className="bg-slate-900 dark:bg-white hover:bg-slate-800 dark:hover:bg-slate-200 text-white dark:text-slate-900 px-6 py-2 rounded-xl font-medium shadow-lg shadow-slate-500/20 transition-all transform active:scale-95">
            Done
          </button>
        </div>
      </motion.div>
    </div>
  );
}
