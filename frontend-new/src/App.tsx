/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
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
  FileText,
  Download,
  Pencil,
  Check,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import type { DiscussionResponse, DiscussionDetail, DiscussionEvent, SummaryEvent, MessageResponse, AgentConfigResponse, LLMProviderResponse, ObserverMessageResponse } from './types';
import {
  listDiscussions, getDiscussion, deleteDiscussion, stopDiscussion, resetDiscussion,
  prepareAgents, generateTitle, submitUserInput, deleteMessage, updateMessage, updateTopic,
  truncateMessagesAfter, streamDiscussion, streamSummarize, streamObserverChat,
  listLLMProviders, getObserverHistory, clearObserverHistory,
} from './services/api';
import { SettingsModal } from './components/SettingsModal';
import { NewDebateModal } from './components/NewDebateModal';
import { AgentConfigModal } from './components/AgentConfigModal';
import { ModelAvatar } from './components/ModelAvatar';
import { copyTextWithFallback } from './utils/clipboard';
import 'highlight.js/styles/github-dark.css';

const PHASE_LABELS: Record<string, string> = {
  planning: '规划中',
  discussing: '讨论中',
  reflecting: '反思中',
  synthesizing: '总结中',
  round_summary: '轮次总结中',
  next_step_planning: '下一步规划中',
};

const ROLE_LABELS: Record<string, string> = {
  host: '主持人',
  panelist: '专家',
  critic: '批评家',
  user: '用户',
};

const RUNNING_STATUSES = ['planning', 'discussing', 'reflecting', 'synthesizing'];

function roleOwnsPhase(role: string, phase: string) {
  if (!phase) return false;
  if (phase === 'planning' || phase === 'round_summary' || phase === 'synthesizing' || phase === 'next_step_planning') {
    return role === 'host';
  }
  if (phase === 'discussing') return role === 'panelist';
  if (phase === 'reflecting') return role === 'critic';
  return false;
}

function formatTime(ts: string) {
  const s = String(ts);
  const d = new Date(s.includes('Z') || s.includes('+') ? s : s + 'Z');
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (Date.now() - d.getTime() > 86400000) return d.toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' }) + ' ' + time;
  return time;
}

function statusLabel(s: string) {
  if (RUNNING_STATUSES.includes(s)) return 'Running';
  if (s === 'waiting_input') return 'Waiting Input';
  if (s === 'completed') return 'Completed';
  if (s === 'failed') return 'Failed';
  return s;
}

function toDateTime(ts?: string | null) {
  if (!ts) return '-';
  const d = new Date(ts.includes('Z') || ts.includes('+') ? ts : `${ts}Z`);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString();
}

function toSafeFileName(name: string) {
  return name
    .replace(/[\/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 120) || 'discussion';
}

function toMarkdownCell(text: string) {
  return String(text || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function normalizeMarkdown(content: string) {
  const lines = String(content || '').replace(/\r/g, '').split('\n');
  const normalized: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
      .replace(/^(\s*)(\d+)[、）]\s+/, '$1$2. ')
      .replace(/^(\s*)[•●·]\s+/, '$1- ');
    const isList = /^\s*([-*+]\s+|\d+[.)]\s+)/.test(line);
    const prev = normalized.length ? normalized[normalized.length - 1] : '';
    if (isList && prev && prev.trim() && !/^\s*([-*+]\s+|\d+[.)]\s+)/.test(prev)) {
      normalized.push('');
    }
    normalized.push(line);
  }
  return normalized.join('\n');
}

let mermaidScriptPromise: Promise<void> | null = null;
let mathJaxScriptPromise: Promise<void> | null = null;
let mermaidInitialized = false;

function loadScriptOnce(src: string, checkLoaded: () => boolean) {
  if (checkLoaded()) return Promise.resolve();
  const existing = Array.from(document.getElementsByTagName('script')).find(s => s.src === src);
  if (existing) {
    return new Promise<void>((resolve, reject) => {
      if (checkLoaded()) {
        resolve();
        return;
      }
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`Failed to load script: ${src}`)), { once: true });
    });
  }
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.head.appendChild(script);
  });
}

async function ensureMermaidLoaded() {
  if (!mermaidScriptPromise) {
    mermaidScriptPromise = loadScriptOnce(
      'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js',
      () => typeof (window as any).mermaid !== 'undefined',
    );
  }
  await mermaidScriptPromise;
  const mermaid = (window as any).mermaid;
  if (mermaid && !mermaidInitialized) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'loose',
      theme: document.documentElement.classList.contains('dark') ? 'dark' : 'default',
    });
    mermaidInitialized = true;
  }
}

