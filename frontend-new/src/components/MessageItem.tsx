import React, { useRef, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Timer, RefreshCw, Maximize2, Loader2, Pencil, Copy, Trash2, Check, X } from 'lucide-react';
import { ModelAvatar } from './ModelAvatar';
import type { MessageResponse, AgentConfigResponse } from '../types';

const PHASE_LABELS: Record<string, string> = {
  planning: '规划中',
  discussing: '讨论中',
  reflecting: '反思中',
  synthesizing: '总结中',
  round_summary: '轮次总结中',
  next_step_planning: '下一步规划中',
};

function formatTime(ts: string) {
  const s = String(ts);
  const d = new Date(s.includes('Z') || s.includes('+') ? s : s + 'Z');
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (Date.now() - d.getTime() > 86400000) return d.toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' }) + ' ' + time;
  return time;
}

async function ensureMathJaxLoaded(): Promise<void> {
  if ((window as any).MathJax?.typesetPromise) return;
  return new Promise((resolve) => {
    const check = setInterval(() => {
      if ((window as any).MathJax?.typesetPromise) { clearInterval(check); resolve(); }
    }, 100);
    setTimeout(() => { clearInterval(check); resolve(); }, 5000);
  });
}

function normalizeMarkdown(content: string): string {
  return content.replace(/\\\[/g, '$$$$').replace(/\\\]/g, '$$$$').replace(/\\\(/g, '$').replace(/\\\)/g, '$');
}

const MarkdownContent = React.memo(({ content }: { content: string }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    const typesetMath = async () => {
      try {
        await ensureMathJaxLoaded();
        if (cancelled || !containerRef.current) return;
        const mathJax = (window as any).MathJax;
        if (mathJax?.typesetPromise) await mathJax.typesetPromise([containerRef.current]);
      } catch {}
    };
    void typesetMath();
    return () => { cancelled = true; };
  }, [content]);

  return (
    <div ref={containerRef} className="prose prose-sm dark:prose-invert max-w-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '');
            return match
              ? <code className={className} {...props}>{children}</code>
              : <code className="bg-slate-100 dark:bg-slate-800 px-1 py-0.5 rounded text-sm font-mono" {...props}>{children}</code>;
          },
        }}
      >
        {normalizeMarkdown(content)}
      </ReactMarkdown>
    </div>
  );
}, (prev, next) => prev.content === next.content);

export interface MessageItemProps {
  msg: MessageResponse;
  idx: number;
  agents: AgentConfigResponse[];
  streamingSummaries: Record<number, string>;
  summarizingMsgId: number | null;
  summaryProgress: string;
  editingMsgIdx: number | null;
  editingContent: string;
  activeId: number | null;
  onOpenSummary: (content: string, title: string) => void;
  onCopy: (text: string) => void | Promise<void>;
  onDelete: (msgId: number) => void;
  onEditStart: (idx: number, content: string) => void;
  onEditCancel: () => void;
  onEditContentChange: (content: string) => void;
  onEditSave: (msg: MessageResponse, idx: number) => void;
}

