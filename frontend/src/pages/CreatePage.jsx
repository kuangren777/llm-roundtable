import { useState, useRef } from 'react'
import { createDiscussion, uploadMaterials } from '../services/api'

const MODE_OPTIONS = [
  { value: 'auto', label: '自动 (Auto)', desc: '由 LLM 分析话题，动态生成最优专家组合' },
  { value: 'debate', label: '辩论 (Debate)', desc: '正方 vs 反方 + 主持人' },
  { value: 'brainstorm', label: '头脑风暴 (Brainstorm)', desc: '多角度创意发散 + 批评家收敛' },
  { value: 'sequential', label: '顺序评审 (Sequential)', desc: '逐一审查，后者基于前者改进' },
  { value: 'custom', label: '自定义 (Custom)', desc: '手动定义每个 Agent' },
]

const ALLOWED_FILE_EXTS = ['.txt', '.md', '.pdf', '.docx']
const ALLOWED_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp']

function makeDefaultAgents() {
  return [
    { name: '主持人', role: 'host', persona: '经验丰富的圆桌会议主持人', provider: 'openai', model: 'gpt-4o', api_key: '', base_url: '' },
    { name: '专家A', role: 'panelist', persona: '', provider: 'openai', model: 'gpt-4o', api_key: '', base_url: '' },
    { name: '批评家', role: 'critic', persona: '严谨的分析批评家', provider: 'openai', model: 'gpt-4o', api_key: '', base_url: '' },
  ]
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function getFileExt(name) {
  const idx = name.lastIndexOf('.')
  return idx >= 0 ? name.slice(idx).toLowerCase() : ''
}

export default function CreatePage({ onCreated }) {
  // Step 1 state
  const [topic, setTopic] = useState('')
  const [files, setFiles] = useState([])       // { file: File, preview?: string }
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef(null)

  // Step 2 (modal) state
  const [showModal, setShowModal] = useState(false)
  const [mode, setMode] = useState('auto')
  const [maxRounds, setMaxRounds] = useState(3)
  const [agents, setAgents] = useState(makeDefaultAgents)

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  // --- File handling ---
  const addFiles = (newFiles) => {
    const items = []
    for (const file of newFiles) {
      const ext = getFileExt(file.name)
      const isImage = ALLOWED_IMAGE_EXTS.includes(ext)
      const isFile = ALLOWED_FILE_EXTS.includes(ext)
      if (!isImage && !isFile) continue
      if (file.size > 10 * 1024 * 1024) continue
      // Avoid duplicates
      if (files.some(f => f.file.name === file.name && f.file.size === file.size)) continue
      const item = { file }
      if (isImage) {
        item.preview = URL.createObjectURL(file)
      }
      items.push(item)
    }
    if (items.length) setFiles(prev => [...prev, ...items])
  }

  const removeFile = (idx) => {
    setFiles(prev => {
      const item = prev[idx]
      if (item.preview) URL.revokeObjectURL(item.preview)
      return prev.filter((_, i) => i !== idx)
    })
  }

  const handleDrop = (e) => {
    e.preventDefault()
    setDragOver(false)
    addFiles(e.dataTransfer.files)
  }

  const handleDragOver = (e) => { e.preventDefault(); setDragOver(true) }
  const handleDragLeave = () => setDragOver(false)

  const handleFileSelect = (e) => {
    addFiles(e.target.files)
    e.target.value = ''
  }

  const uploadedFiles = files.filter(f => !f.preview)
  const uploadedImages = files.filter(f => f.preview)

  // --- Step 1 → Step 2 ---
  const handleNext = () => {
    if (!topic.trim()) { setError('请输入讨论主题'); return }
    setError(null)
    setShowModal(true)
  }

  // --- Custom mode agent helpers ---
  const updateAgent = (idx, field, value) => {
    setAgents(prev => prev.map((a, i) => i === idx ? { ...a, [field]: value } : a))
  }
  const addAgent = () => setAgents(prev => [...prev, { name: '', role: 'panelist', persona: '', provider: 'openai', model: 'gpt-4o', api_key: '', base_url: '' }])
  const removeAgent = (idx) => {
    if (agents.length <= 2) return
    setAgents(prev => prev.filter((_, i) => i !== idx))
  }

  // --- Final submit ---
  const handleSubmit = async () => {
    if (mode === 'custom') {
      if (!agents.some(a => a.role === 'host')) { setError('自定义模式至少需要一个主持人'); return }
      if (!agents.some(a => a.role === 'panelist')) { setError('自定义模式至少需要一个专家'); return }
      for (const a of agents) {
        if (!a.name.trim()) { setError('所有角色都需要名称'); return }
      }
    }

    setSubmitting(true)
    setError(null)

    try {
      const data = { topic: topic.trim(), mode, max_rounds: maxRounds }
      if (mode === 'custom') {
        data.agents = agents.map(a => ({
          name: a.name.trim(),
          role: a.role,
          persona: a.persona.trim() || null,
          provider: a.provider.trim() || 'openai',
          model: a.model.trim() || 'gpt-4o',
          api_key: a.api_key.trim() || null,
          base_url: a.base_url.trim() || null,
        }))
      }

      const result = await createDiscussion(data)

      // Upload materials if any
      if (files.length > 0) {
        await uploadMaterials(result.id, files.map(f => f.file))
      }

      setShowModal(false)
      onCreated?.(result)
    } catch (e) {
      setError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  const selectedMode = MODE_OPTIONS.find(m => m.value === mode)

  return (
    <div className="create-page">
      <h1>发起新讨论</h1>

      {/* Step 1: Topic + Materials */}
      <div className="form-section">
        <label className="form-label">讨论主题</label>
        <textarea
          className="form-input topic-input"
          value={topic}
          onChange={e => setTopic(e.target.value)}
          placeholder="例如：AI 是否会取代大部分白领工作？请从技术、经济、社会三个角度分析。"
          rows={3}
        />
      </div>

      {/* Material upload area */}
      <div className="form-section">
        <label className="form-label">讨论材料（可选）</label>
        <div
          className={`upload-area ${dragOver ? 'drag-over' : ''}`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={[...ALLOWED_FILE_EXTS, ...ALLOWED_IMAGE_EXTS].join(',')}
            onChange={handleFileSelect}
            style={{ display: 'none' }}
          />
          <div className="upload-area-content">
            <span className="upload-icon">📎</span>
            <span>拖拽文件到此处，或点击选择</span>
            <span className="upload-hint">支持 txt, md, pdf, docx, png, jpg, gif, webp（单文件 ≤ 10MB）</span>
          </div>
        </div>

        {/* Uploaded files list */}
        {uploadedFiles.length > 0 && (
          <div className="upload-file-list">
            <div className="upload-section-label">文件</div>
            {uploadedFiles.map((item, idx) => {
              const realIdx = files.indexOf(item)
              return (
                <div key={realIdx} className="upload-file-item">
                  <span className="upload-file-icon">📄</span>
                  <span className="upload-file-name">{item.file.name}</span>
                  <span className="upload-file-size">{formatFileSize(item.file.size)}</span>
                  <button className="btn-icon btn-remove" onClick={(e) => { e.stopPropagation(); removeFile(realIdx) }}>×</button>
                </div>
              )
            })}
          </div>
        )}

        {/* Uploaded images */}
        {uploadedImages.length > 0 && (
          <div className="upload-file-list">
            <div className="upload-section-label">图片</div>
            <div className="upload-thumb-grid">
              {uploadedImages.map((item, idx) => {
                const realIdx = files.indexOf(item)
                return (
                  <div key={realIdx} className="upload-thumb">
                    <img src={item.preview} alt={item.file.name} />
                    <button className="upload-thumb-remove" onClick={(e) => { e.stopPropagation(); removeFile(realIdx) }}>×</button>
                    <span className="upload-thumb-name">{item.file.name}</span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {error && !showModal && <div className="error-msg">{error}</div>}

      <button className="btn btn-primary btn-lg" onClick={handleNext}>
        下一步 — 配置讨论
      </button>

      {/* Step 2: Config Modal */}
      {showModal && (
        <div className="modal-overlay" onClick={() => !submitting && setShowModal(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>讨论配置</h2>
              <button className="btn-icon" onClick={() => !submitting && setShowModal(false)}>×</button>
            </div>

            <div className="modal-body">
              {/* Mode selector */}
              <div className="form-section">
                <label className="form-label">编排模式</label>
                <select
                  className="form-select"
                  value={mode}
                  onChange={e => setMode(e.target.value)}
                >
                  {MODE_OPTIONS.map(m => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
                {selectedMode && (
                  <p style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 6 }}>
                    {selectedMode.desc}
                  </p>
                )}
              </div>

              {/* Max rounds */}
              <div className="form-section">
                <label className="form-label">最大讨论轮次</label>
                <input
                  type="number"
                  className="form-input rounds-input"
                  value={maxRounds}
                  onChange={e => setMaxRounds(Math.max(1, Math.min(10, +e.target.value)))}
                  min={1}
                  max={10}
                />
              </div>

              {/* Custom mode: agent config */}
              {mode === 'custom' && (
                <div className="form-section">
                  <div className="section-header">
                    <label className="form-label">自定义角色配置</label>
                    <button type="button" className="btn btn-sm" onClick={addAgent}>+ 添加角色</button>
                  </div>
                  <div className="agents-config">
                    {agents.map((agent, idx) => (
                      <div key={idx} className={`agent-config-card role-${agent.role}`}>
                        <div className="agent-config-header">
                          <select
                            className="form-select role-select"
                            value={agent.role}
                            onChange={e => updateAgent(idx, 'role', e.target.value)}
                          >
                            <option value="host">主持人 (Host)</option>
                            <option value="panelist">专家 (Panelist)</option>
                            <option value="critic">批评家 (Critic)</option>
                          </select>
                          {agents.length > 2 && (
                            <button type="button" className="btn-icon btn-remove" onClick={() => removeAgent(idx)}>×</button>
                          )}
                        </div>
                        <div className="agent-config-body">
                          <div className="form-row">
                            <div className="form-group">
                              <label>名称</label>
                              <input className="form-input" value={agent.name} onChange={e => updateAgent(idx, 'name', e.target.value)} placeholder="角色名称" />
                            </div>
                            <div className="form-group">
                              <label>角色设定</label>
                              <input className="form-input" value={agent.persona} onChange={e => updateAgent(idx, 'persona', e.target.value)} placeholder="专业背景和视角..." />
                            </div>
                          </div>
                          <div className="form-row">
                            <div className="form-group">
                              <label>供应商</label>
                              <input className="form-input" value={agent.provider} onChange={e => updateAgent(idx, 'provider', e.target.value)} placeholder="openai" />
                            </div>
                            <div className="form-group">
                              <label>模型</label>
                              <input className="form-input" value={agent.model} onChange={e => updateAgent(idx, 'model', e.target.value)} placeholder="gpt-4o" />
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {error && <div className="error-msg">{error}</div>}
            </div>

            <div className="modal-footer">
              <button className="btn" onClick={() => !submitting && setShowModal(false)}>取消</button>
              <button className="btn btn-primary" onClick={handleSubmit} disabled={submitting}>
                {submitting ? '创建中...' : '开始讨论'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
