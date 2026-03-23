import React, { useRef, useEffect, useCallback } from 'react';
import { VariableSizeList as List } from 'react-window';
import { motion } from 'motion/react';
import { Loader2 } from 'lucide-react';
import { ModelAvatar } from './ModelAvatar';
import { MessageItem } from './MessageItem';
import type { MessageResponse, AgentConfigResponse } from '../types';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

// Estimate row height based on content length
function estimateHeight(msg: MessageResponse): number {
  const contentLen = msg.content?.length || 0;
  const baseHeight = 100; // header + padding
  const charsPerLine = 80;
  const lineHeight = 22;
  const lines = Math.ceil(contentLen / charsPerLine);
  return baseHeight + Math.min(lines * lineHeight, 600);
}

interface MessageListProps {
  messages: MessageResponse[];
  agents: AgentConfigResponse[];
  streamingContent: Record<string, string>;
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

export const MessageList = React.memo(function MessageList({
  messages,
  agents,
  streamingContent,
  streamingSummaries,
  summarizingMsgId,
  summaryProgress,
  editingMsgIdx,
  editingContent,
  activeId,
  onOpenSummary,
  onCopy,
  onDelete,
  onEditStart,
  onEditCancel,
  onEditContentChange,
  onEditSave,
}: MessageListProps) {
  const listRef = useRef<List>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const heightCacheRef = useRef<Record<number, number>>({});
  const prevMessagesLenRef = useRef(0);

  const getItemSize = useCallback((index: number) => {
    if (heightCacheRef.current[index] !== undefined) {
      return heightCacheRef.current[index];
    }
    const msg = messages[index];
    if (!msg) return 120;
    const h = estimateHeight(msg);
    heightCacheRef.current[index] = h;
    return h;
  }, [messages]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (messages.length > prevMessagesLenRef.current && listRef.current) {
      listRef.current.scrollToItem(messages.length - 1, 'end');
    }
    prevMessagesLenRef.current = messages.length;
  }, [messages.length]);

  // Reset height cache when messages change
  useEffect(() => {
    heightCacheRef.current = {};
    if (listRef.current) {
      listRef.current.resetAfterIndex(0);
    }
  }, [messages]);

  const containerHeight = 600; // fallback; actual height comes from flex container

  const Row = useCallback(({ index, style }: { index: number; style: React.CSSProperties }) => {
    const msg = messages[index];
    if (!msg) return null;
    return (
      <div style={{ ...style, paddingBottom: 16 }}>
        <MessageItem
          msg={msg}
          idx={index}
          agents={agents}
          streamingSummaries={streamingSummaries}
          summarizingMsgId={summarizingMsgId}
          summaryProgress={summaryProgress}
          editingMsgIdx={editingMsgIdx}
          editingContent={editingContent}
          activeId={activeId}
          onOpenSummary={onOpenSummary}
          onCopy={onCopy}
          onDelete={onDelete}
          onEditStart={onEditStart}
          onEditCancel={onEditCancel}
          onEditContentChange={onEditContentChange}
          onEditSave={onEditSave}
        />
      </div>
    );
  }, [messages, agents, streamingSummaries, summarizingMsgId, summaryProgress, editingMsgIdx, editingContent, activeId, onOpenSummary, onCopy, onDelete, onEditStart, onEditCancel, onEditContentChange, onEditSave]);

  const streamingEntries = Object.entries(streamingContent);

  return (
    <div ref={containerRef} className="flex flex-col flex-1 min-h-0">
      {messages.length > 0 && (
        <div style={{ flex: 1, minHeight: 0 }}>
          <AutoSizedList
            listRef={listRef}
            itemCount={messages.length}
            getItemSize={getItemSize}
            Row={Row}
          />
        </div>
      )}

      {/* Streaming content outside virtual list */}
      {streamingEntries.map(([agentName, content]) => (
        <motion.div key={`stream-${agentName}`} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="flex gap-3 mt-4">
          <div className="flex flex-col items-center pt-1 shrink-0">
            <ModelAvatar provider={agents.find(a => a.name === agentName)?.provider} className="w-8 h-8" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="glass-card rounded-xl rounded-tl-none p-4 shadow-sm border-l-4 border-l-emerald-500">
              <div className="flex items-center gap-2 mb-2 border-b border-slate-100 dark:border-slate-700/50 pb-2">
                <span className="font-bold text-slate-900 dark:text-white text-sm">{agentName}</span>
                <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">streaming</span>
              </div>
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                  {content}
                </ReactMarkdown>
              </div>
            </div>
          </div>
        </motion.div>
      ))}
    </div>
  );
});

// Helper component to auto-size the list to its container
function AutoSizedList({
  listRef,
  itemCount,
  getItemSize,
  Row,
}: {
  listRef: React.RefObject<List | null>;
  itemCount: number;
  getItemSize: (index: number) => number;
  Row: React.ComponentType<{ index: number; style: React.CSSProperties }>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = React.useState(600);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        setHeight(entry.contentRect.height);
      }
    });
    observer.observe(containerRef.current);
    setHeight(containerRef.current.clientHeight);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={containerRef} style={{ height: '100%', minHeight: 200 }}>
      <List
        ref={listRef}
        height={height}
        itemCount={itemCount}
        itemSize={getItemSize}
        width="100%"
        overscanCount={5}
      >
        {Row}
      </List>
    </div>
  );
}
