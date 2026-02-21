/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeHighlight from 'rehype-highlight';
import {
  PlusCircle,
  Hash,
  History,
  MoreVertical,
  Timer,
  RefreshCw,
  BarChart3,
  Copy,
  Maximize2,
  Send,
  Eye,
  Eraser,
  ChevronDown,
  Lightbulb,
  ArrowUp,
  Settings as SettingsIcon,
  User as UserIcon,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Trash2,
  Play,
  Square,
  X,
  Loader2,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import type { DiscussionResponse, DiscussionDetail, DiscussionEvent, MessageResponse, AgentConfigResponse, LLMProviderResponse, ObserverMessageResponse } from './types';
import {
  listDiscussions, getDiscussion, deleteDiscussion, stopDiscussion, resetDiscussion,
  prepareAgents, generateTitle, submitUserInput, deleteMessage, updateMessage,
  streamDiscussion, streamSummarize, streamObserverChat,
  listLLMProviders, getObserverHistory, clearObserverHistory,
} from './services/api';
import { SettingsModal } from './components/SettingsModal';
import { NewDebateModal } from './components/NewDebateModal';
import { AgentConfigModal } from './components/AgentConfigModal';
import { ModelAvatar } from './components/ModelAvatar';
import 'highlight.js/styles/github-dark.css';

const PHASE_LABELS: Record<string, string> = {
  planning: 'Planning', discussing: 'Discussing', reflecting: 'Reflecting', synthesizing: 'Synthesizing',
};

const RUNNING_STATUSES = ['planning', 'discussing', 'reflecting', 'synthesizing'];

function formatTime(ts: string) {
  const s = String(ts);
  const d = new Date(s.includes('Z') || s.includes('+') ? s : s + 'Z');
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function statusLabel(s: string) {
  if (RUNNING_STATUSES.includes(s)) return 'Running';
  if (s === 'waiting_input') return 'Waiting Input';
  if (s === 'completed') return 'Completed';
  if (s === 'failed') return 'Failed';
  return s;
}

const MarkdownRenderer = ({ content }: { content: string }) => {
  return (
    <div className="prose dark:prose-invert prose-slate prose-sm prose-h1:text-2xl prose-h2:text-xl prose-h3:text-lg max-w-none leading-relaxed 
        prose-headings:font-bold prose-headings:text-slate-800 dark:prose-headings:text-slate-100
        prose-a:text-violet-600 dark:prose-a:text-violet-400 prose-a:no-underline hover:prose-a:underline
        prose-strong:font-bold prose-strong:text-slate-900 dark:prose-strong:text-white
        prose-code:text-violet-600 dark:prose-code:text-violet-300 prose-code:bg-slate-200 dark:prose-code:bg-slate-700 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:before:content-none prose-code:after:content-none
        prose-pre:bg-slate-900 dark:prose-pre:bg-slate-950 prose-pre:text-slate-50 prose-pre:rounded-xl prose-pre:p-4
        prose-blockquote:border-l-4 prose-blockquote:border-violet-500 prose-blockquote:bg-slate-50 dark:prose-blockquote:bg-slate-900/50 prose-blockquote:py-2 prose-blockquote:px-4 prose-blockquote:rounded-r-lg prose-blockquote:not-italic
        prose-ul:list-disc prose-ul:pl-5 prose-ol:list-decimal prose-ol:pl-5
        prose-li:marker:text-slate-400">
      <ReactMarkdown 
        remarkPlugins={[remarkGfm]} 
        rehypePlugins={[rehypeRaw, rehypeHighlight]}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
};

const SummaryModal = ({ isOpen, onClose, content, title }: { isOpen: boolean; onClose: () => void; content: string; title: string }) => {
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
        className="bg-white dark:bg-slate-900 w-full max-w-5xl max-h-[90vh] rounded-2xl shadow-2xl overflow-hidden flex flex-col border border-white/20"
      >
        <div className="flex items-center justify-between p-4 border-b border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800/50">
          <h3 className="font-bold text-lg text-slate-800 dark:text-slate-100 flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-violet-500" />
            {title}
          </h3>
          <button onClick={onClose} className="p-1 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-full transition-colors">
            <X className="w-5 h-5 text-slate-500" />
          </button>
        </div>
        <div className="p-6 overflow-y-auto custom-scrollbar">
           <MarkdownRenderer content={content} />
        </div>
      </motion.div>
    </div>
  );
};

export default function App() {
  // Discussion list
  const [discussions, setDiscussions] = useState<DiscussionResponse[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [detail, setDetail] = useState<DiscussionDetail | null>(null);

  // Discussion state
  const [messages, setMessages] = useState<MessageResponse[]>([]);
  const [agents, setAgents] = useState<AgentConfigResponse[]>([]);
  const [phase, setPhase] = useState('');
  const [discStatus, setDiscStatus] = useState<string>('loading');
  const [error, setError] = useState<string | null>(null);
  const [llmProgress, setLlmProgress] = useState<Record<string, { chars: number; status: string }> | null>(null);
  const [preparingAgents, setPreparingAgents] = useState(false);

  // UI state
  const [inputText, setInputText] = useState('');
  const [sendingInput, setSendingInput] = useState(false);
  const [isLeftSidebarOpen, setIsLeftSidebarOpen] = useState(true);
  const [isRightSidebarOpen, setIsRightSidebarOpen] = useState(true);
  const [summaryModalOpen, setSummaryModalOpen] = useState(false);
  const [summaryContent, setSummaryContent] = useState('');
  const [summaryTitle, setSummaryTitle] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newDebateOpen, setNewDebateOpen] = useState(false);
  const [showAgents, setShowAgents] = useState(false);
  const [showHeaderMenu, setShowHeaderMenu] = useState(false);
  const [editingAgent, setEditingAgent] = useState<AgentConfigResponse | null>(null);
  const [rightSidebarWidth, setRightSidebarWidth] = useState(340);
  const [isResizing, setIsResizing] = useState(false);
  const [providers, setProviders] = useState<LLMProviderResponse[]>([]);

  // Observer state
  const [observerMessages, setObserverMessages] = useState<ObserverMessageResponse[]>([]);
  const [observerInput, setObserverInput] = useState('');
  const [observerStreaming, setObserverStreaming] = useState(false);
  const [observerStreamText, setObserverStreamText] = useState('');
  const [observerConfig, setObserverConfig] = useState<{ providerId: number | null; provider: string; model: string }>({ providerId: null, provider: '', model: '' });
  const observerStreamRef = useRef<AbortController | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const observerScrollRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<AbortController | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Resize handler for observer panel
  useEffect(() => {
    if (!isResizing) return;
    const onMove = (e: MouseEvent) => {
      const w = window.innerWidth - e.clientX;
      if (w >= 280 && w <= 600) setRightSidebarWidth(w);
    };
    const onUp = () => setIsResizing(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, [isResizing]);

  // Load discussion list on mount
  const refreshList = useCallback(async () => {
    try { setDiscussions(await listDiscussions()); } catch {}
  }, []);

  useEffect(() => { refreshList(); }, [refreshList]);

  // Load providers
  useEffect(() => {
    listLLMProviders().then(p => {
      setProviders(p);
      if (p.length && !observerConfig.provider) {
        const first = p[0];
        setObserverConfig({ providerId: first.id, provider: first.provider, model: first.models[0]?.model || '' });
      }
    }).catch(() => {});
  }, []);

  // Auto-scroll messages
  useEffect(() => { scrollRef.current && (scrollRef.current.scrollTop = scrollRef.current.scrollHeight); }, [messages]);
  useEffect(() => { observerScrollRef.current && (observerScrollRef.current.scrollTop = observerScrollRef.current.scrollHeight); }, [observerMessages, observerStreamText]);

  // Polling for already-running discussions
  const startPolling = useCallback(() => {
    if (pollRef.current || !activeId) return;
    pollRef.current = setInterval(async () => {
      try {
        const d = await getDiscussion(activeId);
        setMessages(d.messages || []);
        setPhase(d.status);
        setAgents(d.agents || []);
        if (!RUNNING_STATUSES.includes(d.status)) {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          setDiscStatus(d.status === 'waiting_input' ? 'waiting_input' : d.status === 'completed' ? 'completed' : 'error');
        }
      } catch {}
    }, 2500);
  }, [activeId]);

  // Load discussion detail when activeId changes
  useEffect(() => {
    streamRef.current?.abort();
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    observerStreamRef.current?.abort();
    if (!activeId) { setDetail(null); setMessages([]); setAgents([]); setDiscStatus('loading'); return; }

    const load = async () => {
      setDiscStatus('loading');
      setError(null);
      setLlmProgress(null);
      setPhase('');
      try {
        const [d, obsHistory] = await Promise.all([
          getDiscussion(activeId),
          getObserverHistory(activeId).catch(() => []),
        ]);
        setDetail(d);
        setMessages(d.messages || []);
        setAgents(d.agents || []);
        setObserverMessages(obsHistory as ObserverMessageResponse[]);

        if (d.status === 'completed') setDiscStatus('completed');
        else if (d.status === 'waiting_input') setDiscStatus('waiting_input');
        else if (d.status === 'failed') { setDiscStatus('error'); setError('Discussion failed'); }
        else if (d.status === 'created') {
          setDiscStatus('ready');
          if (!d.agents?.length) {
            setPreparingAgents(true);
            try {
              const prepared = await prepareAgents(activeId);
              setAgents(prepared);
            } catch {} finally { setPreparingAgents(false); }
          }
        } else if (RUNNING_STATUSES.includes(d.status)) {
          setDiscStatus('running');
          startPolling();
        }
      } catch (e: unknown) {
        setDiscStatus('error');
        setError(e instanceof Error ? e.message : 'Failed to load');
      }
    };
    load();
    return () => { streamRef.current?.abort(); if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [activeId, startPolling]);

  // --- Handlers ---

  const startDiscussionStream = useCallback(async () => {
    if (!activeId) return;
    setDiscStatus('running');
    setError(null);
    const controller = streamDiscussion(
      activeId,
      (event: DiscussionEvent) => {
        if (event.event_type === 'phase_change') setPhase(event.phase || '');
        if (event.event_type === 'message') {
          setMessages(prev => [...prev, event as unknown as MessageResponse]);
          if (event.agent_name) {
            setLlmProgress(prev => {
              if (!prev) return prev;
              const next = { ...prev };
              delete next[event.agent_name!];
              return Object.keys(next).length ? next : null;
            });
          }
        }
        if (event.event_type === 'llm_progress') {
          setLlmProgress(prev => ({
            ...prev,
            [event.agent_name!]: { chars: event.chars_received || 0, status: event.llm_status || '' },
          }));
          if (event.llm_status === 'done') {
            setTimeout(() => {
              setLlmProgress(prev => {
                if (!prev) return prev;
                const next = { ...prev };
                delete next[event.agent_name!];
                return Object.keys(next).length ? next : null;
              });
            }, 800);
          }
        }
      },
      (errMsg) => { setDiscStatus('error'); setError(errMsg); },
      (evt: DiscussionEvent) => {
        setLlmProgress(null);
        getDiscussion(activeId).then(d => {
          setDetail(d);
          setMessages(d.messages || []);
          setAgents(d.agents || []);
          setDiscStatus(evt.event_type === 'complete' ? 'completed' : 'waiting_input');
          refreshList();
        });
      },
    );
    streamRef.current = controller;
  }, [activeId, refreshList]);

  const handleStop = useCallback(async () => {
    streamRef.current?.abort();
    if (activeId) try { await stopDiscussion(activeId); } catch {}
    setLlmProgress(null);
    setDiscStatus('completed');
    setPhase('');
    refreshList();
  }, [activeId, refreshList]);

  const handleReset = useCallback(async () => {
    streamRef.current?.abort();
    if (activeId) try { await resetDiscussion(activeId); } catch {}
    setMessages([]);
    setLlmProgress(null);
    setPhase('');
    setError(null);
    setDiscStatus('ready');
    if (activeId) {
      setPreparingAgents(true);
      try { setAgents(await prepareAgents(activeId)); } catch {} finally { setPreparingAgents(false); }
    }
  }, [activeId]);

  const handleUserInput = useCallback(async () => {
    const text = inputText.trim();
    if (!text || sendingInput || !activeId) return;
    setSendingInput(true);
    setMessages(prev => [...prev, {
      id: Date.now(), agent_name: 'User', agent_role: 'user', content: text,
      summary: null, round_number: 0, cycle_index: 0, phase: 'user_input', created_at: new Date().toISOString(),
    } as MessageResponse]);
    setInputText('');
    try {
      await submitUserInput(activeId, text);
      if (discStatus !== 'running') { setSendingInput(false); startDiscussionStream(); return; }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Send failed');
    } finally { setSendingInput(false); }
  }, [activeId, inputText, sendingInput, discStatus, startDiscussionStream]);

  const handleDeleteDiscussion = useCallback(async (id: number) => {
    try { await deleteDiscussion(id); } catch {}
    setDiscussions(prev => prev.filter(d => d.id !== id));
    if (activeId === id) setActiveId(null);
  }, [activeId]);

  const copyToClipboard = (text: string) => navigator.clipboard.writeText(text);

  const openSummary = (content: string, title = 'Summary Details') => {
    setSummaryContent(content); setSummaryTitle(title); setSummaryModalOpen(true);
  };

  // Observer chat
  const handleObserverSend = useCallback(async () => {
    const text = observerInput.trim();
    if (!text || observerStreaming || !observerConfig.provider || !activeId) return;
    const userMsg: ObserverMessageResponse = { id: Date.now(), role: 'user', content: text, created_at: new Date().toISOString() };
    setObserverMessages(prev => [...prev, userMsg]);
    setObserverInput('');
    setObserverStreaming(true);
    setObserverStreamText('');
    const ctrl = streamObserverChat(
      activeId,
      { content: text, provider: observerConfig.provider, model: observerConfig.model, provider_id: observerConfig.providerId ?? undefined },
      (chunk) => setObserverStreamText(prev => prev + chunk),
      (err) => { setObserverStreamText(prev => prev + `\n[Error: ${err}]`); setObserverStreaming(false); },
      () => {
        setObserverStreamText(prev => {
          if (prev) setObserverMessages(msgs => [...msgs, { id: Date.now() + 1, role: 'observer', content: prev, created_at: new Date().toISOString() }]);
          return '';
        });
        setObserverStreaming(false);
      },
    );
    observerStreamRef.current = ctrl;
  }, [activeId, observerInput, observerStreaming, observerConfig]);

  const handleObserverClear = useCallback(async () => {
    if (observerStreaming) { observerStreamRef.current?.abort(); setObserverStreaming(false); setObserverStreamText(''); }
    if (activeId) try { await clearObserverHistory(activeId); } catch {}
    setObserverMessages([]);
  }, [activeId, observerStreaming]);

  const selectedProviderObj = providers.find(p => p.id === observerConfig.providerId);
  const observerModels = selectedProviderObj?.models || [];

  const activeDisc = discussions.find(d => d.id === activeId);
  const isRunning = RUNNING_STATUSES.includes(detail?.status || '');

  return (
    <div className="flex h-screen w-full overflow-hidden font-sans">
      <SummaryModal isOpen={summaryModalOpen} onClose={() => setSummaryModalOpen(false)} content={summaryContent} title={summaryTitle} />
      <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} onProvidersChange={() => listLLMProviders().then(setProviders).catch(() => {})} />
      <NewDebateModal isOpen={newDebateOpen} onClose={() => setNewDebateOpen(false)} onCreated={(d) => { refreshList(); setActiveId(d.id); }} />

      {/* Sidebar */}
      <motion.aside
        initial={{ width: 280, opacity: 1 }}
        animate={{ width: isLeftSidebarOpen ? 280 : 0, opacity: isLeftSidebarOpen ? 1 : 0 }}
        transition={{ duration: 0.3, ease: 'easeInOut' }}
        className="glass-panel z-30 shadow-xl relative overflow-hidden border-r border-white/20"
      >
        <div className="w-[280px] h-full flex flex-col">
        <div className="h-16 flex items-center justify-between px-5 border-b border-slate-200/40 dark:border-slate-700/40 shrink-0">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-600 to-indigo-600 flex items-center justify-center shadow-lg shadow-violet-500/30">
              <MessageSquare className="text-white w-5 h-5" />
            </div>
            <h1 className="font-bold text-lg bg-clip-text text-transparent bg-gradient-to-r from-slate-900 to-slate-600 dark:from-white dark:to-slate-300">RoundTable</h1>
          </div>
        </div>

        <div className="px-4 py-5 shrink-0">
          <button onClick={() => setNewDebateOpen(true)}
            className="group w-full bg-slate-900 dark:bg-white hover:bg-slate-800 dark:hover:bg-slate-200 text-white dark:text-slate-900 py-3 px-4 rounded-xl flex items-center justify-center space-x-2 shadow-lg shadow-slate-900/20 transition-all duration-300 transform hover:scale-[1.02]">
            <PlusCircle className="w-5 h-5 group-hover:rotate-90 transition-transform duration-300" />
            <span className="font-medium text-sm">New Debate</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 space-y-1 pb-4">
          <div className="text-[10px] font-bold text-slate-500 dark:text-slate-400 px-3 mb-2 uppercase tracking-widest">Active</div>
          {discussions.filter(d => RUNNING_STATUSES.includes(d.status) || d.status === 'created' || d.status === 'waiting_input').map(disc => (
            <div key={disc.id} onClick={() => setActiveId(disc.id)}
              className={`group flex flex-col p-3.5 rounded-xl cursor-pointer relative overflow-hidden transition-all duration-200 ${
                activeId === disc.id ? 'bg-white/50 dark:bg-white/5 border border-violet-200/50 dark:border-white/10 shadow-sm' : 'hover:bg-white/30 dark:hover:bg-white/5 border border-transparent'
              }`}>
              <div className="relative z-10">
                <div className="font-semibold text-sm text-slate-900 dark:text-white line-clamp-2 leading-tight">{disc.title || disc.topic}</div>
                <div className="flex items-center mt-2.5 justify-between">
                  <div className="flex items-center text-[10px] text-slate-500 dark:text-slate-400 font-medium">
                    {RUNNING_STATUSES.includes(disc.status) ? (<>
                      <span className="flex h-2 w-2 relative mr-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
                      </span>Running
                    </>) : <span className="text-slate-400">{statusLabel(disc.status)}</span>}
                  </div>
                  <span className="text-[10px] text-slate-400">{formatTime(disc.updated_at)}</span>
                </div>
              </div>
            </div>
          ))}

          <div className="mt-6 text-[10px] font-bold text-slate-500 dark:text-slate-400 px-3 mb-2 uppercase tracking-widest pt-4">History</div>
          {discussions.filter(d => d.status === 'completed' || d.status === 'failed').map(disc => (
            <div key={disc.id} onClick={() => setActiveId(disc.id)}
              className={`group flex flex-col p-3 rounded-xl hover:bg-white/40 dark:hover:bg-white/5 border border-transparent hover:border-white/20 cursor-pointer transition-all ${
                activeId === disc.id ? 'bg-white/40 dark:bg-white/5 border-white/20' : ''
              }`}>
              <div className="flex items-center justify-between">
                <div className="font-medium text-sm text-slate-700 dark:text-slate-300 line-clamp-1 flex-1">{disc.title || disc.topic}</div>
                <button onClick={(e) => { e.stopPropagation(); handleDeleteDiscussion(disc.id); }}
                  className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-red-500 transition-all"><Trash2 className="w-3 h-3" /></button>
              </div>
              <div className="flex items-center mt-1.5 text-[10px] text-slate-400">
                <History className="w-3 h-3 mr-1" />
                <span>{formatTime(disc.updated_at)}</span>
              </div>
            </div>
          ))}
        </div>

        <div className="p-4 border-t border-slate-200/40 dark:border-slate-700/40 mt-auto bg-white/10 dark:bg-black/10 backdrop-blur-sm">
          <button onClick={() => setSettingsOpen(true)}
            className="flex items-center justify-between text-slate-600 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 transition w-full group">
            <div className="flex items-center space-x-3">
              <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-slate-200 to-slate-100 dark:from-slate-700 dark:to-slate-600 flex items-center justify-center">
                <UserIcon className="w-4 h-4" />
              </div>
              <span className="text-sm font-medium">Settings</span>
            </div>
            <SettingsIcon className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity" />
          </button>
        </div>
        </div>
      </motion.aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col relative z-10 min-w-0 bg-transparent">
        <header className="h-16 flex items-center justify-between px-8 glass-panel border-b border-white/20 shadow-sm z-20">
          <div className="flex items-center min-w-0 gap-3">
            <button onClick={() => setIsLeftSidebarOpen(!isLeftSidebarOpen)}
              className="p-1.5 -ml-2 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors text-slate-500">
              {isLeftSidebarOpen ? <PanelLeftClose className="w-5 h-5" /> : <PanelLeftOpen className="w-5 h-5" />}
            </button>
            <div className="h-6 w-px bg-slate-300 dark:bg-slate-700 mx-1" />
            <Hash className="w-5 h-5 text-slate-400" />
            <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100 truncate pr-4 tracking-tight">
              {detail?.title || detail?.topic || 'Select a debate'}
            </h2>
            {detail && (
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border uppercase tracking-wide ${
                isRunning ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800' :
                discStatus === 'waiting_input' ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800' :
                discStatus === 'completed' ? 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700' :
                'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-800'
              }`}>{discStatus === 'running' && phase ? PHASE_LABELS[phase] || phase : statusLabel(discStatus)}</span>
            )}
          </div>
          <div className="flex items-center space-x-4 shrink-0 relative">
            {agents.length > 0 && (
              <button onClick={() => setShowAgents(!showAgents)} className="flex -space-x-2 hover:opacity-80 transition-opacity">
                {agents.slice(0, 3).map(agent => (
                  <ModelAvatar key={agent.id} provider={agent.provider} className="w-8 h-8 z-10" />
                ))}
              </button>
            )}
            <div className="h-4 w-px bg-slate-300 dark:bg-slate-600" />
            <button onClick={() => setIsRightSidebarOpen(!isRightSidebarOpen)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg transition-all ${
                isRightSidebarOpen ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300' : 'text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'
              }`}>
              <Eye className="w-4 h-4" /><span className="text-sm font-medium">Observer</span>
            </button>
            {detail && (
              <div className="relative">
                <button onClick={() => setShowHeaderMenu(!showHeaderMenu)}
                  className="text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 transition">
                  <MoreVertical className="w-5 h-5" />
                </button>
                {showHeaderMenu && (
                  <div className="absolute right-0 mt-2 w-48 bg-white dark:bg-slate-800 rounded-xl shadow-xl border border-slate-200 dark:border-slate-700 py-1 z-50">
                    <button onClick={() => { setShowHeaderMenu(false); handleStop(); }}
                      className="w-full text-left px-4 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2">
                      <Square className="w-3.5 h-3.5" /> Stop Discussion
                    </button>
                    <button onClick={() => { setShowHeaderMenu(false); handleReset(); }}
                      className="w-full text-left px-4 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2">
                      <RefreshCw className="w-3.5 h-3.5" /> Reset & Replan
                    </button>
                    <div className="h-px bg-slate-200 dark:bg-slate-700 my-1" />
                    <button onClick={() => { setShowHeaderMenu(false); if (activeId) generateTitle(activeId).then(() => refreshList()); }}
                      className="w-full text-left px-4 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700">
                      Generate Title
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </header>

        {/* Agent Chips Panel */}
        <AnimatePresence>
          {showAgents && agents.length > 0 && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
              className="bg-slate-50/90 dark:bg-slate-900/90 backdrop-blur-md border-b border-slate-200 dark:border-slate-700 overflow-hidden z-10">
              <div className="px-8 py-3 flex flex-wrap gap-2">
                {agents.map(agent => (
                  <button key={agent.id} onClick={() => setEditingAgent(agent)}
                    className={`flex items-center gap-1.5 px-3 py-1 rounded-full border transition-colors ${
                      agent.role === 'host' ? 'border-orange-200 bg-orange-50 hover:bg-orange-100 dark:border-orange-800/50 dark:bg-orange-900/20 dark:hover:bg-orange-900/40' :
                      'border-violet-200 bg-violet-50 hover:bg-violet-100 dark:border-violet-800/50 dark:bg-violet-900/20 dark:hover:bg-violet-900/40'
                    }`}>
                    <span className={`text-sm font-bold ${
                      agent.role === 'host' ? 'text-orange-700 dark:text-orange-400' : 'text-violet-700 dark:text-violet-400'
                    }`}>{agent.name}</span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">{agent.provider}/{agent.model}</span>
                  </button>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <AgentConfigModal
          isOpen={!!editingAgent}
          onClose={() => setEditingAgent(null)}
          agent={editingAgent}
          discussionId={activeId}
          onSave={(updated) => setAgents(prev => prev.map(a => a.id === updated.id ? updated : a))}
          providers={providers}
        />

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 scroll-smooth chat-container relative">
          <div className="max-w-[850px] mx-auto space-y-4 pb-48">
            {/* Empty / Loading / Ready states */}
            {!activeId && (
              <div className="flex flex-col items-center justify-center h-full text-slate-400 py-32">
                <MessageSquare className="w-12 h-12 mb-4 opacity-30" />
                <p className="text-lg font-medium">Select or create a debate</p>
              </div>
            )}
            {activeId && discStatus === 'loading' && (
              <div className="flex items-center justify-center py-32 text-slate-400">
                <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading...
              </div>
            )}
            {activeId && (discStatus === 'ready' || discStatus === 'error') && (
              <div className="flex flex-col items-center justify-center py-16 gap-4">
                {error && <div className="text-red-500 text-sm bg-red-50 dark:bg-red-900/20 px-4 py-2 rounded-lg">{error}</div>}
                <button onClick={() => { setError(null); startDiscussionStream(); }} disabled={preparingAgents}
                  className="bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 disabled:opacity-50 text-white px-8 py-3 rounded-xl font-bold text-lg shadow-lg shadow-violet-500/30 transition-all flex items-center gap-2">
                  {preparingAgents ? <><Loader2 className="w-5 h-5 animate-spin" /> Preparing...</> :
                    discStatus === 'error' ? <><RefreshCw className="w-5 h-5" /> Retry</> :
                    <><Play className="w-5 h-5" /> Start Discussion</>}
                </button>
              </div>
            )}

            {/* Messages */}
            <AnimatePresence mode="popLayout">
              {messages.map((msg, idx) => (
                <motion.div key={msg.id || idx} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className={`flex gap-3 group ${msg.agent_role === 'user' ? 'flex-row-reverse' : ''}`}>
                  <div className="flex flex-col items-center pt-1 shrink-0">
                    <ModelAvatar provider={agents.find(a => a.name === msg.agent_name)?.provider} className="w-8 h-8" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className={`glass-card rounded-xl p-4 shadow-sm relative group-hover:shadow-md transition-all duration-300 ${
                      msg.agent_role === 'user' ? 'rounded-tr-none' : 'rounded-tl-none'} ${
                      msg.agent_role === 'host' ? 'border-l-4 border-l-blue-500' : ''
                    }`}>
                      <div className="flex items-center justify-between mb-2 border-b border-slate-100 dark:border-slate-700/50 pb-2">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-slate-900 dark:text-white text-sm">{msg.agent_name}</span>
                          <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide ${
                            msg.agent_role === 'host' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' :
                            msg.agent_role === 'critic' ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300' :
                            msg.agent_role === 'user' ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' :
                            'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300'
                          }`}>{msg.agent_role}</span>
                          {msg.phase && <span className="text-[9px] text-slate-400">{PHASE_LABELS[msg.phase] || msg.phase}</span>}
                        </div>
                        <div className="flex items-center text-[10px] text-slate-400 gap-3 font-mono">
                          {msg.created_at && <span className="flex items-center gap-1"><Timer className="w-3 h-3" /> {formatTime(msg.created_at)}</span>}
                          {msg.round_number !== undefined && <span className="flex items-center gap-1"><RefreshCw className="w-3 h-3" /> R{msg.round_number + 1}</span>}
                        </div>
                      </div>
                      <div className="relative">
                        {msg.summary ? (
                          <>
                            <MarkdownRenderer content={msg.summary} />
                            <button onClick={() => openSummary(msg.content, `Full message by ${msg.agent_name}`)}
                              className="mt-2 text-violet-600 dark:text-violet-400 text-xs hover:underline flex items-center gap-1">
                              <Maximize2 className="w-3 h-3" /> View full
                            </button>
                          </>
                        ) : <MarkdownRenderer content={msg.content} />}
                      </div>
                      <div className="absolute -bottom-3 right-6 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                        <button onClick={() => copyToClipboard(msg.content)}
                          className="p-1.5 bg-white dark:bg-slate-700 rounded-full shadow-md text-slate-400 hover:text-blue-500 hover:scale-110 transition" title="Copy">
                          <Copy className="w-3 h-3" />
                        </button>
                        {msg.id && msg.agent_role !== 'user' && (
                          <button onClick={() => { if (activeId && msg.id) deleteMessage(activeId, msg.id).then(() => setMessages(prev => prev.filter(m => m.id !== msg.id))); }}
                            className="p-1.5 bg-white dark:bg-slate-700 rounded-full shadow-md text-slate-400 hover:text-red-500 hover:scale-110 transition" title="Delete">
                            <Trash2 className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>

            {/* Streaming progress */}
            {discStatus === 'running' && llmProgress && Object.keys(llmProgress).length > 0 && (
              <div className="flex items-center gap-2 text-sm text-slate-500 pl-12">
                <Loader2 className="w-4 h-4 animate-spin text-violet-500" />
                {Object.entries(llmProgress).map(([name, { chars, status }]) => (
                  <span key={name} className="text-xs">
                    {name} {status === 'done' ? 'done' : status === 'waiting' ? 'waiting...' : `thinking${chars > 0 ? ` (${chars > 1000 ? `${(chars/1000).toFixed(1)}k` : chars} chars)` : '...'}`}
                  </span>
                ))}
              </div>
            )}
            {discStatus === 'running' && !llmProgress && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex gap-5 items-center pl-12 text-slate-400 text-sm italic">
                <Loader2 className="w-4 h-4 animate-spin" /> Processing...
              </motion.div>
            )}
          </div>
        </div>

        {/* Input Area */}
        {activeId && (discStatus === 'waiting_input' || discStatus === 'running' || discStatus === 'ready') && (
          <div className="absolute bottom-8 left-0 right-0 z-30 flex justify-center px-6">
            <div className="w-full max-w-[850px] relative group">
              <div className="absolute -inset-1 bg-gradient-to-r from-violet-600 to-pink-600 rounded-2xl blur opacity-25 group-hover:opacity-40 transition duration-1000 group-hover:duration-200"></div>
              <div className="relative glass-card rounded-2xl p-2 shadow-2xl flex flex-col bg-white/90 dark:bg-slate-900/90 backdrop-blur-2xl ring-1 ring-white/50 dark:ring-white/10">
                <textarea
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && e.ctrlKey) handleUserInput(); }}
                  className="w-full bg-transparent border-none focus:ring-0 text-slate-700 dark:text-slate-200 placeholder-slate-400 resize-none h-20 p-4 text-base leading-relaxed"
                  placeholder={discStatus === 'waiting_input' ? 'Provide your input to continue... (Ctrl+Enter)' : 'Guide the discussion... (Ctrl+Enter to send)'}
                />
                <div className="flex items-center justify-end px-3 pb-2 pt-1">
                  <button
                    onClick={handleUserInput}
                    disabled={!inputText.trim() || sendingInput}
                    className="bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white px-6 py-2.5 rounded-xl font-medium shadow-lg shadow-violet-500/30 transition-all transform active:scale-95 flex items-center gap-2"
                  >
                    {sendingInput ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                    <span>Send</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>



      {/* Observer Panel */}
      <motion.aside 
        initial={{ width: 340, opacity: 1 }}
        animate={{ width: isRightSidebarOpen ? rightSidebarWidth : 0, opacity: isRightSidebarOpen ? 1 : 0 }}
        transition={{ duration: isResizing ? 0 : 0.3, ease: "easeInOut" }}
        className="glass-panel border-l border-white/20 z-20 shadow-glass-sm relative overflow-hidden flex"
      >
        {isRightSidebarOpen && (
          <div 
            className="w-1 h-full cursor-col-resize hover:bg-violet-500/50 absolute left-0 top-0 z-50 transition-colors"
            onMouseDown={(e) => {
              e.preventDefault();
              setIsResizing(true);
            }}
          />
        )}
        <div style={{ width: rightSidebarWidth }} className="h-full flex flex-col">
        <div className="h-16 flex items-center justify-between px-5 border-b border-slate-200/40 dark:border-slate-700/40 bg-white/30 dark:bg-black/10 shrink-0">
          <div className="flex items-center space-x-2">
            <Eye className="w-5 h-5 text-violet-600 dark:text-violet-400" />
            <h3 className="font-bold text-slate-800 dark:text-slate-100">Observer Panel</h3>
          </div>
          <button onClick={handleObserverClear} className="p-1.5 rounded-lg hover:bg-white/50 dark:hover:bg-slate-700 text-slate-400 transition" title="Clear Context">
            <Eraser className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4 bg-slate-50/50 dark:bg-slate-900/20 border-b border-slate-200/40 dark:border-slate-700/40 backdrop-blur-md">
          <div className="space-y-1">
            <label className="text-[10px] uppercase font-bold text-slate-400 tracking-widest">Model Config</label>
            <div className="grid grid-cols-2 gap-3">
              <div className="relative">
                <select
                  value={observerConfig.providerId ?? ''}
                  onChange={(e) => {
                    const pid = Number(e.target.value) || null;
                    const prov = providers.find(p => p.id === pid);
                    setObserverConfig({ providerId: pid, provider: prov?.provider || '', model: prov?.models[0]?.model || '' });
                  }}
                  className="appearance-none w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 text-xs rounded-lg focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500 block p-2.5 pr-8 shadow-sm"
                >
                  <option value="">Provider</option>
                  {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              </div>
              <div className="relative">
                <select
                  value={observerConfig.model}
                  onChange={(e) => setObserverConfig(prev => ({ ...prev, model: e.target.value }))}
                  className="appearance-none w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 text-xs rounded-lg focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500 block p-2.5 pr-8 shadow-sm"
                >
                  {observerModels.length === 0 && <option value="">No models</option>}
                  {observerModels.map(m => <option key={m.id} value={m.model}>{m.name || m.model}</option>)}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              </div>
            </div>
          </div>
        </div>

        <div ref={observerScrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
          {observerMessages.map((msg) => (
            <div key={msg.id} className="group flex flex-col gap-1.5">
              <div className="flex items-center gap-2 px-1">
                <div className={`w-6 h-6 rounded-lg flex items-center justify-center ${
                  msg.role === 'user' ? 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400' : 'bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400'
                }`}>
                  {msg.role === 'user' ? <UserIcon className="w-3.5 h-3.5" /> : <Lightbulb className="w-3.5 h-3.5" />}
                </div>
                <span className="text-xs font-bold text-slate-700 dark:text-slate-200">{msg.role === 'user' ? 'You' : 'Observer'}</span>
                {msg.created_at && <span className="text-[10px] text-slate-400">{formatTime(msg.created_at)}</span>}
              </div>
              <div className="relative glass-card rounded-xl rounded-tl-none p-3 shadow-sm border border-slate-200/50 dark:border-slate-700/50">
                <MarkdownRenderer content={msg.content} />
                <div className="absolute -bottom-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                  <button onClick={() => copyToClipboard(msg.content)}
                    className="p-1 bg-white dark:bg-slate-700 rounded-full shadow-sm text-slate-400 hover:text-blue-500 hover:scale-110 transition" title="Copy">
                    <Copy className="w-3 h-3" />
                  </button>
                </div>
              </div>
            </div>
          ))}
          {observerStreaming && observerStreamText && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 px-1">
                <div className="w-6 h-6 rounded-lg bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center text-violet-600 dark:text-violet-400">
                  <Lightbulb className="w-3.5 h-3.5" />
                </div>
                <span className="text-xs font-bold text-slate-700 dark:text-slate-200">Observer</span>
                <Loader2 className="w-3 h-3 animate-spin text-violet-500" />
              </div>
              <div className="glass-card rounded-xl rounded-tl-none p-3 shadow-sm border border-violet-200/50 dark:border-violet-700/50">
                <MarkdownRenderer content={observerStreamText} />
              </div>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-slate-200/40 dark:border-slate-700/40 bg-white/40 dark:bg-black/20 backdrop-blur-md">
          <div className="flex items-end gap-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-2 shadow-sm focus-within:ring-2 focus-within:ring-violet-500/20 transition-shadow">
            <textarea
              value={observerInput}
              onChange={(e) => setObserverInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && e.ctrlKey) handleObserverSend(); }}
              className="w-full bg-transparent border-none focus:ring-0 text-xs text-slate-700 dark:text-slate-200 placeholder-slate-400 resize-none p-1.5 min-h-[40px] leading-normal"
              placeholder="Ask the observer... (Ctrl+Enter)" rows={1}
            />
            <button
              onClick={handleObserverSend}
              disabled={!observerInput.trim() || observerStreaming || !observerConfig.provider}
              className="p-1.5 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white rounded-lg transition shadow-sm flex items-center justify-center w-8 h-8 shrink-0"
            >
              {observerStreaming ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowUp className="w-4 h-4" />}
            </button>
          </div>
        </div>
        </div>
      </motion.aside>
    </div>
  );
}
