import { useState, useEffect, useRef, useCallback } from 'react'
import { getDiscussion, streamDiscussion, stopDiscussion, prepareAgents, updateAgent, listLLMProviders, submitUserInput } from '../services/api'

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
  const streamRef = useRef(null)
  const messagesEndRef = useRef(null)

  const pollRef = useRef(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
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
        const [d, provs] = await Promise.all([
          getDiscussion(discussionId),
          listLLMProviders(),
        ])
        setDiscussion(d)
        setMessages(d.messages || [])
        setPhase(d.status)
        setProviders(provs)

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
        setStatus('waiting_input')
        getDiscussion(discussionId).then(d => setDiscussion(d))
      },
    )
    streamRef.current = controller
  }

  const handleReplan = async () => {
    streamRef.current?.abort()
    try { await stopDiscussion(discussionId) } catch {}
    setMessages([])
    setLlmProgress(null)
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
    const wasWaiting = status === 'waiting_input'
    setSendingInput(true)
    // Optimistic update — show user message immediately
    setMessages(prev => [...prev, {
      agent_name: '用户',
      agent_role: 'user',
      content: text,
      phase: 'user_input',
    }])
    setUserInput('')
    try {
      await submitUserInput(discussionId, text)
      // If we were waiting for input, auto-trigger a new discussion cycle
      if (wasWaiting) {
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

  if (status === 'loading') return <div className="loading">加载中...</div>
  if (status === 'error' && !discussion) return <div className="error-msg">{error}</div>

  const topic = discussion?.topic || ''
  const title = discussion?.title || ''

  return (
    <div className="discussion-page">
      <div className="discussion-header">
        <h1>{title || topic}</h1>
        <div className="discussion-controls">
          {phase && status === 'running' && (
            <>
              <span className="phase-indicator">
                <span className="phase-dot pulse" />
                {PHASE_LABELS[phase] || phase}
              </span>
              <button className="btn btn-sm" onClick={handleReplan}>
                重新规划
              </button>
            </>
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
          {(status === 'ready' || status === 'error') && (
            <button className="btn btn-primary" onClick={() => {
              setMessages([])
              setError(null)
              startDiscussion()
            }} disabled={preparingAgents}>
              {preparingAgents ? '准备中...' : status === 'error' ? '重试' : '开始讨论'}
            </button>
          )}
        </div>
      </div>

      <div className="discussion-scroll-area">
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

        {/* Agent tags — when running or completed */}
        {status !== 'ready' && status !== 'error' && agents.length > 0 && (
          <div className="discussion-meta">
            {agents.map(a => (
              <span key={a.id} className={`agent-tag agent-tag-${a.role}`}>
                {a.name}
                <span className="agent-model">{a.provider}/{a.model}</span>
              </span>
            ))}
          </div>
        )}

        {/* Polling mode banner — after page refresh, no SSE progress available */}
        {status === 'running' && pollRef.current && !llmProgress && (
          <div className="polling-banner">
            <span className="phase-dot pulse" />
            后台运行中 · {PHASE_LABELS[phase] || phase || '处理中'} · 每 2.5 秒刷新
          </div>
        )}

        <div className="messages-container">
          {messages.map((msg, idx) => (
            <MessageBubble key={idx} msg={msg} />
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
              onChange={e => setUserInput(e.target.value)}
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
            <button
              className="btn btn-primary btn-send"
              onClick={handleUserInput}
              disabled={!userInput.trim() || sendingInput}
            >
              {sendingInput ? '发送中...' : status === 'waiting_input' ? '发送并继续' : '发送'}
            </button>
          </div>
          {/* LLM progress — inline below input bar */}
          {llmProgress && (
            <LLMProgressBar progress={llmProgress} />
          )}
        </div>
    </div>
  )
}


function LLMProgressBar({ progress }) {
  const entries = Object.entries(progress)
  if (!entries.length) return null

  const formatChars = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

  return (
    <div className="llm-progress">
      {entries.map(([name, { chars, status }]) => (
        <div key={name} className={`llm-progress-item ${status === 'done' ? 'done' : ''}`}>
          <span className="llm-progress-dot" />
          <span className="llm-progress-name">{name}</span>
          <span className="llm-progress-label">
            {status === 'waiting' ? '等待响应...' : '正在思考...'}
          </span>
          {chars > 0 && <span className="llm-progress-chars">{formatChars(chars)} chars</span>}
        </div>
      ))}
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


function MessageBubble({ msg }) {
  const role = msg.agent_role || 'panelist'
  const isLong = (msg.content || '').length >= 200
  const hasSummary = !!msg.summary
  // Collapse by default only when a summary exists; otherwise show full content
  const [expanded, setExpanded] = useState(!hasSummary)

  const roleIcon = { host: '🎯', critic: '🔍', panelist: '💡', user: '👤' }

  // Show summary when collapsed + summary available, otherwise full content
  const displayText = !expanded && hasSummary ? msg.summary : msg.content

  return (
    <div className={`message-bubble role-${role}`}>
      <div className="message-header" onClick={() => isLong && setExpanded(v => !v)}>
        <span className="message-agent">
          <span className={`role-icon role-icon-${role}`}>
            {roleIcon[role] || '💡'}
          </span>
          {msg.agent_name}
        </span>
        <span className="message-meta">
          {PHASE_LABELS[msg.phase] || msg.phase}
          {msg.round_number !== undefined && role !== 'user' && ` · 第${msg.round_number + 1}轮`}
          {isLong && (
            <span className="expand-toggle">
              {expanded ? '收起' : '展开'}
            </span>
          )}
        </span>
      </div>
      <div className={`message-content ${!expanded ? 'collapsed' : ''}`}>
        {displayText}
        <CopyButton text={msg.content} />
      </div>
    </div>
  )
}
