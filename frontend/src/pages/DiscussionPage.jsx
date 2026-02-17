import { useState, useEffect, useRef, useCallback } from 'react'
import { getDiscussion, streamDiscussion, stopDiscussion, resetDiscussion, prepareAgents, updateAgent, listLLMProviders, submitUserInput, streamSummarize, deleteMessage, updateMessage, getObserverHistory, clearObserverHistory, streamObserverChat } from '../services/api'

const PHASE_LABELS = {
  planning: '规划中',
  discussing: '讨论中',
  reflecting: '反思中',
  synthesizing: '总结中',
}

const ROLE_LABELS = {
  host: '主持人',
  panelist: '专家',
  critic: '批评家',
  user: '用户',
}

// Parse backend timestamps as UTC (SQLite strips timezone info), display in browser local timezone
function formatTime(ts) {
  const s = String(ts)
  const d = new Date(s.includes('Z') || s.includes('+') ? s : s + 'Z')
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export default function DiscussionPage({ discussionId }) {
  const [discussion, setDiscussion] = useState(null)
  const [messages, setMessages] = useState([])
  const [phase, setPhase] = useState('')
  const [status, setStatus] = useState('loading')
  const [error, setError] = useState(null)
  const [agents, setAgents] = useState([])
  const [providers, setProviders] = useState([])
  const [preparingAgents, setPreparingAgents] = useState(false)
  const [llmProgress, setLlmProgress] = useState()
  const [userInput, setUserInput] = useState('')
  const [sendingInput, setSendingInput] = useState(false)
  const [summarizing, setSummarizing] = useState(false)
  const [summaryProgress, setSummaryProgress] = useState(null)
  const [summarizingMsgId, setSummarizingMsgId] = useState(null)
  const [editingAgentId, setEditingAgentId] = useState(null)
  const [materialsModalOpen, setMaterialsModalOpen] = useState(false)
  const [textViewContent, setTextViewContent] = useState(null) // { filename, content }
  // Observer panel state
  const [observerOpen, setObserverOpen] = useState(false)
  const [observerMessages, setObserverMessages] = useState([])
  const [observerInput, setObserverInput] = useState('')
  const [observerStreaming, setObserverStreaming] = useState(false)
  const [observerStreamText, setObserverStreamText] = useState('')
  const [observerConfig, setObserverConfig] = useState({ providerId: null, provider: '', model: '' })
  const observerStreamRef = useRef(null)
  const observerEndRef = useRef(null)
  const [observerWidth, setObserverWidth] = useState(360)
  const streamRef = useRef(null)
  const messagesEndRef = useRef(null)
  const scrollAreaRef = useRef(null)
  const isNearBottomRef = useRef(true)

  const pollRef = useRef(null)

  // Only auto-scroll if user is already near the bottom
  useEffect(() => {
    if (isNearBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages])

  // Poll for updates when discussion is running (e.g. after page refresh)
  const startPolling = useCallback(() => {
    if (pollRef.current) return
    pollRef.current = setInterval(async () => {
      try {
        const d = await getDiscussion(discussionId)
        setMessages(d.messages || [])
        setPhase(d.status)
        setAgents(d.agents || [])
        if (d.final_summary) {
          setDiscussion(prev => ({ ...prev, final_summary: d.final_summary }))
        }
        const RUNNING = ['planning', 'discussing', 'reflecting', 'synthesizing']
        if (!RUNNING.includes(d.status)) {
          // Discussion finished while we were polling
          clearInterval(pollRef.current)
          pollRef.current = null
          if (d.status === 'completed') setStatus('completed')
          else if (d.status === 'waiting_input') setStatus('waiting_input')
          else if (d.status === 'failed') { setStatus('error'); setError('讨论执行失败') }
        }
      } catch {}
    }, 2500)
  }, [discussionId])

  // Load discussion + providers on mount
  useEffect(() => {
    const load = async () => {
      try {
        const [d, provs, obsHistory] = await Promise.all([
          getDiscussion(discussionId),
          listLLMProviders(),
          getObserverHistory(discussionId).catch(() => []),
        ])
        setDiscussion(d)
        setMessages(d.messages || [])
        setPhase(d.status)
        setProviders(provs)
        setObserverMessages(obsHistory)
        // Initialize observer config from first available provider+model
        if (provs.length > 0 && !observerConfig.provider) {
          const p = provs[0]
          const m = p.models?.[0]?.model || ''
          setObserverConfig({ providerId: p.id, provider: p.provider, model: m })
        }

        const RUNNING = ['planning', 'discussing', 'reflecting', 'synthesizing']
        if (d.status === 'completed') {
          setStatus('completed')
          setAgents(d.agents || [])
        } else if (d.status === 'waiting_input') {
          setStatus('waiting_input')
          setAgents(d.agents || [])
        } else if (d.status === 'failed') {
          setStatus('error')
          setError('讨论执行失败')
          setAgents(d.agents || [])
        } else if (d.status === 'created') {
          setStatus('ready')
          // Pre-generate agents if empty (non-custom modes)
          if (!d.agents || d.agents.length === 0) {
            setPreparingAgents(true)
            try {
              const prepared = await prepareAgents(discussionId)
              setAgents(prepared)
              setDiscussion(prev => ({ ...prev, agents: prepared }))
            } catch {
              // Fallback: agents will be generated at run time
            } finally {
              setPreparingAgents(false)
            }
          } else {
            setAgents(d.agents)
          }
        } else if (RUNNING.includes(d.status)) {
          // Discussion is running (e.g. page refresh) — poll for updates
          setStatus('running')
          setAgents(d.agents || [])
          startPolling()
        } else {
          setStatus('running')
          setAgents(d.agents || [])
        }
      } catch (e) {
        setStatus('error')
        setError(e.message)
      }
    }
    load()
    return () => {
      streamRef.current?.abort()
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    }
  }, [discussionId, startPolling])

  const startDiscussion = async () => {
    setStatus('running')
    setError(null)

    const controller = await streamDiscussion(
      discussionId,
      (event) => {
        if (event.event_type === 'phase_change') setPhase(event.phase || '')
        if (event.event_type === 'message') {
          setMessages(prev => [...prev, event])
          // Clear progress for this agent once their message arrives
          if (event.agent_name) {
            setLlmProgress(prev => {
              if (!prev) return prev
              const next = { ...prev }
              delete next[event.agent_name]
              return Object.keys(next).length ? next : null
            })
          }
        }
        if (event.event_type === 'llm_progress') {
          setLlmProgress(prev => ({
            ...prev,
            [event.agent_name]: {
              chars: event.chars_received,
              status: event.llm_status,
            }
          }))
          // Auto-clear "done" entries after a short delay
          if (event.llm_status === 'done') {
            setTimeout(() => {
              setLlmProgress(prev => {
                if (!prev) return prev
                const next = { ...prev }
                delete next[event.agent_name]
                return Object.keys(next).length ? next : null
              })
            }, 800)
          }
        }
      },
      (errMsg) => { setStatus('error'); setError(errMsg) },
      (evt) => {
        setLlmProgress(null)
        // Refresh messages from DB to ensure consistency with persisted state
        getDiscussion(discussionId).then(d => {
          setDiscussion(d)
          setMessages(d.messages || [])
          setAgents(d.agents || [])
          if (evt.event_type === 'complete') {
            setStatus('completed')
          } else {
            setStatus('waiting_input')
          }
        })
      },
    )
    streamRef.current = controller
  }

  const handleStop = async () => {
    streamRef.current?.abort()
    try { await stopDiscussion(discussionId) } catch {}
    setLlmProgress(null)
    setStatus('completed')
    setPhase('')
  }

  const handleReplan = async () => {
    streamRef.current?.abort()
    try { await resetDiscussion(discussionId) } catch {}
    setMessages([])
    setLlmProgress(null)
    setPhase('')
    setError(null)
    startDiscussion()
  }

  const handleAgentSave = useCallback(async (agentId, data) => {
    try {
      const updated = await updateAgent(discussionId, agentId, data)
      setAgents(prev => prev.map(a => a.id === agentId ? updated : a))
    } catch (e) {
      setError(`保存失败: ${e.message}`)
    }
  }, [discussionId])

  const handleUserInput = useCallback(async () => {
    const text = userInput.trim()
    if (!text || sendingInput) return
    setSendingInput(true)
    // Optimistic update — show user message immediately
    setMessages(prev => [...prev, {
      agent_name: '用户',
      agent_role: 'user',
      content: text,
      phase: 'user_input',
      created_at: new Date().toISOString(),
    }])
    setUserInput('')
    try {
      await submitUserInput(discussionId, text)
      // Trigger a new discussion cycle unless already streaming
      if (status !== 'running') {
        setSendingInput(false)
        startDiscussion()
        return
      }
    } catch (e) {
      setError(`发送失败: ${e.message}`)
    } finally {
      setSendingInput(false)
    }
  }, [discussionId, userInput, sendingInput, status])

  const handleDeleteMessage = useCallback(async (msgId) => {
    try {
      await deleteMessage(discussionId, msgId)
      setMessages(prev => prev.filter(m => m.id !== msgId))
    } catch (e) {
      setError(`删除失败: ${e.message}`)
    }
  }, [discussionId])

  const handleEditMessage = useCallback(async (msgId, newContent) => {
    try {
      await updateMessage(discussionId, msgId, newContent)
      setMessages(prev => prev.map(m => m.id === msgId ? { ...m, content: newContent } : m))
      // Trigger a new discussion cycle after editing
      if (status !== 'running') {
        startDiscussion()
      }
    } catch (e) {
      setError(`编辑失败: ${e.message}`)
    }
  }, [discussionId, status])

  // Handle clicking a material item — preview text, open image, or download
  const handleMaterialClick = useCallback(async (m) => {
    const url = `/api/materials/${m.id}/download`
    if (m.mime_type?.startsWith('image/')) {
      window.open(url, '_blank')
    } else if (m.mime_type === 'text/markdown' || m.mime_type === 'text/plain' || m.filename?.endsWith('.md') || m.filename?.endsWith('.txt')) {
      try {
        const res = await fetch(url)
        if (!res.ok) throw new Error('Failed to fetch')
        const text = await res.text()
        setTextViewContent({ filename: m.filename, content: text })
      } catch {
        window.open(url, '_blank')
      }
    } else {
      const a = document.createElement('a')
      a.href = url
      a.download = m.filename
      a.click()
    }
  }, [])

  // Count unsummarized long messages
  const unsummarizedCount = messages.filter(m => (m.content || '').length >= 200 && !m.summary).length

  const handleSummarize = useCallback(async () => {
    setSummarizing(true)
    setSummaryProgress(null)
    setSummarizingMsgId(null)
    await streamSummarize(
      discussionId,
      (event) => {
        if (event.event_type === 'summary_progress') {
          setSummaryProgress(event.content)
          setSummarizingMsgId(event.round_number)
        }
        if (event.event_type === 'summary_done') {
          const msgId = event.round_number
          setSummarizingMsgId(null)
          setMessages(prev => prev.map(m =>
            m.id === msgId ? { ...m, summary: event.content } : m
          ))
        }
      },
      (errMsg) => { setError(errMsg); setSummarizing(false); setSummaryProgress(null); setSummarizingMsgId(null) },
      () => { setSummarizing(false); setSummaryProgress(null); setSummarizingMsgId(null) },
    )
  }, [discussionId])

  const handleExport = useCallback(() => {
    const d = discussion
    if (!d) return
    const lines = []
    // Title & topic
    lines.push(`# ${d.title || d.topic}`)
    if (d.title && d.title !== d.topic) {
      lines.push('', `> ${d.topic}`)
    }
    lines.push('', `- 模式: ${d.mode || '—'}`)
    lines.push(`- 轮数: ${d.max_rounds ?? '—'}`)
    lines.push(`- 状态: ${d.status || '—'}`)
    // Agent table
    if (agents.length > 0) {
      lines.push('', '## 专家团队', '', '| 角色 | 名称 | 供应商/模型 |', '| --- | --- | --- |')
      agents.forEach(a => {
        const roleLabel = ROLE_LABELS[a.role] || a.role
        lines.push(`| ${roleLabel} | ${a.name} | ${a.provider}/${a.model} |`)
      })
    }
    // Materials
    const mats = d.materials || []
    if (mats.length > 0) {
      lines.push('', '## 参考资料', '')
      mats.forEach(m => lines.push(`- ${m.filename} (${m.content_type || '—'}, ${m.file_size ? (m.file_size / 1024).toFixed(1) + 'KB' : '—'})`))
    }
    // Messages grouped by round
    if (messages.length > 0) {
      lines.push('', '## 讨论记录', '')
      let lastRound = -1
      messages.forEach(msg => {
        if (msg.round_number !== undefined && msg.round_number !== lastRound) {
          lastRound = msg.round_number
          lines.push(`### 第 ${msg.round_number + 1} 轮`, '')
        }
        const icon = { host: '🎯', critic: '🔍', panelist: '💡', user: '👤' }[msg.agent_role] || '💡'
        const phase = PHASE_LABELS[msg.phase] || msg.phase || ''
        const time = msg.created_at ? formatTime(msg.created_at) : ''
        lines.push(`**${icon} ${msg.agent_name}** ${phase} ${time}`, '', msg.content || '', '')
      })
    }
    // Final summary
    if (d.final_summary) {
      lines.push('## 最终总结', '', d.final_summary)
    }
    const md = lines.join('\n')
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(d.title || d.topic || 'discussion').replace(/[/\\?%*:|"<>]/g, '_')}.md`
    a.click()
    URL.revokeObjectURL(url)
  }, [discussion, agents, messages])

  // Auto-trigger summarization when unsummarized messages exist
  const summarizeRef = useRef(false)
  useEffect(() => {
    if (summarizing || summarizeRef.current) return
    if ((status === 'completed' || status === 'waiting_input') && unsummarizedCount > 0) {
      summarizeRef.current = true
      handleSummarize().finally(() => { summarizeRef.current = false })
    }
  }, [status, unsummarizedCount, summarizing, handleSummarize])

  if (status === 'loading') return <div className="loading">加载中...</div>
  if (status === 'error' && !discussion) return <div className="error-msg">{error}</div>

  const topic = discussion?.topic || ''
  const title = discussion?.title || ''

  return (
    <div className="discussion-page-wrapper">
    <div className={`discussion-page ${observerOpen ? 'with-observer' : ''}`}>
      <div className="discussion-header">
        <div className="discussion-title-row">
          <h1>{title || topic}</h1>
          <button
            className={`btn btn-sm observer-toggle ${observerOpen ? 'active' : ''}`}
            onClick={() => setObserverOpen(v => !v)}
          >
            👁 观察员
          </button>
        </div>
        <div className="discussion-controls">
          {phase && status === 'running' && (
            <span className="phase-indicator">
              <span className="phase-dot pulse" />
              {PHASE_LABELS[phase] || phase}
            </span>
          )}
          {status === 'waiting_input' && (
            <span className="phase-indicator waiting">
              <span className="phase-dot" />
              等待输入
            </span>
          )}
          {status === 'completed' && (
            <span className="phase-indicator completed">
              <span className="phase-dot" />
              已完成
            </span>
          )}
          {(status === 'completed' || status === 'waiting_input') && summarizing && (
            <span className="summary-progress">正在总结 {summaryProgress || '...'}</span>
          )}
          {(status === 'ready' || status === 'error') && (
            <button className="btn btn-primary" onClick={() => {
              setError(null)
              startDiscussion()
            }} disabled={preparingAgents}>
              {preparingAgents ? '准备中...' : status === 'error' ? '重试' : '开始讨论'}
            </button>
          )}
          {status !== 'ready' && status !== 'error' && (
            <>
              <button className="phase-indicator phase-btn" onClick={handleReplan}>
                ↻ 全部重新规划
              </button>
              <button className="phase-indicator phase-btn danger" onClick={handleStop}>
                ■ 停止
              </button>
              <button className="phase-indicator phase-btn" onClick={() => setMaterialsModalOpen(true)}>
                📎 资料
              </button>
              <button className="phase-indicator phase-btn" onClick={handleExport}>
                📥 导出
              </button>
            </>
          )}
        </div>
      </div>

      {/* Agent tags — fixed at top, don't scroll with messages */}
      {status !== 'ready' && status !== 'error' && agents.length > 0 && (
        <div className="discussion-meta">
          {agents.map(a => (
            <span key={a.id} className={`agent-tag agent-tag-${a.role}`}
              onClick={() => setEditingAgentId(a.id)}
              style={{ cursor: 'pointer' }}>
              {a.name}
              <span className="agent-model">{a.provider}/{a.model}</span>
            </span>
          ))}
        </div>
      )}
      {editingAgentId && (
        <div className="modal-overlay" onClick={() => setEditingAgentId(null)}>
          <div className="modal-content agent-edit-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span>编辑专家配置</span>
              <button className="btn btn-sm" onClick={() => setEditingAgentId(null)}>✕</button>
            </div>
            <AgentEditCard
              agent={agents.find(a => a.id === editingAgentId)}
              providers={providers}
              onSave={async (agentId, data) => {
                await handleAgentSave(agentId, data)
                setEditingAgentId(null)
              }}
            />
          </div>
        </div>
      )}
      {materialsModalOpen && (
        <div className="modal-overlay" onClick={() => setMaterialsModalOpen(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>📎 讨论资料</h2>
              <button className="btn btn-sm" onClick={() => setMaterialsModalOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              {(discussion?.materials || []).length === 0 ? (
                <div className="empty-state" style={{ padding: '32px 20px' }}>暂无资料</div>
              ) : (
                <div className="materials-list">
                  {discussion.materials.map(m => (
                    <div key={m.id} className="material-item material-item-clickable" onClick={() => handleMaterialClick(m)}>
                      <div className="material-item-name">
                        {m.mime_type?.startsWith('image/') ? '🖼️' : '📄'} {m.filename}
                      </div>
                      <div className="material-item-meta">
                        {m.mime_type || '未知类型'}
                        {m.file_size ? ` · ${(m.file_size / 1024).toFixed(1)} KB` : ''}
                        {m.status && m.status !== 'ready' && ` · ${m.status}`}
                      </div>
                      {m.text_preview && (
                        <div className="material-item-preview">{m.text_preview}</div>
                      )}
                      {m.meta_info && (
                        <div className="material-item-metadata">
                          {m.meta_info.summary && <div>{m.meta_info.summary}</div>}
                          {m.meta_info.keywords?.length > 0 && (
                            <div style={{ marginTop: 4 }}>
                              {m.meta_info.keywords.map((kw, i) => (
                                <span key={i} className="material-keyword-tag">{kw}</span>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {textViewContent && (
        <div className="modal-overlay" onClick={() => setTextViewContent(null)}>
          <div className="modal-content text-view-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>📄 {textViewContent.filename}</h2>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <CopyButton text={textViewContent.content} />
                <button className="btn btn-sm" onClick={() => setTextViewContent(null)}>✕</button>
              </div>
            </div>
            <div className="modal-body">
              <pre className="text-view-content">{textViewContent.content}</pre>
            </div>
          </div>
        </div>
      )}

      <div
        className="discussion-scroll-area"
        ref={scrollAreaRef}
        onScroll={() => {
          const el = scrollAreaRef.current
          if (!el) return
          isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
        }}
      >
        {/* Original topic — scrollable, shown when title differs */}
        {title && title !== topic && topic && (
          <div className="discussion-topic-full">{topic}</div>
        )}

        {error && <div className="error-msg">{error}</div>}

        {/* Agent editing panel — when ready or failed (allow fixing before retry) */}
        {(status === 'ready' || status === 'error') && (
          <div className="agent-edit-panel">
            <div className="agent-edit-header">专家团队配置</div>
            {preparingAgents ? (
              <div className="loading" style={{ padding: '24px' }}>正在生成专家团队...</div>
            ) : (
              <div className="agent-edit-list">
                {agents.map(agent => (
                  <AgentEditCard
                    key={agent.id}
                    agent={agent}
                    providers={providers}
                    onSave={handleAgentSave}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        <div className="messages-container">
          {messages.map((msg, idx) => (
            <MessageBubble key={msg.id || idx} msg={msg} summarizingMsgId={summarizingMsgId} summarizing={summarizing} onDelete={handleDeleteMessage} onEdit={handleEditMessage} />
          ))}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Fixed input bar — always visible */}
      <div className="user-input-fixed">
          <div className="user-input-bar">
            <textarea
              className="form-input user-input-textarea"
              value={userInput}
              onChange={e => {
                setUserInput(e.target.value)
                e.target.style.height = 'auto'
                e.target.style.height = e.target.scrollHeight + 'px'
              }}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  handleUserInput()
                }
              }}
              placeholder={
                status === 'waiting_input' ? '输入你的想法，发送后将开始新一轮讨论... (Ctrl+Enter 发送)'
                : '输入你的想法指导讨论方向... (Ctrl+Enter 发送)'
              }
              rows={2}
              disabled={sendingInput}
            />
            <ExpandInput
              value={userInput}
              onChange={setUserInput}
              onSubmit={handleUserInput}
              placeholder="输入你的想法指导讨论方向..."
              submitLabel={status === 'waiting_input' ? '发送并继续' : '发送'}
            />
            <button
              className="btn btn-primary btn-send"
              onClick={handleUserInput}
              disabled={!userInput.trim() || sendingInput}
            >
              {sendingInput ? '发送中...' : status === 'waiting_input' ? '发送并继续' : '发送'}
            </button>
          </div>
          {/* Compact streaming progress — below input bar */}
          {status === 'running' && (
            <StreamingStatus agents={agents} phase={phase} llmProgress={llmProgress} messages={messages} currentRound={discussion?.current_round || 0} polling={!!pollRef.current} />
          )}
        </div>
    </div>
    {observerOpen && (
      <>
      <ObserverResizeHandle onResize={setObserverWidth} width={observerWidth} />
      <ObserverPanel
        discussionId={discussionId}
        providers={providers}
        config={observerConfig}
        onConfigChange={setObserverConfig}
        messages={observerMessages}
        setMessages={setObserverMessages}
        input={observerInput}
        setInput={setObserverInput}
        streaming={observerStreaming}
        setStreaming={setObserverStreaming}
        streamText={observerStreamText}
        setStreamText={setObserverStreamText}
        streamRef={observerStreamRef}
        endRef={observerEndRef}
        width={observerWidth}
      />
      </>
    )}
    </div>
  )
}


function StreamingStatus({ agents, phase, llmProgress, messages, currentRound, polling }) {
  const phaseLabel = { planning: '规划中', discussing: '讨论中', reflecting: '反思中', synthesizing: '总结中' }
  const formatChars = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

  // SSE mode: use llmProgress
  if (llmProgress && Object.keys(llmProgress).length) {
    const parts = Object.entries(llmProgress).map(([name, { chars, status }]) => {
      const label = status === 'done' ? '完成' : status === 'waiting' ? '等待响应' : '思考中'
      const charStr = chars > 0 ? ` ${formatChars(chars)}字` : ''
      return `${name} ${label}${charStr}`
    })
    return <div className="streaming-status"><span className="streaming-dot" />{parts.join(' · ')}</div>
  }

  // Polling / phase-based fallback
  const parts = (() => {
    if (phase === 'planning' || phase === 'synthesizing') {
      const host = agents.find(a => a.role === 'host')
      return host ? [`${host.name} ${phaseLabel[phase]}`] : []
    }
    if (phase === 'discussing') {
      return agents.filter(a => a.role === 'panelist').map(p => {
        const done = messages.some(m => m.agent_name === p.name && m.round_number === currentRound && m.phase === 'discussing')
        return `${p.name} ${done ? '已完成' : '讨论中'}`
      })
    }
    if (phase === 'reflecting') {
      const critic = agents.find(a => a.role === 'critic')
      return critic ? [`${critic.name} 反思中`] : []
    }
    return [phaseLabel[phase] || '运行中']
  })()

  if (!parts.length) return null
  return <div className="streaming-status"><span className="streaming-dot" />{parts.join(' · ')}</div>
}


function ExpandInput({ value, onChange, onSubmit, placeholder, submitLabel }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')

  const handleOpen = () => { setDraft(value); setOpen(true) }
  const handleConfirm = () => { onChange(draft); setOpen(false) }
  const handleSubmit = () => { onChange(draft); setOpen(false); onSubmit?.() }

  if (!open) {
    return (
      <button className="btn-expand" onClick={handleOpen} title="展开输入框">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" />
          <line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
        </svg>
      </button>
    )
  }

  return (
    <div className="modal-overlay" onClick={() => setOpen(false)}>
      <div className="expand-modal" onClick={e => e.stopPropagation()}>
        <div className="expand-modal-header">
          <span>{placeholder || '输入内容'}</span>
          <button className="btn btn-sm" onClick={() => setOpen(false)}>✕</button>
        </div>
        <textarea
          className="form-input expand-textarea"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleSubmit() } }}
          placeholder={placeholder}
          autoFocus
        />
        <div className="expand-modal-footer">
          <span className="expand-hint">Ctrl+Enter 发送</span>
          <div className="expand-modal-actions">
            <button className="btn btn-sm" onClick={handleConfirm}>保留文字</button>
            <button className="btn btn-primary btn-sm" onClick={handleSubmit}>{submitLabel || '发送'}</button>
          </div>
        </div>
      </div>
    </div>
  )
}


function ObserverResizeHandle({ onResize, width }) {
  const startX = useRef(0)
  const startW = useRef(0)

  const onMouseDown = (e) => {
    e.preventDefault()
    startX.current = e.clientX
    startW.current = width
    const onMouseMove = (ev) => {
      const delta = startX.current - ev.clientX
      onResize(Math.min(700, Math.max(240, startW.current + delta)))
    }
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  return <div className="observer-resize-handle" onMouseDown={onMouseDown} />
}


function ObserverPanel({ discussionId, providers, config, onConfigChange, messages, setMessages, input, setInput, streaming, setStreaming, streamText, setStreamText, streamRef, endRef, width }) {
  const scrollToBottom = () => endRef.current?.scrollIntoView({ behavior: 'smooth' })

  useEffect(() => { scrollToBottom() }, [messages, streamText])

  // Initialize config from providers if empty
  useEffect(() => {
    if (!config.provider && providers.length > 0) {
      const p = providers[0]
      const m = p.models?.[0]?.model || ''
      onConfigChange({ providerId: p.id, provider: p.provider, model: m })
    }
  }, [providers, config.provider, onConfigChange])

  const selectedProv = providers.find(p => p.id === config.providerId)
  const availableModels = (selectedProv?.models || []).map(m => m.model)

  const handleProviderChange = (provId) => {
    const prov = providers.find(p => p.id === Number(provId))
    if (!prov) return
    const models = (prov.models || []).map(m => m.model)
    onConfigChange({ providerId: prov.id, provider: prov.provider, model: models[0] || '' })
  }

  const handleSend = async () => {
    const text = input.trim()
    if (!text || streaming || !config.provider) return
    // Optimistic: add user message
    const userMsg = { id: Date.now(), role: 'user', content: text, created_at: new Date().toISOString() }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setStreaming(true)
    setStreamText('')

    const ctrl = await streamObserverChat(
      discussionId,
      { content: text, provider: config.provider, model: config.model, provider_id: config.providerId },
      (chunk) => { setStreamText(prev => prev + chunk) },
      (err) => { setStreamText(prev => prev + `\n[错误: ${err}]`); setStreaming(false) },
      () => {
        // Done — move stream text into messages
        setStreamText(prev => {
          if (prev) {
            setMessages(msgs => [...msgs, { id: Date.now() + 1, role: 'observer', content: prev, created_at: new Date().toISOString() }])
          }
          return ''
        })
        setStreaming(false)
      },
    )
    streamRef.current = ctrl
  }

  const handleClear = async () => {
    if (streaming) { streamRef.current?.abort(); setStreaming(false); setStreamText('') }
    try { await clearObserverHistory(discussionId) } catch {}
    setMessages([])
  }

  return (
    <div className="observer-panel" style={{ width, minWidth: width }}>
      <div className="observer-header">
        <span className="observer-title">👁 观察员</span>
        <button className="btn btn-sm" onClick={handleClear} title="清空对话">清空</button>
      </div>
      <div className="observer-config">
        <select className="form-select form-select-sm" value={config.providerId || ''} onChange={e => handleProviderChange(e.target.value)}>
          {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select className="form-select form-select-sm" value={config.model} onChange={e => onConfigChange({ ...config, model: e.target.value })}>
          {availableModels.map(m => <option key={m} value={m}>{m}</option>)}
          {config.model && !availableModels.includes(config.model) && <option value={config.model}>{config.model}</option>}
        </select>
      </div>
      <div className="observer-messages">
        {messages.map((msg, idx) => (
          <div key={msg.id || idx} className={`observer-msg observer-msg-${msg.role}`}>
            <div className="observer-msg-content">{msg.content}</div>
            <CopyButton text={msg.content} />
          </div>
        ))}
        {streaming && streamText && (
          <div className="observer-msg observer-msg-observer">
            <div className="observer-msg-content">{streamText}<span className="typing-cursor" /></div>
          </div>
        )}
        {streaming && !streamText && (
          <div className="observer-msg observer-msg-observer">
            <div className="observer-msg-content"><span className="typing-cursor" /> 思考中...</div>
          </div>
        )}
        <div ref={endRef} />
      </div>
      <div className="observer-input-bar">
        <textarea
          className="form-input"
          value={input}
          onChange={e => {
            setInput(e.target.value)
            e.target.style.height = 'auto'
            e.target.style.height = e.target.scrollHeight + 'px'
          }}
          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleSend() } }}
          placeholder="向观察员提问... (Ctrl+Enter)"
          rows={2}
          disabled={streaming}
        />
        <ExpandInput
          value={input}
          onChange={setInput}
          onSubmit={handleSend}
          placeholder="向观察员提问..."
          submitLabel={streaming ? '回复中...' : '发送'}
        />
        <button className="btn btn-primary btn-send" onClick={handleSend} disabled={!input.trim() || streaming || !config.provider}>
          {streaming ? '回复中...' : '发送'}
        </button>
      </div>
    </div>
  )
}


function AgentEditCard({ agent, providers, onSave }) {
  const [name, setName] = useState(agent.name)
  const [persona, setPersona] = useState(agent.persona || '')
  const [model, setModel] = useState(agent.model)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  // Find the initial provider by matching agent's provider type + model
  const initProv = providers.find(p =>
    p.provider === agent.provider && (p.models || []).some(m => m.model === agent.model)
  ) || providers.find(p => p.provider === agent.provider) || providers[0]
  const [selectedProvId, setSelectedProvId] = useState(initProv?.id || null)

  const selectedProv = providers.find(p => p.id === selectedProvId)
  const availableModels = (selectedProv?.models || []).map(m => m.model)

  const handleProviderChange = (provId) => {
    const prov = providers.find(p => p.id === Number(provId))
    if (!prov) return
    setSelectedProvId(prov.id)
    const models = (prov.models || []).map(m => m.model)
    if (models.length > 0 && !models.includes(model)) {
      setModel(models[0])
    }
    setDirty(true)
  }

  const handleSave = async () => {
    setSaving(true)
    // Send provider type (for AgentConfig.provider field)
    await onSave(agent.id, { name, persona, provider: selectedProv?.provider || agent.provider, model, provider_id: selectedProvId })
    setDirty(false)
    setSaving(false)
  }

  return (
    <div className={`agent-edit-card role-${agent.role}`}>
      <div className="agent-edit-card-header">
        <span className={`role-badge role-badge-${agent.role}`}>
          {agent.role === 'host' ? '🎯' : agent.role === 'critic' ? '🔍' : '💡'}
          {ROLE_LABELS[agent.role] || agent.role}
        </span>
        {dirty && (
          <button className="btn btn-sm btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? '保存中...' : '保存'}
          </button>
        )}
      </div>
      <div className="agent-edit-card-body">
        <div className="form-group">
          <label>名称</label>
          <input
            className="form-input"
            value={name}
            onChange={e => { setName(e.target.value); setDirty(true) }}
          />
        </div>
        <div className="form-group">
          <label>
            人设 (Persona)
            <CopyButton text={persona} />
          </label>
          <textarea
            className="form-input agent-persona-input"
            value={persona}
            onChange={e => { setPersona(e.target.value); setDirty(true) }}
            rows={3}
          />
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>供应商</label>
            <select
              className="form-select"
              value={selectedProvId || ''}
              onChange={e => handleProviderChange(e.target.value)}
            >
              {providers.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
              {!selectedProv && (
                <option value="">{agent.provider}</option>
              )}
            </select>
          </div>
          <div className="form-group">
            <label>模型</label>
            <select
              className="form-select"
              value={model}
              onChange={e => { setModel(e.target.value); setDirty(true) }}
            >
              {availableModels.map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
              {!availableModels.includes(model) && (
                <option value={model}>{model}</option>
              )}
            </select>
          </div>
        </div>
      </div>
    </div>
  )
}


function CopyButton({ text }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async (e) => {
    e.stopPropagation()
    if (!text) return
    try {
      // navigator.clipboard requires secure context (HTTPS/localhost)
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text)
      } else {
        // Fallback for HTTP
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.left = '-9999px'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {}
  }

  return (
    <button className="copy-btn" onClick={handleCopy} title="复制">
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
      {copied && <span className="copy-tooltip">已复制</span>}
    </button>
  )
}


function MessageBubble({ msg, summarizingMsgId, summarizing, onDelete, onEdit }) {
  const role = msg.agent_role || 'panelist'
  const isUser = role === 'user'
  const isLong = (msg.content || '').length >= 200
  const hasSummary = !!msg.summary
  const isSummarizing = msg.id && msg.id === summarizingMsgId
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState(msg.content || '')

  useEffect(() => {
    if (hasSummary) setExpanded(false)
  }, [hasSummary])

  const roleIcon = { host: '🎯', critic: '🔍', panelist: '💡', user: '👤' }

  const displayText = !isLong
    ? msg.content
    : expanded
      ? msg.content
      : hasSummary
        ? msg.summary
        : `${msg.agent_name} 总结中...`

  const handleSaveEdit = () => {
    const text = editText.trim()
    if (!text || text === msg.content) { setEditing(false); return }
    onEdit?.(msg.id, text)
    setEditing(false)
  }

  return (
    <div className={`message-bubble role-${role}`}>
      <div className="message-header" onClick={() => !editing && isLong && setExpanded(v => !v)}>
        <span className="message-agent">
          <span className={`role-icon role-icon-${role}`}>
            {roleIcon[role] || '💡'}
          </span>
          {msg.agent_name}
        </span>
        <span className="message-meta">
          {msg.created_at && (
            <span className="message-time">
              {formatTime(msg.created_at)}
            </span>
          )}
          {PHASE_LABELS[msg.phase] || msg.phase}
          {msg.round_number !== undefined && !isUser && ` · 第${msg.round_number + 1}轮`}
          {isLong && !editing && (
            <span className="expand-toggle">
              {expanded ? '收起' : '展开'}
            </span>
          )}
          {isUser && msg.id && !editing && (
            <span className="user-msg-actions">
              <span className="msg-action-btn" onClick={e => { e.stopPropagation(); setEditText(msg.content || ''); setEditing(true) }}>编辑</span>
              <span className="msg-action-btn danger" onClick={e => { e.stopPropagation(); if (window.confirm('确定删除这条消息？')) onDelete?.(msg.id) }}>删除</span>
            </span>
          )}
        </span>
      </div>
      {editing ? (
        <div className="message-edit-area">
          <textarea
            className="form-input message-edit-input"
            value={editText}
            onChange={e => setEditText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleSaveEdit() } }}
            rows={3}
            autoFocus
          />
          <div className="message-edit-actions">
            <button className="btn btn-sm btn-primary" onClick={handleSaveEdit}>保存并继续讨论</button>
            <button className="btn btn-sm" onClick={() => setEditing(false)}>取消</button>
          </div>
        </div>
      ) : (
        <div className={`message-content ${!expanded && isLong ? 'collapsed' : ''}`}>
          {displayText}
          <CopyButton text={msg.content} />
        </div>
      )}
    </div>
  )
}
