import React, { useState, useEffect, useRef, useCallback } from 'react';
import { X, FileText, Search, Paperclip, ArrowRight, ArrowLeft, Check, Plus, Trash2, Loader2 } from 'lucide-react';
import { motion } from 'motion/react';
import type { DiscussionMode, AgentRole, DiscussionResponse, MaterialResponse, LLMProviderResponse, AgentConfigCreate } from '../types';
import { createDiscussion, uploadToLibrary, listLibraryMaterials, pasteTextMaterial, attachMaterialsToDiscussion, listLLMProviders } from '../services/api';

const MODE_OPTIONS: { value: DiscussionMode; label: string; desc: string }[] = [
  { value: 'auto', label: 'Auto', desc: 'LLM analyzes topic and generates optimal expert combination' },
  { value: 'debate', label: 'Debate', desc: 'Pro vs Con + Moderator' },
  { value: 'brainstorm', label: 'Brainstorm', desc: 'Multi-angle creative divergence + Critic convergence' },
  { value: 'sequential', label: 'Sequential', desc: 'Sequential review, each builds on previous' },
  { value: 'custom', label: 'Custom', desc: 'Manually define each agent' },
];

const ROLE_OPTIONS: AgentRole[] = ['host', 'panelist', 'critic'];

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onCreated?: (discussion: DiscussionResponse) => void;
}