async function ensureMathJaxLoaded() {
  if (!mathJaxScriptPromise) {
    (window as any).MathJax = {
      tex: {
        inlineMath: [['$', '$'], ['\\(', '\\)']],
        displayMath: [['$$', '$$'], ['\\[', '\\]']],
      },
      svg: { fontCache: 'global' },
      options: { skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'] },
      startup: { typeset: false },
    };
    mathJaxScriptPromise = loadScriptOnce(
      'https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js',
      () => typeof (window as any).MathJax?.typesetPromise === 'function',
    );
  }
  await mathJaxScriptPromise;
}

function MermaidBlock({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const renderMermaid = async () => {
      try {
        setError(null);
        await ensureMermaidLoaded();
        const mermaid = (window as any).mermaid;
        if (!mermaid) throw new Error('Mermaid is unavailable');
        const id = `mermaid-${Math.random().toString(36).slice(2)}`;
        const { svg } = await mermaid.render(id, code);
        if (!cancelled && ref.current) {
          ref.current.innerHTML = svg;
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Failed to render mermaid');
      }
    };
    renderMermaid();
    return () => { cancelled = true; };
  }, [code]);

  if (error) {
    return (
      <div className="rounded-lg border border-red-300 bg-red-50 dark:border-red-800/50 dark:bg-red-900/20 p-3 text-xs text-red-700 dark:text-red-300">
        Mermaid render error: {error}
      </div>
    );
  }
  return <div ref={ref} className="my-3 overflow-x-auto mermaid-block" />;
}

type LiveState = {
  phase: string;
  llmProgress: Record<string, { chars: number; status: string; phase?: string }>;
  streamingContent: Record<string, string>;
  updatedAt: number;
};

function liveStateKey(id: number) {
  return `rt_live_state_${id}`;
}

function readLiveState(id: number): LiveState | null {
  try {
    const raw = sessionStorage.getItem(liveStateKey(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      phase: String(parsed.phase || ''),
      llmProgress: (parsed.llmProgress || {}) as LiveState['llmProgress'],
      streamingContent: (parsed.streamingContent || {}) as Record<string, string>,
      updatedAt: Number(parsed.updatedAt || 0),
    };
  } catch {
    return null;
  }
}

function writeLiveState(id: number, state: LiveState) {
  try {
    sessionStorage.setItem(liveStateKey(id), JSON.stringify(state));
  } catch {
    // Ignore storage quota/security errors.
  }
}

function clearLiveState(id: number) {
  try {
    sessionStorage.removeItem(liveStateKey(id));
  } catch {
    // Ignore storage errors.
  }
}

const MarkdownRendererBase = ({ content }: { content: string }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const typesetMath = async () => {
      try {
        await ensureMathJaxLoaded();
        if (cancelled || !containerRef.current) return;
        const mathJax = (window as any).MathJax;
        if (mathJax?.typesetPromise) {
          await mathJax.typesetPromise([containerRef.current]);
        }
      } catch {
        // Keep raw markdown if math engine cannot be loaded.
      }
    };
    typesetMath();
    return () => { cancelled = true; };
  }, [content]);

  return (
    <div ref={containerRef} className="markdown-body">
      <ReactMarkdown 
        remarkPlugins={[remarkGfm]} 
        rehypePlugins={[rehypeHighlight]}
        components={{
          h1: ({ node, ...props }) => <h1 className="md-title md-title-1" {...props} />,
          h2: ({ node, ...props }) => <h2 className="md-title md-title-2" {...props} />,
          h3: ({ node, ...props }) => <h3 className="md-title md-title-3" {...props} />,
          h4: ({ node, ...props }) => <h4 className="md-title md-title-4" {...props} />,
          h5: ({ node, ...props }) => <h5 className="md-title md-title-5" {...props} />,
          h6: ({ node, ...props }) => <h6 className="md-title md-title-6" {...props} />,
          ul: ({ node, ...props }) => <ul className="md-list md-list-ul" {...props} />,
          ol: ({ node, ...props }) => <ol className="md-list md-list-ol" {...props} />,
          li: ({ node, ...props }) => <li className="md-list-item" {...props} />,
          p: ({ node, ...props }) => <p className="md-paragraph" {...props} />,
          blockquote: ({ node, ...props }) => <blockquote className="md-quote" {...props} />,
          hr: ({ node, ...props }) => <hr className="md-hr" {...props} />,
          table: ({ node, ...props }) => <div className="md-table-wrap"><table className="md-table" {...props} /></div>,
          th: ({ node, ...props }) => <th className="md-th" {...props} />,
          td: ({ node, ...props }) => <td className="md-td" {...props} />,
          pre: ({ node, ...props }) => <pre className="md-pre" {...props} />,
          a: ({ node, ...props }) => <a className="md-link" target="_blank" rel="noreferrer" {...props} />,
          code: ({ node, className, children, ...props }: any) => {
            const inline = !className || !/language-/.test(className);
            if (inline) return <code className="md-inline-code" {...props}>{children}</code>;
            const language = /language-(\w+)/.exec(className || '')?.[1]?.toLowerCase();
            const raw = String(children || '').replace(/\n$/, '');
            if (language === 'mermaid') {
              return <MermaidBlock code={raw} />;
            }
            return <code className={className} {...props}>{children}</code>;
          },
        }}
      >
        {normalizeMarkdown(content)}
      </ReactMarkdown>
    </div>
  );
};

const MarkdownRenderer = React.memo(
  MarkdownRendererBase,
  (prev, next) => prev.content === next.content,
);
MarkdownRenderer.displayName = 'MarkdownRenderer';

