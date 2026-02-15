import { useState, useEffect, useRef, useCallback } from 'react'
import { getDiscussion, streamDiscussion, prepareAgents, updateAgent, listLLMProviders } from '../services/api'

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
  const streamRef = useRef(null)
  const messagesEndRef = useRef(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

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

        if (d.status === 'completed') {
          setStatus('completed')
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
    return () => { streamRef.current?.abort() }
  }, [discussionId])

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
      () => {
        setStatus('completed')
        setLlmProgress(null)
        getDiscussion(discussionId).then(d => setDiscussion(d))
      },
    )
    streamRef.current = controller
  }

  const handleAgentSave = useCallback(async (agentId, data) => {
    try {
      const updated = await updateAgent(discussionId, agentId, data)
      setAgents(prev => prev.map(a => a.id === agentId ? updated : a))
    } catch (e) {
      setError(`保存失败: ${e.message}`)
    }
  }, [discussionId])

  if (status === 'loading') return <div className="loading">加载中...</div>
  if (status === 'error' && !discussion) return <div className="error-msg">{error}</div>

  const topic = discussion?.topic || ''
  const isLongTopic = topic.length > 20

  return (
    <div className="discussion-page">
      <div className="discussion-header">
        <h1 className={isLongTopic ? 'topic-long' : ''}>{topic}</h1>
        <div className="discussion-controls">
          {phase && status === 'running' && (
            <span className="phase-indicator">
              <span className="phase-dot pulse" />
              {PHASE_LABELS[phase] || phase}
            </span>
          )}
          {status === 'ready' && (
            <button className="btn btn-primary" onClick={startDiscussion}>
              开始讨论
            </button>
          )}
          {status === 'error' && (
            <button className="btn btn-primary" onClick={() => {
              setMessages([])
              setError(null)
              startDiscussion()
            }}>
              重试
            </button>
          )}
          {status === 'running' && (
            <button className="btn btn-secondary" onClick={() => {
              streamRef.current?.abort()
              setStatus('ready')
              setPhase('')
              setLlmProgress(null)
            }}>
              停止
            </button>
          )}
        </div>
      </div>

      {error && <div className="error-msg">{error}</div>}

      {/* LLM streaming progress */}
      {status === 'running' && llmProgress && (
        <LLMProgressBar progress={llmProgress} />
      )}

      {/* Agent editing panel — only when ready (pre-run) */}
      {status === 'ready' && (
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
      {status !== 'ready' && agents.length > 0 && (
        <div className="discussion-meta">
          {agents.map(a => (
            <span key={a.id} className={`agent-tag agent-tag-${a.role}`}>
              {a.name}
              <span className="agent-model">{a.provider}/{a.model}</span>
            </span>
          ))}
        </div>
      )}

      <div className="messages-container">
        {messages.map((msg, idx) => (
          <MessageBubble key={idx} msg={msg} />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {status === 'completed' && discussion?.final_summary && (
        <div className="final-summary">
          <h2>最终总结</h2>
          <div className="summary-content">
            {discussion.final_summary}
            <CopyButton text={discussion.final_summary} />
          </div>
        </div>
      )}
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
          <span className="llm-progress-label">正在思考...</span>
          <span className="llm-progress-chars">{formatChars(chars)} chars</span>
        </div>
      ))}
    </div>
  )
}


function AgentEditCard({ agent, providers, onSave }) {
  const [name, setName] = useState(agent.name)
  const [persona, setPersona] = useState(agent.persona || '')
  const [provider, setProvider] = useState(agent.provider)
  const [model, setModel] = useState(agent.model)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  // Build provider→models map from global providers
  const providerModels = {}
  for (const p of providers) {
    const key = p.provider
    if (!providerModels[key]) providerModels[key] = []
    for (const m of (p.models || [])) {
      providerModels[key].push(m.model)
    }
  }

  const availableModels = providerModels[provider] || []

  const handleProviderChange = (newProvider) => {
    setProvider(newProvider)
    const models = providerModels[newProvider] || []
    if (models.length > 0 && !models.includes(model)) {
      setModel(models[0])
    }
    setDirty(true)
  }

  const handleSave = async () => {
    setSaving(true)
    // Find api_key and base_url from global providers
    const prov = providers.find(p => p.provider === provider)
    await onSave(agent.id, {
      name,
      persona,
      provider,
      model,
      api_key: prov?.api_key || null,
      base_url: prov?.base_url || null,
    })
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
            <label>Provider</label>
            <select
              className="form-select"
              value={provider}
              onChange={e => handleProviderChange(e.target.value)}
            >
              {Object.keys(providerModels).map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
              {!providerModels[provider] && (
                <option value={provider}>{provider}</option>
              )}
            </select>
          </div>
          <div className="form-group">
            <label>Model</label>
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
      await navigator.clipboard.writeText(text)
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
  const [expanded, setExpanded] = useState(true)

  return (
    <div className={`message-bubble role-${role}`}>
      <div className="message-header" onClick={() => setExpanded(v => !v)}>
        <span className="message-agent">
          <span className={`role-icon role-icon-${role}`}>
            {role === 'host' ? '🎯' : role === 'critic' ? '🔍' : '💡'}
          </span>
          {msg.agent_name}
        </span>
        <span className="message-meta">
          {PHASE_LABELS[msg.phase] || msg.phase}
          {msg.round_number !== undefined && ` · 第${msg.round_number + 1}轮`}
        </span>
      </div>
      {expanded && (
        <div className="message-content">
          {msg.content}
          <CopyButton text={msg.content} />
        </div>
      )}
    </div>
  )
}