export function NewDebateModal({ isOpen, onClose, onCreated }: Props) {
  // Step control
  const [step, setStep] = useState<1 | 2>(1);

  // Step 1 state
  const [topic, setTopic] = useState('');
  const [activeTab, setActiveTab] = useState<'upload' | 'paste' | 'library'>('upload');
  const [pasteContent, setPasteContent] = useState('');
  const [librarySearch, setLibrarySearch] = useState('');
  const [selectedMaterialIds, setSelectedMaterialIds] = useState<number[]>([]);
  const [libraryItems, setLibraryItems] = useState<MaterialResponse[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Step 2 state
  const [mode, setMode] = useState<DiscussionMode>('auto');
  const [maxRounds, setMaxRounds] = useState(3);
  const [providers, setProviders] = useState<LLMProviderResponse[]>([]);
  const [selectedModelIds, setSelectedModelIds] = useState<number[]>([]);
  const [hostModelId, setHostModelId] = useState<number | undefined>();
  const [customAgents, setCustomAgents] = useState<AgentConfigCreate[]>([
    { name: 'Host', role: 'host', persona: '', provider: '', model: '' },
    { name: 'Panelist 1', role: 'panelist', persona: '', provider: '', model: '' },
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Load library materials
  const loadLibrary = useCallback(async () => {
    try {
      const items = await listLibraryMaterials();
      setLibraryItems(items);
      return items;
    } catch { return []; }
  }, []);

  // Poll library while any item is processing
  useEffect(() => {
    if (!isOpen || activeTab !== 'library') return;
    loadLibrary();
    const interval = setInterval(async () => {
      const items = await loadLibrary();
      if (!items.some(i => i.status === 'processing')) clearInterval(interval);
    }, 2000);
    return () => clearInterval(interval);
  }, [isOpen, activeTab, loadLibrary]);

  // Load providers when entering step 2
  useEffect(() => {
    if (step === 2) {
      listLLMProviders().then(setProviders).catch(() => {});
    }
  }, [step]);

  // Reset on close
  useEffect(() => {
    if (!isOpen) {
      setStep(1);
      setTopic('');
      setActiveTab('upload');
      setPasteContent('');
      setSelectedMaterialIds([]);
      setMode('auto');
      setMaxRounds(3);
      setSelectedModelIds([]);
      setHostModelId(undefined);
      setError('');
    }
  }, [isOpen]);

  const toggleMaterial = (id: number) => {
    setSelectedMaterialIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const toggleModel = (id: number) => {
    setSelectedModelIds(prev => {
      const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id];
      if (hostModelId && !next.includes(hostModelId)) setHostModelId(undefined);
      return next;
    });
  };

  // Upload files to library, auto-select
  const handleUploadFiles = async (files: FileList | File[]) => {
    const arr = Array.from(files);
    if (!arr.length) return;
    setUploading(true);
    try {
      const uploaded = await uploadToLibrary(arr);
      setSelectedMaterialIds(prev => [...prev, ...uploaded.map(m => m.id)]);
      setActiveTab('library');
      await loadLibrary();
    } catch { setError('Upload failed'); }
    setUploading(false);
  };

  // Paste text to library, auto-select
  const handleSavePaste = async () => {
    if (!pasteContent.trim()) return;
    setUploading(true);
    try {
      const item = await pasteTextMaterial(pasteContent);
      setSelectedMaterialIds(prev => [...prev, item.id]);
      setPasteContent('');
      setActiveTab('library');
      await loadLibrary();
    } catch { setError('Paste failed'); }
    setUploading(false);
  };

  // Submit discussion
  const handleSubmit = async () => {
    if (!topic.trim()) return;
    setSubmitting(true);
    setError('');
    try {
      const payload: Parameters<typeof createDiscussion>[0] = { topic, mode, max_rounds: maxRounds };
      if (mode === 'custom') {
        payload.agents = customAgents;
      } else {
        if (selectedModelIds.length) payload.selected_model_ids = selectedModelIds;
        if (hostModelId) payload.host_model_id = hostModelId;
      }
      const discussion = await createDiscussion(payload);
      if (selectedMaterialIds.length) {
        await attachMaterialsToDiscussion(discussion.id, selectedMaterialIds);
      }
      onCreated?.(discussion);
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Creation failed');
    }
    setSubmitting(false);
  };

  const updateAgent = (idx: number, patch: Partial<AgentConfigCreate>) => {
    setCustomAgents(prev => prev.map((a, i) => i === idx ? { ...a, ...patch } : a));
  };

  const filteredLibrary = libraryItems.filter(item =>
    !librarySearch || item.filename.toLowerCase().includes(librarySearch.toLowerCase()) ||
    (item.text_preview || '').toLowerCase().includes(librarySearch.toLowerCase())
  );

  const selectedModels = providers.flatMap(p => p.models).filter(m => selectedModelIds.includes(m.id));

  if (!isOpen) return null;

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
        className="bg-white dark:bg-slate-900 w-full max-w-4xl max-h-[90vh] rounded-2xl shadow-2xl overflow-hidden flex flex-col border border-white/20"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-slate-200 dark:border-slate-700">
          <h2 className="text-2xl font-bold text-slate-900 dark:text-white">
            {step === 1 ? 'Start New Debate' : 'Configure Debate'}
          </h2>
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-400">Step {step}/2</span>
            <button onClick={onClose} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full transition-colors">
              <X className="w-6 h-6 text-slate-500" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-8 space-y-8 custom-scrollbar">
          {step === 1 ? <Step1Content
            topic={topic} setTopic={setTopic}
            activeTab={activeTab} setActiveTab={setActiveTab}
            pasteContent={pasteContent} setPasteContent={setPasteContent}
            librarySearch={librarySearch} setLibrarySearch={setLibrarySearch}
            selectedMaterialIds={selectedMaterialIds} toggleMaterial={toggleMaterial}
            filteredLibrary={filteredLibrary}
            uploading={uploading}
            handleUploadFiles={handleUploadFiles}
            handleSavePaste={handleSavePaste}
            fileInputRef={fileInputRef}
          /> : <Step2Content
            mode={mode} setMode={setMode}
            maxRounds={maxRounds} setMaxRounds={setMaxRounds}
            providers={providers}
            selectedModelIds={selectedModelIds} toggleModel={toggleModel}
            hostModelId={hostModelId} setHostModelId={setHostModelId}
            selectedModels={selectedModels}
            customAgents={customAgents} setCustomAgents={setCustomAgents}
            updateAgent={updateAgent}
          />}
        </div>

        {/* Error */}
        {error && (
          <div className="px-8 pb-2 text-red-500 text-sm">{error}</div>
        )}

        {/* Footer */}
        <div className="p-6 border-t border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800/50 flex gap-3">
          {step === 2 && (
            <button
              onClick={() => setStep(1)}
              className="px-6 py-3.5 rounded-xl font-bold text-slate-600 dark:text-slate-300 border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors flex items-center gap-2"
            >
              <ArrowLeft className="w-5 h-5" /> Back
            </button>
          )}
          <button
            onClick={step === 1 ? () => { if (topic.trim()) setStep(2); } : handleSubmit}
            disabled={step === 1 ? !topic.trim() : submitting}
            className="flex-1 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white py-3.5 rounded-xl font-bold text-lg shadow-lg shadow-violet-500/30 transition-all transform active:scale-[0.99] flex items-center justify-center gap-2"
          >
            {step === 1 ? (<>Next Step — Configure Debate <ArrowRight className="w-5 h-5" /></>) :
              submitting ? (<><Loader2 className="w-5 h-5 animate-spin" /> Creating...</>) :
              'Create Debate'}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

/* ── Step 1: Topic + Materials ── */

function Step1Content({ topic, setTopic, activeTab, setActiveTab, pasteContent, setPasteContent,
  librarySearch, setLibrarySearch, selectedMaterialIds, toggleMaterial, filteredLibrary,
  uploading, handleUploadFiles, handleSavePaste, fileInputRef,
}: {
  topic: string; setTopic: (v: string) => void;
  activeTab: 'upload' | 'paste' | 'library'; setActiveTab: (v: 'upload' | 'paste' | 'library') => void;
  pasteContent: string; setPasteContent: (v: string) => void;
  librarySearch: string; setLibrarySearch: (v: string) => void;
  selectedMaterialIds: number[]; toggleMaterial: (id: number) => void;
  filteredLibrary: MaterialResponse[];
  uploading: boolean;
  handleUploadFiles: (files: FileList | File[]) => void;
  handleSavePaste: () => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const formatSize = (bytes: number | null) => {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <>
      {/* Topic */}
      <div className="space-y-3">
        <label className="block text-lg font-bold text-slate-800 dark:text-slate-100">Debate Topic</label>
        <textarea
          value={topic} onChange={(e) => setTopic(e.target.value)}
          placeholder="Example: Will AI replace most white-collar jobs? Please analyze from technical, economic, and social perspectives."
          className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-4 text-base focus:ring-2 focus:ring-violet-500 outline-none min-h-[100px] resize-none"
        />
      </div>

      {/* Materials */}
      <div className="space-y-4">
        <label className="block text-lg font-bold text-slate-800 dark:text-slate-100">
          Debate Materials <span className="text-sm font-normal text-slate-500 ml-2">(Optional)</span>
        </label>

        {/* Tabs */}
        <div className="flex border-b border-slate-200 dark:border-slate-700">
          {(['upload', 'paste', 'library'] as const).map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              className={`px-6 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? 'border-violet-600 text-violet-600 dark:text-violet-400'
                  : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
              }`}
            >
              {tab === 'upload' ? 'Upload File' : tab === 'paste' ? 'Paste Text' : 'Material Library'}
            </button>
          ))}
        </div>

        <div className="min-h-[350px] bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden flex">
          {activeTab === 'upload' && (
            <UploadTab uploading={uploading} handleUploadFiles={handleUploadFiles} fileInputRef={fileInputRef} />
          )}
          {activeTab === 'paste' && (
            <PasteTab pasteContent={pasteContent} setPasteContent={setPasteContent}
              handleSavePaste={handleSavePaste} uploading={uploading} />
          )}
          {activeTab === 'library' && (
            <LibraryTab librarySearch={librarySearch} setLibrarySearch={setLibrarySearch}
              filteredLibrary={filteredLibrary} selectedMaterialIds={selectedMaterialIds}
              toggleMaterial={toggleMaterial} formatSize={formatSize} />
          )}
        </div>
      </div>
    </>
  );
}

/* ── Upload Tab ── */

function UploadTab({ uploading, handleUploadFiles, fileInputRef }: {
  uploading: boolean;
  handleUploadFiles: (files: FileList | File[]) => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <div
      className="flex-1 flex flex-col items-center justify-center border-2 border-dashed border-slate-300 dark:border-slate-600 rounded-xl m-6 p-12 text-center hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
      onClick={() => fileInputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer.files.length) handleUploadFiles(e.dataTransfer.files); }}
    >
      <input ref={fileInputRef} type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) handleUploadFiles(e.target.files); e.target.value = ''; }} />
      {uploading ? <Loader2 className="w-12 h-12 text-violet-500 mb-4 animate-spin" /> : <Paperclip className="w-12 h-12 text-slate-400 mb-4" />}
      <p className="text-lg font-medium text-slate-700 dark:text-slate-300 mb-2">
        {uploading ? 'Uploading...' : 'Drag files here, or click to select'}
      </p>
      <p className="text-sm text-slate-500">Supports txt, md, pdf, docx, png, jpg, gif, webp (Max 10MB)</p>
    </div>
  );
}