const SummaryModal = ({ isOpen, onClose, content, title, onDownload, onCopy }: {
  isOpen: boolean;
  onClose: () => void;
  content: string;
  title: string;
  onDownload?: () => void;
  onCopy?: (text: string) => void | Promise<void>;
}) => {
  const handleCopy = useCallback(() => {
    if (onCopy) {
      void onCopy(content || '');
      return;
    }
    void copyTextWithFallback(content || '');
  }, [content, onCopy]);

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
          <div className="flex items-center gap-1.5">
            <button
              onClick={handleCopy}
              className="p-1.5 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-full transition-colors"
              title="Copy"
            >
              <Copy className="w-4 h-4 text-slate-500" />
            </button>
            {onDownload && (
              <button onClick={onDownload} className="p-1.5 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-full transition-colors" title="Download">
                <Download className="w-4 h-4 text-slate-500" />
              </button>
            )}
            <button onClick={onClose} className="p-1 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-full transition-colors">
              <X className="w-5 h-5 text-slate-500" />
            </button>
          </div>
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
  const [llmProgress, setLlmProgress] = useState<Record<string, { chars: number; status: string; phase?: string }> | null>(null);
  const [streamingContent, setStreamingContent] = useState<Record<string, string>>({});
  const [preparingAgents, setPreparingAgents] = useState(false);

  // UI state
  const [inputText, setInputText] = useState('');
  const [sendingInput, setSendingInput] = useState(false);
  const [isLeftSidebarOpen, setIsLeftSidebarOpen] = useState(true);
  const [isRightSidebarOpen, setIsRightSidebarOpen] = useState(false);
  const [summaryModalOpen, setSummaryModalOpen] = useState(false);
  const [summaryContent, setSummaryContent] = useState('');
  const [summaryTitle, setSummaryTitle] = useState('');
  const [summaryDownloadUrl, setSummaryDownloadUrl] = useState('');
  const [summarizing, setSummarizing] = useState(false);
  const [summaryProgress, setSummaryProgress] = useState('');
  const [summarizingMsgId, setSummarizingMsgId] = useState<number | null>(null);
  const [streamingSummaries, setStreamingSummaries] = useState<Record<number, string>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newDebateOpen, setNewDebateOpen] = useState(false);
  const [showAgents, setShowAgents] = useState(false);
  const [showHeaderMenu, setShowHeaderMenu] = useState(false);
  const [editingMsgIdx, setEditingMsgIdx] = useState<number | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const [toast, setToast] = useState<{ id: number; text: string; type: 'success' | 'error' } | null>(null);

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
  const observerTextRef = useRef('');

  const scrollRef = useRef<HTMLDivElement>(null);
  const observerScrollRef = useRef<HTMLDivElement>(null);
  const isMainNearBottomRef = useRef(true);
  const isObserverNearBottomRef = useRef(true);
  const liveStateRef = useRef<Record<number, LiveState>>({});
  const streamRef = useRef<AbortController | null>(null);
  const summaryStreamRef = useRef<AbortController | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const summarizeAutoRef = useRef(false);
  const summarizeAutoBlockUntilRef = useRef(0);
  const summarizeRunningCooldownRef = useRef(0);
  const toastTimerRef = useRef<number | null>(null);

  const persistLiveState = useCallback((id: number, patch: Partial<LiveState>) => {
    const prev = liveStateRef.current[id] || {
      phase: '',
      llmProgress: {},
      streamingContent: {},
      updatedAt: Date.now(),
    };
    const next: LiveState = {
      phase: patch.phase ?? prev.phase,
      llmProgress: patch.llmProgress ?? prev.llmProgress,
      streamingContent: patch.streamingContent ?? prev.streamingContent,
      updatedAt: Date.now(),
    };
    liveStateRef.current[id] = next;
    writeLiveState(id, next);
  }, []);

  const removeLiveState = useCallback((id: number) => {
    delete liveStateRef.current[id];
    clearLiveState(id);
  }, []);

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
    listLLMProviders().then(setProviders).catch(() => {});
  }, []);

  // Keep observer config consistent with latest provider list.
  useEffect(() => {
    if (!providers.length) return;
    const selected = providers.find(p => p.id === observerConfig.providerId);
    if (!selected) {
      const first = providers[0];
      setObserverConfig({ providerId: first.id, provider: first.provider, model: first.models[0]?.model || '' });
      return;
    }
    const hasModel = selected.models.some(m => m.model === observerConfig.model);
    if (!observerConfig.provider || observerConfig.provider !== selected.provider || !observerConfig.model || !hasModel) {
      setObserverConfig({
        providerId: selected.id,
        provider: selected.provider,
        model: selected.models[0]?.model || '',
      });
    }
  }, [providers, observerConfig.providerId, observerConfig.provider, observerConfig.model]);

  // Auto-scroll only when user is already near the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !isMainNearBottomRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages, streamingContent, streamingSummaries]);
  useEffect(() => {
    const el = observerScrollRef.current;
    if (!el || !isObserverNearBottomRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [observerMessages, observerStreamText]);

  // Polling for already-running discussions
  const startPolling = useCallback(() => {
    if (pollRef.current || !activeId) return;
    pollRef.current = setInterval(async () => {
      try {
        const d = await getDiscussion(activeId);
        setMessages(d.messages || []);
        setPhase(d.status);
        persistLiveState(activeId, { phase: d.status });
        setAgents(d.agents || []);
        if (!RUNNING_STATUSES.includes(d.status)) {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          removeLiveState(activeId);
          setDiscStatus(d.status === 'waiting_input' ? 'waiting_input' : d.status === 'completed' ? 'completed' : 'error');
        }
      } catch {}
    }, 2500);
  }, [activeId, persistLiveState, removeLiveState]);

  // Load discussion detail when activeId changes
  useEffect(() => {
    streamRef.current?.abort();
    streamRef.current = null;
    summaryStreamRef.current?.abort();
    summaryStreamRef.current = null;
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    observerStreamRef.current?.abort();
    isMainNearBottomRef.current = true;
    isObserverNearBottomRef.current = true;
    summarizeAutoRef.current = false;
    setSummarizing(false);
    setSummaryProgress('');
    setSummarizingMsgId(null);
    setStreamingSummaries({});
    if (!activeId) {
      setDetail(null);
      setMessages([]);
      setAgents([]);
      setDiscStatus('loading');
      setStreamingContent({});
      setLlmProgress(null);
      return;
    }

    const load = async () => {
      setDiscStatus('loading');
      setError(null);
      setLlmProgress(null);
      setStreamingContent({});
      setSummarizing(false);
      setSummaryProgress('');
      setSummarizingMsgId(null);
      setStreamingSummaries({});
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

        if (d.status === 'completed') {
          setDiscStatus('completed');
          removeLiveState(activeId);
        }
        else if (d.status === 'waiting_input') {
          setDiscStatus('waiting_input');
          removeLiveState(activeId);
        }
        else if (d.status === 'failed') {
          setDiscStatus('error');
          setError('Discussion failed');
          removeLiveState(activeId);
        }
        else if (d.status === 'created') {
          setDiscStatus('ready');
          removeLiveState(activeId);
          if (!d.agents?.length) {
            setPreparingAgents(true);
            try {
              const prepared = await prepareAgents(activeId);
              setAgents(prepared);
            } catch {} finally { setPreparingAgents(false); }
          }
        } else if (RUNNING_STATUSES.includes(d.status)) {
          setDiscStatus('running');
          const cached = liveStateRef.current[activeId] || readLiveState(activeId);
          if (cached) {
            liveStateRef.current[activeId] = cached;
            if (cached.phase) setPhase(cached.phase);
            if (Object.keys(cached.llmProgress).length) setLlmProgress(cached.llmProgress);
            if (Object.keys(cached.streamingContent).length) setStreamingContent(cached.streamingContent);
          }
          startPolling();
        }
      } catch (e: unknown) {
        setDiscStatus('error');
        setError(e instanceof Error ? e.message : 'Failed to load');
      }
    };
    load();
    return () => {
      streamRef.current?.abort();
      streamRef.current = null;
      summaryStreamRef.current?.abort();
      summaryStreamRef.current = null;
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [activeId, startPolling, removeLiveState]);

  // --- Handlers ---

  const startDiscussionStream = useCallback(async (options?: { singleRound?: boolean | null }) => {
    if (!activeId) return;
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setDiscStatus('running');
    setError(null);
    const controller = streamDiscussion(
      activeId,
      (event: DiscussionEvent) => {
        if (event.event_type === 'phase_change') {
          const nextPhase = event.phase || '';
          setPhase(nextPhase);
          persistLiveState(activeId, { phase: nextPhase });
          setLlmProgress(prev => {
            if (!prev) return prev;
            const next: Record<string, { chars: number; status: string; phase?: string }> = {};
            for (const [name, entry] of Object.entries(prev)) {
              const agent = agents.find(a => a.name === name);
              if (!agent) continue;
              if (roleOwnsPhase(agent.role, nextPhase)) {
                next[name] = { ...entry, phase: nextPhase };
              }
            }
            persistLiveState(activeId, { llmProgress: next });
            return Object.keys(next).length ? next : null;
          });
          setStreamingContent(prev => {
            const next: Record<string, string> = {};
            for (const [name, content] of Object.entries(prev)) {
              const agent = agents.find(a => a.name === name);
              if (agent && roleOwnsPhase(agent.role, nextPhase)) {
                next[name] = content;
              }
            }
            persistLiveState(activeId, { streamingContent: next });
            return next;
          });
        }
        if (event.event_type === 'message') {
          const roleRaw = String(event.agent_role || 'panelist').toLowerCase();
          const normalizedRole: MessageResponse['agent_role'] =
            roleRaw === 'host' || roleRaw === 'panelist' || roleRaw === 'critic' || roleRaw === 'user'
              ? roleRaw
              : 'panelist';
          const normalizedMessage: MessageResponse = {
            id: event.message_id ?? Date.now(),
            agent_name: event.agent_name || '',
            agent_role: normalizedRole,
            content: event.content || '',
            summary: null,
            round_number: event.round_number ?? 0,
            cycle_index: event.cycle_index ?? 0,
            phase: event.phase ?? null,
            created_at: event.created_at || new Date().toISOString(),
          };
          setMessages(prev => [...prev, normalizedMessage]);
          if (event.agent_name) {
            setLlmProgress(prev => {
              if (!prev) return prev;
              const next = { ...prev };
              delete next[event.agent_name!];
              persistLiveState(activeId, { llmProgress: next });
              return Object.keys(next).length ? next : null;
            });
            setStreamingContent(prev => {
              const next = { ...prev };
              delete next[event.agent_name!];
              persistLiveState(activeId, { streamingContent: next });
              return next;
            });
          }
        }
        if (event.event_type === 'llm_progress') {
          setLlmProgress(prev => {
            const prevEntry = prev?.[event.agent_name!];
            const next = {
              ...prev,
              [event.agent_name!]: {
                chars: event.chars_received || 0,
                status: event.llm_status || '',
                phase: event.phase || prevEntry?.phase || phase,
              },
            };
            persistLiveState(activeId, { llmProgress: next });
            return next;
          });
          if (event.content && event.phase !== 'round_summary') {
            setStreamingContent(prev => {
              const next = { ...prev, [event.agent_name!]: event.content! };
              persistLiveState(activeId, { streamingContent: next });
              return next;
            });
          }
        }
      },
      (errMsg) => {
        setDiscStatus('error');
        setError(errMsg);
        setLlmProgress(null);
        setStreamingContent({});
        streamRef.current = null;
        removeLiveState(activeId);
      },
      (evt: DiscussionEvent) => {
        setLlmProgress(null);
        setStreamingContent({});
        streamRef.current = null;
        removeLiveState(activeId);
        getDiscussion(activeId).then(d => {
          setDetail(d);
          setMessages(d.messages || []);
          setAgents(d.agents || []);
          setDiscStatus(evt.event_type === 'complete' ? 'completed' : 'waiting_input');
          refreshList();
        });
      },
      options,
    );
    streamRef.current = controller;
  }, [activeId, phase, persistLiveState, removeLiveState, refreshList]);

  // Auto-reattach live stream for running discussions (supports tab switch / refresh recovery).
  useEffect(() => {
    if (!activeId || discStatus !== 'running') return;
    if (streamRef.current) return;
    startDiscussionStream();
  }, [activeId, discStatus, startDiscussionStream]);

  const handleStop = useCallback(async () => {
    streamRef.current?.abort();
    streamRef.current = null;
    summaryStreamRef.current?.abort();
    summaryStreamRef.current = null;
    if (activeId) try { await stopDiscussion(activeId); } catch {}
    setLlmProgress(null);
    setStreamingContent({});
    setSummarizing(false);
    setSummaryProgress('');
    setSummarizingMsgId(null);
    setStreamingSummaries({});
    setDiscStatus('waiting_input');
    setPhase('');
    if (activeId) removeLiveState(activeId);
    refreshList();
  }, [activeId, refreshList, removeLiveState]);

  const handleResume = useCallback(() => {
    if (!activeId || discStatus === 'running') return;
    setError(null);
    startDiscussionStream();
  }, [activeId, discStatus, startDiscussionStream]);

  const handleReset = useCallback(async () => {
    streamRef.current?.abort();
    streamRef.current = null;
    summaryStreamRef.current?.abort();
    summaryStreamRef.current = null;
    if (activeId) try { await resetDiscussion(activeId); } catch {}
    setMessages([]);
    setLlmProgress(null);
    setStreamingContent({});
    setSummarizing(false);
    setSummaryProgress('');
    setSummarizingMsgId(null);
    setStreamingSummaries({});
    setPhase('');
    setError(null);
    setDiscStatus('ready');
    if (activeId) removeLiveState(activeId);
    if (activeId) {
      setPreparingAgents(true);
      try { setAgents(await prepareAgents(activeId)); } catch {} finally { setPreparingAgents(false); }
    }
  }, [activeId, removeLiveState]);

  const handleUserInput = useCallback(async () => {
    const text = inputText.trim();
    if (!text || sendingInput || !activeId) return;
    const tempId = Date.now();
    setSendingInput(true);
    setMessages(prev => [...prev, {
      id: tempId, agent_name: 'User', agent_role: 'user', content: text,
      summary: null, round_number: 0, cycle_index: 0, phase: 'user_input', created_at: new Date().toISOString(),
    } as MessageResponse]);
    setInputText('');
    try {
      const saved = await submitUserInput(activeId, text);
      if (saved?.id) {
        setMessages(prev => prev.map(m => (
          m.id === tempId ? { ...m, id: saved.id, content: saved.content || text } : m
        )));
      }
      if (discStatus !== 'running') { setSendingInput(false); startDiscussionStream(); return; }
    } catch (e: unknown) {
      setMessages(prev => prev.filter(m => m.id !== tempId));
      setError(e instanceof Error ? e.message : 'Send failed');
    } finally { setSendingInput(false); }
  }, [activeId, inputText, sendingInput, discStatus, startDiscussionStream]);

  const handleDeleteDiscussion = useCallback(async (id: number) => {
    try { await deleteDiscussion(id); } catch {}
    setDiscussions(prev => prev.filter(d => d.id !== id));
    if (activeId === id) setActiveId(null);
  }, [activeId]);

  const showToast = useCallback((text: string, type: 'success' | 'error' = 'success') => {
    const id = Date.now();
    setToast({ id, text, type });
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToast(prev => (prev?.id === id ? null : prev));
      toastTimerRef.current = null;
    }, 1500);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  const copyToClipboard = useCallback(async (text: string) => {
    const ok = await copyTextWithFallback(text);
    showToast(ok ? '已完成复制' : '复制失败，请检查浏览器权限', ok ? 'success' : 'error');
  }, [showToast]);

  const openSummary = (content: string, title = 'Summary Details', downloadUrl = '') => {
    setSummaryContent(content); setSummaryTitle(title); setSummaryDownloadUrl(downloadUrl); setSummaryModalOpen(true);
  };

  const handleDownloadConversation = useCallback(() => {
    if (!detail) return;

    const title = detail.title || detail.topic || `discussion-${detail.id}`;
    const lines: string[] = [];
    lines.push(`# ${title}`);

    if (detail.title && detail.topic && detail.title !== detail.topic) {
      lines.push('', `> 主题: ${detail.topic}`);
    }

    lines.push(
      '',
      `- ID: ${detail.id}`,
      `- 模式: ${detail.mode || '-'}`,
      `- 状态: ${detail.status || '-'}`,
      `- 轮次: ${detail.current_round}/${detail.max_rounds}`,
      `- 创建时间: ${toDateTime(detail.created_at)}`,
      `- 更新时间: ${toDateTime(detail.updated_at)}`,
    );

    if (agents.length > 0) {
      lines.push('', '## 参与者配置', '', '| 角色 | 名称 | 模型 |', '| --- | --- | --- |');
      agents.forEach((agent) => {
        lines.push(
          `| ${toMarkdownCell(ROLE_LABELS[agent.role] || agent.role)} | ${toMarkdownCell(agent.name)} | ${toMarkdownCell(`${agent.provider}/${agent.model}`)} |`,
        );
      });
    }

    if (detail.materials && detail.materials.length > 0) {
      lines.push('', '## 参考资料', '');
      detail.materials.forEach((material) => {
        const size = material.file_size ? `${(material.file_size / 1024).toFixed(1)} KB` : '-';
        lines.push(`- ${material.filename} (${material.file_type || '-'}, ${size})`);
      });
    }

    const exportMessages: MessageResponse[] = [...messages];
    if (detail.topic && (!exportMessages.length || exportMessages[0]?.agent_role !== 'user')) {
      exportMessages.unshift({
        id: -detail.id,
        agent_name: '用户',
        agent_role: 'user',
        content: detail.topic,
        summary: null,
        round_number: 0,
        cycle_index: 0,
        phase: 'user_input',
        created_at: detail.created_at,
      });
    }

    if (exportMessages.length > 0) {
      lines.push('', '## 讨论记录', '');
      let lastRound = -1;
      exportMessages.forEach((msg) => {
        if (msg.round_number !== lastRound) {
          lastRound = msg.round_number;
          lines.push(`### 第 ${msg.round_number + 1} 轮`, '');
        }
        const role = ROLE_LABELS[msg.agent_role] || msg.agent_role;
        const phaseLabel = PHASE_LABELS[msg.phase || ''] || msg.phase || '-';
        lines.push(`**${msg.agent_name}** (${role} | ${phaseLabel} | ${toDateTime(msg.created_at)})`, '');
        lines.push(msg.content || '', '');
      });
    }

    const runningStreams = Object.entries(streamingContent).filter(([, content]) => !!content);
    if (runningStreams.length > 0) {
      lines.push('', '## 进行中输出片段', '');
      runningStreams.forEach(([agentName, content]) => {
        lines.push(`### ${agentName}`, '', content, '');
      });
    }

    if (detail.final_summary) {
      lines.push('', '## 最终总结', '', detail.final_summary);
    }

    if (observerMessages.length > 0 || observerStreamText) {
      lines.push('', '## Observer 记录', '');
      observerMessages.forEach((msg) => {
        lines.push(`**${msg.role}** (${toDateTime(msg.created_at)})`, '', msg.content || '', '');
      });
      if (observerStreamText) {
        lines.push('**observer (streaming)**', '', observerStreamText, '');
      }
    }

    const markdown = `${lines.join('\n').trim()}\n`;
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const timestamp = new Date().toISOString().replace(/:/g, '-').slice(0, 19);
    a.href = url;
    a.download = `${toSafeFileName(title)}_${timestamp}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [detail, agents, messages, streamingContent, observerMessages, observerStreamText]);

  const handleSummarize = useCallback(async () => {
    if (!activeId || summarizing) return;
    setSummarizing(true);
    setSummaryProgress('');
    setSummarizingMsgId(null);
    setStreamingSummaries({});
    await new Promise<void>((resolve) => {
      const controller = streamSummarize(
        activeId,
        (evtRaw) => {
          const event = evtRaw as SummaryEvent & { round_number?: number; event_type: string };
          const msgId = Number(event.message_id ?? event.round_number ?? 0) || null;
          if (event.event_type === 'summary_progress') {
            const nextProgress = String(event.content || '');
            setSummaryProgress(prev => (prev === nextProgress ? prev : nextProgress));
            setSummarizingMsgId(prev => (prev === msgId ? prev : msgId));
            return;
          }
          if (event.event_type === 'summary_chunk') {
            if (!msgId) return;
            setSummarizingMsgId(prev => (prev === msgId ? prev : msgId));
            setStreamingSummaries(prev => {
              const nextContent = event.content || '';
              if (prev[msgId] === nextContent) return prev;
              return { ...prev, [msgId]: nextContent };
            });
            return;
          }
          if (event.event_type === 'summary_done') {
            if (!msgId) return;
            setMessages(prev => prev.map(m => (m.id === msgId ? { ...m, summary: event.content || '' } : m)));
            setStreamingSummaries(prev => {
              const next = { ...prev };
              delete next[msgId];
              return next;
            });
            setSummarizingMsgId(null);
            return;
          }
          if (event.event_type === 'summary_error') {
            setError(event.content || 'Summary failed');
          }
        },
        (err) => {
          setError(err || 'Summary failed');
          summarizeAutoBlockUntilRef.current = Date.now() + 10_000;
          setSummarizing(false);
          setSummaryProgress('');
          setSummarizingMsgId(null);
          setStreamingSummaries({});
          summaryStreamRef.current = null;
          resolve();
        },
        () => {
          setSummarizing(false);
          setSummaryProgress('');
          setSummarizingMsgId(null);
          setStreamingSummaries({});
          summaryStreamRef.current = null;
          resolve();
        },
      );
      summaryStreamRef.current = controller;
    });
  }, [activeId, summarizing]);

  // Observer chat
  const handleObserverSend = useCallback(async () => {
    const text = observerInput.trim();
    if (!text || observerStreaming) return;
    if (!activeId) {
      setError('No active discussion selected for observer chat');
      return;
    }
    const selected = providers.find(p => p.id === observerConfig.providerId);
    const resolvedProvider = observerConfig.provider || selected?.provider || '';
    const resolvedModel = observerConfig.model || selected?.models[0]?.model || '';
    const resolvedProviderId = observerConfig.providerId ?? selected?.id ?? null;
    if (!resolvedProvider || !resolvedModel) {
      setError('Observer model is not configured. Please choose a provider/model first.');
      return;
    }
    const userMsg: ObserverMessageResponse = { id: Date.now(), role: 'user', content: text, created_at: new Date().toISOString() };
    setObserverMessages(prev => [...prev, userMsg]);
    setObserverInput('');
    setObserverStreaming(true);
    setObserverStreamText('');
    setObserverConfig(prev => ({
      providerId: resolvedProviderId,
      provider: resolvedProvider,
      model: resolvedModel,
    }));
    observerTextRef.current = '';
    const ctrl = streamObserverChat(
      activeId,
      { content: text, provider: resolvedProvider, model: resolvedModel, provider_id: resolvedProviderId ?? undefined },
      (chunk) => { observerTextRef.current += chunk; setObserverStreamText(prev => prev + chunk); },
      (err) => { setObserverStreamText(prev => prev + `\n[Error: ${err}]`); setObserverStreaming(false); },
      () => {
        const text = observerTextRef.current;
        if (text) setObserverMessages(msgs => [...msgs, { id: Date.now() + 1, role: 'observer', content: text, created_at: new Date().toISOString() }]);
        setObserverStreamText('');
        setObserverStreaming(false);
      },
    );
    observerStreamRef.current = ctrl;
  }, [activeId, observerInput, observerStreaming, observerConfig, providers]);

  const handleObserverClear = useCallback(async () => {
    if (observerStreaming) { observerStreamRef.current?.abort(); setObserverStreaming(false); setObserverStreamText(''); }
    if (activeId) try { await clearObserverHistory(activeId); } catch {}
    setObserverMessages([]);
  }, [activeId, observerStreaming]);

  const selectedProviderObj = providers.find(p => p.id === observerConfig.providerId);
  const observerModels = selectedProviderObj?.models || [];
  const displayMessages = useMemo(() => {
    if (detail?.topic && (!messages.length || messages[0]?.agent_role !== 'user')) {
      return [{ id: null, agent_name: '用户', agent_role: 'user', content: detail.topic, phase: 'user_input', created_at: detail.created_at, round_number: 0 } as unknown as MessageResponse, ...messages];
    }
    return messages;
  }, [messages, detail]);

  const handleSaveEditedUserMessage = useCallback(async (msg: MessageResponse, displayIndex: number) => {
    if (!activeId) return;
    if (discStatus === 'running') {
      showToast('讨论进行中，请先暂停后再编辑', 'error');
      return;
    }

    const nextText = editingContent.trim();
    if (!nextText || nextText === msg.content) {
      setEditingMsgIdx(null);
      return;
    }

    const msgId = typeof (msg as any).id === 'number' ? (msg as any).id as number : null;
    const isTopicMessage = msgId == null;
    const followingDisplayCount = Math.max(0, displayMessages.length - displayIndex - 1);
    if (followingDisplayCount > 0) {
      const confirmed = window.confirm(
        `编辑后将删除后续 ${followingDisplayCount} 条消息，并基于新内容重新生成一轮，是否继续？`,
      );
      if (!confirmed) return;
    }

    try {
      if (isTopicMessage) {
        await updateTopic(activeId, nextText);
      } else {
        await updateMessage(activeId, msgId, nextText);
      }
      await truncateMessagesAfter(activeId, isTopicMessage ? null : msgId);

      if (isTopicMessage) {
        setMessages([]);
        if (detail) setDetail({ ...detail, topic: nextText });
      } else {
        setMessages(prev => {
          const idx = prev.findIndex(m => m.id === msgId);
          if (idx < 0) return prev;
          return prev
            .slice(0, idx + 1)
            .map((m, i) => (i === idx ? { ...m, content: nextText, summary: null } : m));
        });
      }

      setEditingMsgIdx(null);
      setStreamingSummaries({});
      setSummarizing(false);
      setSummaryProgress('');
      setSummarizingMsgId(null);
      setLlmProgress(null);
      setStreamingContent({});
      setPhase('');
      setError(null);
      setDiscStatus('waiting_input');
      removeLiveState(activeId);

      showToast(
        followingDisplayCount > 0
          ? `已删除后续 ${followingDisplayCount} 条消息，${(detail?.status === 'completed') ? '正在补跑一轮' : '按原轮次继续讨论'}`
          : ((detail?.status === 'completed') ? '修改已保存，正在补跑一轮' : '修改已保存，按原轮次继续讨论'),
      );
      const shouldRunSingleRound = detail?.status === 'completed';
      startDiscussionStream({ singleRound: shouldRunSingleRound });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '修改失败');
      showToast('修改失败', 'error');
    }
  }, [
    activeId,
    detail,
    discStatus,
    displayMessages.length,
    editingContent,
    removeLiveState,
    showToast,
    startDiscussionStream,
  ]);

  const unsummarizedCount = messages.filter(
    m => m.agent_role !== 'user' && (m.content || '').length >= 200 && !m.summary,
  ).length;

  useEffect(() => {
    if (!activeId) return;
    if (!(discStatus === 'running' || discStatus === 'completed' || discStatus === 'waiting_input')) return;
    if (unsummarizedCount <= 0) return;
    if (Date.now() < summarizeAutoBlockUntilRef.current) return;
    if (discStatus === 'running') {
      const now = Date.now();
      if (now < summarizeRunningCooldownRef.current) return;
      const hasActiveStream = !!llmProgress && Object.values(llmProgress).some(
        (v) => v?.status === 'streaming' || v?.status === 'waiting',
      );
      if (hasActiveStream) return;
      summarizeRunningCooldownRef.current = now + 15000;
    }
    if (summarizing || summarizeAutoRef.current) return;
    summarizeAutoRef.current = true;
    handleSummarize().finally(() => { summarizeAutoRef.current = false; });
  }, [activeId, discStatus, unsummarizedCount, summarizing, handleSummarize, llmProgress]);

  const activeDisc = discussions.find(d => d.id === activeId);
  const isRunning = RUNNING_STATUSES.includes(detail?.status || '');
  const latestMessageByAgent = (() => {
    const byAgent = new Map<string, MessageResponse>();
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (!byAgent.has(m.agent_name)) byAgent.set(m.agent_name, m);
    }
    return byAgent;
  })();
  const formatChars = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const agentProgressRows = agents
    .filter(a => a.role !== 'user')
    .map(a => {
      const live = llmProgress?.[a.name];
      const streamChars = streamingContent[a.name]?.length || 0;
      const chars = Math.max(live?.chars || 0, streamChars);
      const latest = latestMessageByAgent.get(a.name);
      const ownedNow = roleOwnsPhase(a.role, phase);
      const stepPhase = live?.phase || (ownedNow ? phase : latest?.phase || '');
      const stepLabel = PHASE_LABELS[stepPhase] || stepPhase || 'Idle';

      let statusText = 'idle';
      if (live?.status === 'streaming') statusText = 'streaming';
      else if (live?.status === 'waiting') statusText = 'waiting';
      else if (live?.status === 'done') statusText = 'done';
      else if (ownedNow) {
        const alreadyDoneCurrentPhase = messages.some(m => m.agent_name === a.name && m.phase === phase);
        statusText = alreadyDoneCurrentPhase ? 'done' : 'queued';
      } else if (latest?.phase) statusText = 'done';

      // Prefer stage-based wording while actively running so summary phases read as "总结中".
      if (stepPhase && ['streaming', 'waiting', 'queued'].includes(statusText)) {
        statusText = PHASE_LABELS[stepPhase] || stepPhase;
      }

      return {
        name: a.name,
        role: a.role,
        stepLabel,
        statusText,
        chars,
      };
    });

  return (
    <div className="flex h-screen w-full overflow-hidden font-sans">
      <SummaryModal isOpen={summaryModalOpen} onClose={() => { setSummaryModalOpen(false); setSummaryDownloadUrl(''); }} content={summaryContent} title={summaryTitle}
        onDownload={summaryDownloadUrl ? () => window.open(summaryDownloadUrl, '_blank') : undefined}
        onCopy={copyToClipboard}
      />
      <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} onProvidersChange={() => listLLMProviders().then(setProviders).catch(() => {})} />
      <NewDebateModal isOpen={newDebateOpen} onClose={() => setNewDebateOpen(false)} onCreated={(d) => { refreshList(); setActiveId(d.id); }} />
      <AgentConfigModal
        isOpen={!!editingAgent}
        onClose={() => setEditingAgent(null)}
        agent={editingAgent}
        discussionId={activeId}
        onSave={(updated) => setAgents(prev => prev.map(a => a.id === updated.id ? updated : a))}
        providers={providers}
        onCopy={copyToClipboard}
      />
      <AnimatePresence>
        {toast && (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, y: -12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            className={`fixed top-5 left-1/2 -translate-x-1/2 z-[90] px-4 py-2 rounded-lg text-sm font-medium shadow-lg border ${
              toast.type === 'success'
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-200 dark:border-emerald-700/40'
                : 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-200 dark:border-red-700/40'
            }`}
          >
            {toast.text}
          </motion.div>
        )}
      </AnimatePresence>

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
                  <div className="absolute right-0 mt-2 w-64 bg-white dark:bg-slate-800 rounded-xl shadow-xl border border-slate-200 dark:border-slate-700 py-1 z-50 max-h-96 overflow-y-auto">
                    <button onClick={() => { setShowHeaderMenu(false); if (discStatus === 'running') handleStop(); else handleResume(); }}
                      className="w-full text-left px-4 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2">
                      {discStatus === 'running' ? <Square className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                      {discStatus === 'running' ? 'Pause Discussion' : 'Continue Discussion'}
                    </button>
                    <button onClick={() => { setShowHeaderMenu(false); handleReset(); }}
                      className="w-full text-left px-4 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2">
                      <RefreshCw className="w-3.5 h-3.5" /> Reset & Replan
                    </button>
                    <button onClick={() => { setShowHeaderMenu(false); handleDownloadConversation(); }}
                      className="w-full text-left px-4 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2">
                      <Download className="w-3.5 h-3.5" /> Download Conversation
                    </button>
                    <div className="h-px bg-slate-200 dark:bg-slate-700 my-1" />
                    <button onClick={() => { setShowHeaderMenu(false); if (activeId) generateTitle(activeId).then(() => refreshList()); }}
                      className="w-full text-left px-4 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700">
                      Generate Title
                    </button>
                    {detail?.materials && detail.materials.length > 0 && (
                      <>
                        <div className="h-px bg-slate-200 dark:bg-slate-700 my-1" />
                        <div className="px-4 py-1.5 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Materials</div>
                        {detail.materials.map(m => (
                          <button key={m.id}
                            onClick={() => {
                              setShowHeaderMenu(false);
                              fetch(`/api/materials/${m.id}/content`).then(r => r.json()).then(d => {
                                openSummary(d.content, m.filename, `/api/materials/${m.id}/download`);
                              }).catch(() => window.open(`/api/materials/${m.id}/download`, '_blank'));
                            }}
                            className="w-full text-left px-4 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2 truncate">
                            <FileText className="w-3.5 h-3.5 shrink-0 text-violet-500" />
                            <span className="truncate">{m.filename}</span>
                            <span className="text-[10px] text-slate-400 shrink-0">{m.file_type}</span>
                          </button>
                        ))}
                      </>
                    )}
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
                      agent.role === 'host' ? 'border-blue-200 bg-blue-50 hover:bg-blue-100 dark:border-blue-800/50 dark:bg-blue-900/20 dark:hover:bg-blue-900/40' :
                      agent.role === 'critic' ? 'border-orange-200 bg-orange-50 hover:bg-orange-100 dark:border-orange-800/50 dark:bg-orange-900/20 dark:hover:bg-orange-900/40' :
                      'border-violet-200 bg-violet-50 hover:bg-violet-100 dark:border-violet-800/50 dark:bg-violet-900/20 dark:hover:bg-violet-900/40'
                    }`}>
                    <span className={`text-sm font-bold ${
                      agent.role === 'host' ? 'text-blue-700 dark:text-blue-400' :
                      agent.role === 'critic' ? 'text-orange-700 dark:text-orange-400' :
                      'text-violet-700 dark:text-violet-400'
                    }`}>{agent.name}</span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">{agent.provider}/{agent.model}</span>
                  </button>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div
          ref={scrollRef}
          onScroll={() => {
            const el = scrollRef.current;
            if (!el) return;
            isMainNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
          }}
          className="flex-1 overflow-y-auto px-4 py-4 scroll-smooth chat-container relative"
        >
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
            {(discStatus === 'completed' || discStatus === 'waiting_input') && summarizing && (
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                className="glass-card rounded-xl p-3 border border-emerald-200/70 dark:border-emerald-700/40 bg-emerald-50/70 dark:bg-emerald-900/10">
                <div className="flex items-center gap-2 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  正在使用总结模型压缩内容 {summaryProgress || '...'}
                </div>
              </motion.div>
            )}

            {/* Messages */}
            <AnimatePresence mode="popLayout">
              {displayMessages.map((msg, idx) => (
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
                        {msg.agent_role === 'user' ? (
                          editingMsgIdx === idx ? (
                            <div className="flex flex-col gap-2">
                              <textarea value={editingContent} onChange={e => setEditingContent(e.target.value)}
                                className="w-full p-3 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-white resize-y min-h-[160px]"
                                rows={7}
                                autoFocus />
                              <div className="flex gap-2 justify-end">
                                <button onClick={() => setEditingMsgIdx(null)} className="px-2 py-1 text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"><X className="w-3 h-3" /></button>
                                <button
                                  onClick={() => { void handleSaveEditedUserMessage(msg, idx); }}
                                  className="px-2 py-1 text-xs text-emerald-600 hover:text-emerald-700 dark:text-emerald-400"
                                >
                                  <Check className="w-3 h-3" />
                                </button>
                              </div>
                            </div>
                          ) : <MarkdownRenderer content={msg.content} />
                        ) : msg.summary || (msg.id && streamingSummaries[msg.id]) ? (
                          <>
                            <MarkdownRenderer content={msg.summary || (msg.id ? streamingSummaries[msg.id] || '' : '')} />
                            {!msg.summary && msg.id && streamingSummaries[msg.id] && (
                              <div className="mt-2 text-[11px] text-emerald-600 dark:text-emerald-300 inline-flex items-center gap-1.5">
                                <Loader2 className="w-3 h-3 animate-spin" />
                                总结中{summarizingMsgId === msg.id ? ` · ${summaryProgress || ''}` : ''}
                              </div>
                            )}
                            <button onClick={() => openSummary(msg.content, `Full message by ${msg.agent_name}`)}
                              className="mt-2 text-violet-600 dark:text-violet-400 text-xs hover:underline flex items-center gap-1">
                              <Maximize2 className="w-3 h-3" /> View full
                            </button>
                          </>
                        ) : ['synthesizing', 'round_summary'].includes(msg.phase || '') ? (
                          <MarkdownRenderer content={msg.content} />
                        ) : summarizingMsgId === msg.id ? (
                          <div className="text-[11px] text-emerald-600 dark:text-emerald-300 inline-flex items-center gap-1.5">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            总结中 · {summaryProgress || '准备中...'}
                          </div>
                        ) : (
                          <button onClick={() => openSummary(msg.content, `${msg.agent_name} — ${PHASE_LABELS[msg.phase || ''] || msg.phase}`)}
                            className="text-slate-500 dark:text-slate-400 text-xs hover:text-violet-600 dark:hover:text-violet-400 flex items-center gap-1">
                            <Maximize2 className="w-3 h-3" /> {msg.content.length >= 1000 ? `${(msg.content.length / 1000).toFixed(1)}k` : msg.content.length} 字符 · 点击查看
                          </button>
                        )}
                      </div>
                      <div className="absolute -bottom-3 right-6 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                        {msg.agent_role === 'user' && (
                          <button onClick={() => { setEditingMsgIdx(idx); setEditingContent(msg.content); }}
                            className="p-1.5 bg-white dark:bg-slate-700 rounded-full shadow-md text-slate-400 hover:text-emerald-500 hover:scale-110 transition" title="Edit">
                            <Pencil className="w-3 h-3" />
                          </button>
                        )}
                        <button onClick={() => { void copyToClipboard(msg.content); }}
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

            {Object.entries(streamingContent).map(([agentName, content]) => (
              <motion.div key={`stream-${agentName}`} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="flex gap-3">
                <div className="flex flex-col items-center pt-1 shrink-0">
                  <ModelAvatar provider={agents.find(a => a.name === agentName)?.provider} className="w-8 h-8" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="glass-card rounded-xl rounded-tl-none p-4 shadow-sm border-l-4 border-l-emerald-500">
                    <div className="flex items-center gap-2 mb-2 border-b border-slate-100 dark:border-slate-700/50 pb-2">
                      <span className="font-bold text-slate-900 dark:text-white text-sm">{agentName}</span>
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">streaming</span>
                    </div>
                    <MarkdownRenderer content={content} />
                  </div>
                </div>
              </motion.div>
            ))}

            {/* Live per-agent progress */}
            {discStatus === 'running' && agentProgressRows.length > 0 && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="glass-card rounded-xl p-3 border border-slate-200/60 dark:border-slate-700/60">
                <div className="flex items-center gap-2 text-xs font-semibold text-slate-600 dark:text-slate-300 mb-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-violet-500" />
                  Agent Live Progress
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {agentProgressRows.map((row) => (
                    <div key={row.name} className="rounded-lg border border-slate-200/60 dark:border-slate-700/60 px-3 py-2 bg-white/50 dark:bg-slate-800/30">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-slate-800 dark:text-slate-100 truncate">{row.name}</span>
                        <span className={`text-[10px] uppercase tracking-wide font-semibold ${
                          row.statusText === 'done' ? 'text-emerald-600 dark:text-emerald-300' :
                          ['规划中', '讨论中', '反思中', '总结中', '轮次总结中', '下一步规划中', 'streaming', 'waiting', 'queued'].includes(row.statusText) ? 'text-violet-600 dark:text-violet-300' :
                          'text-slate-500 dark:text-slate-400'
                        }`}>
                          {row.statusText}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">{row.stepLabel}</div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                        已接收 {formatChars(row.chars)} 字
                      </div>
                    </div>
                  ))}
                </div>
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

        <div
          ref={observerScrollRef}
          onScroll={() => {
            const el = observerScrollRef.current;
            if (!el) return;
            isObserverNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
          }}
          className="flex-1 overflow-y-auto p-4 space-y-4"
        >
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
                  <button onClick={() => { void copyToClipboard(msg.content); }}
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
              disabled={!observerInput.trim() || observerStreaming || !observerConfig.providerId || !observerConfig.model}
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