export const MessageItem = React.memo(function MessageItem({
  msg,
  idx,
  agents,
  streamingSummaries,
  summarizingMsgId,
  summaryProgress,
  editingMsgIdx,
  editingContent,
  onOpenSummary,
  onCopy,
  onDelete,
  onEditStart,
  onEditCancel,
  onEditContentChange,
  onEditSave,
  activeId,
}: MessageItemProps) {
  const isEditing = editingMsgIdx === idx;
  const agentProvider = agents.find(a => a.name === msg.agent_name)?.provider;

  const renderContent = useCallback(() => {
    if (msg.agent_role === 'user') {
      if (isEditing) {
        return (
          <div className="flex flex-col gap-2">
            <textarea
              value={editingContent}
              onChange={e => onEditContentChange(e.target.value)}
              className="w-full p-3 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-white resize-y min-h-[160px]"
              rows={7}
              autoFocus
            />
            <div className="flex gap-2 justify-end">
              <button onClick={onEditCancel} className="px-2 py-1 text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">
                <X className="w-3 h-3" />
              </button>
              <button
                onClick={() => onEditSave(msg, idx)}
                className="px-2 py-1 text-xs text-emerald-600 hover:text-emerald-700 dark:text-emerald-400"
              >
                <Check className="w-3 h-3" />
              </button>
            </div>
          </div>
        );
      }
      return <MarkdownContent content={msg.content} />;
    }

    if (msg.summary || (msg.id && streamingSummaries[msg.id])) {
      return (
        <>
          <MarkdownContent content={msg.summary || (msg.id ? streamingSummaries[msg.id] || '' : '')} />
          {!msg.summary && msg.id && streamingSummaries[msg.id] && (
            <div className="mt-2 text-[11px] text-emerald-600 dark:text-emerald-300 inline-flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" />
              总结中{summarizingMsgId === msg.id ? ` · ${summaryProgress || ''}` : ''}
            </div>
          )}
          <button
            onClick={() => onOpenSummary(msg.content, `Full message by ${msg.agent_name}`)}
            className="mt-2 text-violet-600 dark:text-violet-400 text-xs hover:underline flex items-center gap-1"
          >
            <Maximize2 className="w-3 h-3" /> View full
          </button>
        </>
      );
    }

    if (['synthesizing', 'round_summary'].includes(msg.phase || '')) {
      return <MarkdownContent content={msg.content} />;
    }

    if (summarizingMsgId === msg.id) {
      return (
        <div className="text-[11px] text-emerald-600 dark:text-emerald-300 inline-flex items-center gap-1.5">
          <Loader2 className="w-3 h-3 animate-spin" />
          总结中 · {summaryProgress || '准备中...'}
        </div>
      );
    }

    return (
      <button
        onClick={() => onOpenSummary(msg.content, `${msg.agent_name} — ${PHASE_LABELS[msg.phase || ''] || msg.phase}`)}
        className="text-slate-500 dark:text-slate-400 text-xs hover:text-violet-600 dark:hover:text-violet-400 flex items-center gap-1"
      >
        <Maximize2 className="w-3 h-3" /> {msg.content.length >= 1000 ? `${(msg.content.length / 1000).toFixed(1)}k` : msg.content.length} 字符 · 点击查看
      </button>
    );
  }, [msg, isEditing, editingContent, streamingSummaries, summarizingMsgId, summaryProgress, onOpenSummary, onEditCancel, onEditContentChange, onEditSave, idx]);

  return (
    <div className={`flex gap-3 group ${msg.agent_role === 'user' ? 'flex-row-reverse' : ''}`}>
      <div className="flex flex-col items-center pt-1 shrink-0">
        <ModelAvatar provider={agentProvider} className="w-8 h-8" />
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
            {renderContent()}
          </div>
          <div className="absolute -bottom-3 right-6 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
            {msg.agent_role === 'user' && (
              <button
                onClick={() => onEditStart(idx, msg.content)}
                className="p-1.5 bg-white dark:bg-slate-700 rounded-full shadow-md text-slate-400 hover:text-emerald-500 hover:scale-110 transition"
                title="Edit"
              >
                <Pencil className="w-3 h-3" />
              </button>
            )}
            <button
              onClick={() => onCopy(msg.content)}
              className="p-1.5 bg-white dark:bg-slate-700 rounded-full shadow-md text-slate-400 hover:text-blue-500 hover:scale-110 transition"
              title="Copy"
            >
              <Copy className="w-3 h-3" />
            </button>
            {msg.id && msg.agent_role !== 'user' && (
              <button
                onClick={() => { if (activeId && msg.id) onDelete(msg.id); }}
                className="p-1.5 bg-white dark:bg-slate-700 rounded-full shadow-md text-slate-400 hover:text-red-500 hover:scale-110 transition"
                title="Delete"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