/* ── Paste Tab ── */

function PasteTab({ pasteContent, setPasteContent, handleSavePaste, uploading }: {
  pasteContent: string; setPasteContent: (v: string) => void;
  handleSavePaste: () => void; uploading: boolean;
}) {
  return (
    <div className="flex-1 flex flex-col p-6 gap-4">
      <textarea
        value={pasteContent} onChange={(e) => setPasteContent(e.target.value)}
        placeholder="Paste text content here, it will be automatically saved as a file in the library..."
        className="flex-1 w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-4 text-sm focus:ring-2 focus:ring-violet-500 outline-none resize-none min-h-[200px]"
      />
      <div className="flex justify-end">
        <button onClick={handleSavePaste} disabled={!pasteContent.trim() || uploading}
          className="bg-violet-200 dark:bg-violet-900/30 text-violet-800 dark:text-violet-200 px-4 py-2 rounded-lg text-sm font-medium hover:bg-violet-300 dark:hover:bg-violet-900/50 disabled:opacity-50 transition-colors flex items-center gap-2"
        >
          {uploading && <Loader2 className="w-4 h-4 animate-spin" />}
          Save to Library
        </button>
      </div>
    </div>
  );
}

/* ── Library Tab ── */

function LibraryTab({ librarySearch, setLibrarySearch, filteredLibrary, selectedMaterialIds, toggleMaterial, formatSize }: {
  librarySearch: string; setLibrarySearch: (v: string) => void;
  filteredLibrary: MaterialResponse[]; selectedMaterialIds: number[];
  toggleMaterial: (id: number) => void; formatSize: (b: number | null) => string;
}) {
  return (
    <div className="flex-1 flex flex-col p-4 gap-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input type="text" value={librarySearch} onChange={(e) => setLibrarySearch(e.target.value)}
          placeholder="Search materials..."
          className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg pl-10 pr-4 py-2 text-sm focus:ring-2 focus:ring-violet-500 outline-none"
        />
      </div>
      <div className="flex-1 overflow-y-auto space-y-2 max-h-[260px] custom-scrollbar pr-2">
        {filteredLibrary.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-slate-400 py-12">
            <FileText className="w-8 h-8 mb-2 opacity-50" />
            <p className="text-sm">No materials found.</p>
          </div>
        ) : filteredLibrary.map(item => (
          <div key={item.id} onClick={() => toggleMaterial(item.id)}
            className={`group flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
              selectedMaterialIds.includes(item.id)
                ? 'bg-violet-50 dark:bg-violet-900/20 border-violet-500 dark:border-violet-500'
                : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 hover:border-violet-300 dark:hover:border-violet-700'
            }`}
          >
            <div className={`w-5 h-5 rounded border flex items-center justify-center mt-0.5 transition-colors pointer-events-none ${
              selectedMaterialIds.includes(item.id)
                ? 'bg-violet-600 border-violet-600' : 'border-slate-300 dark:border-slate-600 group-hover:border-violet-400'
            }`}>
              {selectedMaterialIds.includes(item.id) && <Check className="w-3.5 h-3.5 text-white" />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <h4 className="font-semibold text-sm text-slate-800 dark:text-slate-100 truncate">{item.filename}</h4>
                <span className="text-[10px] px-1.5 py-0.5 bg-slate-100 dark:bg-slate-700 rounded text-slate-500 font-mono">{item.file_type}</span>
                {item.status === 'processing' && <Loader2 className="w-3 h-3 animate-spin text-violet-500" />}
              </div>
              {item.text_preview && <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-2 mb-1.5">{item.text_preview}</p>}
              <div className="flex items-center gap-3 text-[10px] text-slate-400">
                <span>{formatSize(item.file_size)}</span>
                <span>•</span>
                <span>{new Date(item.created_at).toLocaleDateString()}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Step 2: Config Panel ── */

function Step2Content({ mode, setMode, maxRounds, setMaxRounds, providers, selectedModelIds, toggleModel,
  hostModelId, setHostModelId, selectedModels, customAgents, setCustomAgents, updateAgent,
}: {
  mode: DiscussionMode; setMode: (v: DiscussionMode) => void;
  maxRounds: number; setMaxRounds: (v: number) => void;
  providers: LLMProviderResponse[];
  selectedModelIds: number[]; toggleModel: (id: number) => void;
  hostModelId: number | undefined; setHostModelId: (v: number | undefined) => void;
  selectedModels: { id: number; model: string; name: string | null; provider_id: number }[];
  customAgents: AgentConfigCreate[]; setCustomAgents: (v: AgentConfigCreate[]) => void;
  updateAgent: (idx: number, patch: Partial<AgentConfigCreate>) => void;
}) {
  return (
    <>
      {/* Mode selector */}
      <div className="space-y-3">
        <label className="block text-lg font-bold text-slate-800 dark:text-slate-100">Discussion Mode</label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {MODE_OPTIONS.map(opt => (
            <div key={opt.value} onClick={() => setMode(opt.value)}
              className={`p-4 rounded-xl border cursor-pointer transition-all ${
                mode === opt.value
                  ? 'bg-violet-50 dark:bg-violet-900/20 border-violet-500'
                  : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 hover:border-violet-300'
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                  mode === opt.value ? 'border-violet-600' : 'border-slate-300 dark:border-slate-600'
                }`}>
                  {mode === opt.value && <div className="w-2 h-2 rounded-full bg-violet-600" />}
                </div>
                <span className="font-semibold text-sm text-slate-800 dark:text-slate-100">{opt.label}</span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 ml-6">{opt.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Max rounds slider */}
      <div className="space-y-3">
        <label className="block text-lg font-bold text-slate-800 dark:text-slate-100">
          Max Rounds: <span className="text-violet-600">{maxRounds}</span>
        </label>
        <input type="range" min={1} max={10} value={maxRounds}
          onChange={(e) => setMaxRounds(Number(e.target.value))}
          className="w-full accent-violet-600" />
        <div className="flex justify-between text-xs text-slate-400"><span>1</span><span>10</span></div>
      </div>

      {/* Model selection or custom agents */}
      {mode !== 'custom' ? (
        <ModelSelection providers={providers} selectedModelIds={selectedModelIds} toggleModel={toggleModel}
          hostModelId={hostModelId} setHostModelId={setHostModelId} selectedModels={selectedModels} />
      ) : (
        <CustomAgents providers={providers} customAgents={customAgents}
          setCustomAgents={setCustomAgents} updateAgent={updateAgent} />
      )}
    </>
  );
}

/* ── Model Selection (non-custom modes) ── */

function ModelSelection({ providers, selectedModelIds, toggleModel, hostModelId, setHostModelId, selectedModels }: {
  providers: LLMProviderResponse[];
  selectedModelIds: number[]; toggleModel: (id: number) => void;
  hostModelId: number | undefined; setHostModelId: (v: number | undefined) => void;
  selectedModels: { id: number; model: string; name: string | null; provider_id: number }[];
}) {
  return (
    <div className="space-y-4">
      <label className="block text-lg font-bold text-slate-800 dark:text-slate-100">Select Models</label>
      {providers.length === 0 ? (
        <p className="text-sm text-slate-400">No providers configured. Add providers in Settings.</p>
      ) : (
        <div className="space-y-4">
          {providers.map(provider => (
            <div key={provider.id} className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-4">
              <h4 className="font-semibold text-sm text-slate-700 dark:text-slate-200 mb-3">{provider.name}</h4>
              <div className="flex flex-wrap gap-2">
                {provider.models.map(model => (
                  <button key={model.id} onClick={() => toggleModel(model.id)}
                    className={`px-3 py-1.5 rounded-lg text-sm border transition-all ${
                      selectedModelIds.includes(model.id)
                        ? 'bg-violet-100 dark:bg-violet-900/30 border-violet-500 text-violet-700 dark:text-violet-300'
                        : 'border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:border-violet-300'
                    }`}
                  >
                    {selectedModelIds.includes(model.id) && <Check className="w-3 h-3 inline mr-1" />}
                    {model.name || model.model}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Host model dropdown */}
      {selectedModels.length > 0 && (
        <div className="space-y-2">
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">Host Model</label>
          <select value={hostModelId ?? ''} onChange={(e) => setHostModelId(e.target.value ? Number(e.target.value) : undefined)}
            className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-violet-500 outline-none"
          >
            <option value="">Auto-select</option>
            {selectedModels.map(m => (
              <option key={m.id} value={m.id}>{m.name || m.model}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

/* ── Custom Agents (custom mode) ── */

function CustomAgents({ providers, customAgents, setCustomAgents, updateAgent }: {
  providers: LLMProviderResponse[];
  customAgents: AgentConfigCreate[];
  setCustomAgents: (v: AgentConfigCreate[]) => void;
  updateAgent: (idx: number, patch: Partial<AgentConfigCreate>) => void;
}) {
  const addAgent = () => setCustomAgents([...customAgents,
    { name: `Agent ${customAgents.length + 1}`, role: 'panelist', persona: '', provider: '', model: '' }]);
  const removeAgent = (idx: number) => setCustomAgents(customAgents.filter((_, i) => i !== idx));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <label className="text-lg font-bold text-slate-800 dark:text-slate-100">Custom Agents</label>
        <button onClick={addAgent}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 hover:bg-violet-200 transition-colors">
          <Plus className="w-4 h-4" /> Add Agent
        </button>
      </div>

      {customAgents.map((agent, idx) => {
        const providerObj = providers.find(p => p.provider === agent.provider);
        return (
          <div key={idx} className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">Agent {idx + 1}</span>
              {customAgents.length > 1 && (
                <button onClick={() => removeAgent(idx)} className="text-slate-400 hover:text-red-500 transition-colors">
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <input value={agent.name} onChange={(e) => updateAgent(idx, { name: e.target.value })}
                placeholder="Name" className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-violet-500" />
              <select value={agent.role} onChange={(e) => updateAgent(idx, { role: e.target.value as AgentRole })}
                className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-violet-500">
                {ROLE_OPTIONS.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <input value={agent.persona || ''} onChange={(e) => updateAgent(idx, { persona: e.target.value })}
              placeholder="Persona description (optional)"
              className="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-violet-500" />
            <div className="grid grid-cols-2 gap-3">
              <select value={agent.provider}
                onChange={(e) => updateAgent(idx, { provider: e.target.value, model: '' })}
                className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-violet-500">
                <option value="">Select provider</option>
                {providers.map(p => <option key={p.id} value={p.provider}>{p.name}</option>)}
              </select>
              <select value={agent.model} onChange={(e) => updateAgent(idx, { model: e.target.value })}
                className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-violet-500">
                <option value="">Select model</option>
                {providerObj?.models.map(m => <option key={m.id} value={m.model}>{m.name || m.model}</option>)}
              </select>
            </div>
          </div>
        );
      })}
    </div>
  );
}
