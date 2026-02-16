import { useState, useRef, useEffect } from 'react'
import { createDiscussion, uploadMaterials, listLLMProviders, listLibraryMaterials, pasteTextMaterial, attachMaterialsToDiscussion } from '../services/api'

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
    { name: '主持人', role: 'host', persona: '经验丰富的圆桌会议主持人', provider: 'openai', model: 'gpt-4o' },
    { name: '专家A', role: 'panelist', persona: '', provider: 'openai', model: 'gpt-4o' },
    { name: '批评家', role: 'critic', persona: '严谨的分析批评家', provider: 'openai', model: 'gpt-4o' },
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

  // Material tabs: 'upload' | 'paste' | 'library'
  const [materialTab, setMaterialTab] = useState('upload')
  const [pasteText, setPasteText] = useState('')
  const [pastingLoading, setPastingLoading] = useState(false)
  const [libraryItems, setLibraryItems] = useState([])
  const [selectedLibraryIds, setSelectedLibraryIds] = useState(new Set())
  const [librarySearch, setLibrarySearch] = useState('')
  const [libraryLoading, setLibraryLoading] = useState(false)

  // Step 2 (modal) state
  const [showModal, setShowModal] = useState(false)
  const [mode, setMode] = useState('auto')
  const [maxRounds, setMaxRounds] = useState(3)
  const [agents, setAgents] = useState(makeDefaultAgents)

  // LLM provider/model state
  const [providers, setProviders] = useState([])
  const [allModels, setAllModels] = useState([])
  const [selectedModelIds, setSelectedModelIds] = useState(new Set())
  const [hostModelId, setHostModelId] = useState(null)

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  // Load library when tab switches to library
  useEffect(() => {
    if (materialTab !== 'library') return
    setLibraryLoading(true)
    listLibraryMaterials()
      .then(items => setLibraryItems(items))
      .catch(() => {})
      .finally(() => setLibraryLoading(false))
  }, [materialTab])

  // Poll library while any items are processing
  useEffect(() => {
    const hasProcessing = libraryItems.some(item => item.status === 'processing')
    if (!hasProcessing) return
    const timer = setInterval(() => {
      listLibraryMaterials()
        .then(items => setLibraryItems(items))
        .catch(() => {})
    }, 2000)
    return () => clearInterval(timer)
  }, [libraryItems])

  // Load providers when modal opens
  useEffect(() => {
    if (!showModal) return
    listLLMProviders().then(provs => {
      setProviders(provs)
      const flat = []
      for (const p of provs) {
        for (const m of (p.models || [])) {
          flat.push({ id: m.id, model: m.model, providerName: p.name, provider: p.provider })
        }
      }
      setAllModels(flat)
      const ids = new Set(flat.map(m => m.id))
      setSelectedModelIds(ids)
      if (flat.length > 0 && !hostModelId) setHostModelId(flat[0].id)
    }).catch(() => {})
  }, [showModal])

  // --- File handling ---
  const addFiles = (newFiles) => {
    const items = []
    for (const file of newFiles) {
      const ext = getFileExt(file.name)
      const isImage = ALLOWED_IMAGE_EXTS.includes(ext)
      const isFile = ALLOWED_FILE_EXTS.includes(ext)
      if (!isImage && !isFile) continue
      if (file.size > 10 * 1024 * 1024) continue
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

  // --- Paste text handling ---
  const handlePasteSubmit = async () => {
    if (!pasteText.trim()) return
    setPastingLoading(true)
    try {
      const result = await pasteTextMaterial(pasteText)
      // Auto-select the new library item
      setSelectedLibraryIds(prev => new Set([...prev, result.id]))
      // Refresh library list (will include the "processing" item)
      const items = await listLibraryMaterials()
      setLibraryItems(items)
      setPasteText('')
      setMaterialTab('library')  // Switch to library to show the result
    } catch (e) {
      setError(e.message)
    } finally {
      setPastingLoading(false)
    }
  }

  // --- Library selection ---
  const toggleLibraryItem = (id) => {
    setSelectedLibraryIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const filteredLibrary = librarySearch
    ? libraryItems.filter(item =>
        item.filename.toLowerCase().includes(librarySearch.toLowerCase()) ||
        (item.text_preview || '').toLowerCase().includes(librarySearch.toLowerCase())
      )
    : libraryItems

  // --- Step 1 → Step 2 ---
  const handleNext = () => {
    if (!topic.trim()) { setError('请输入讨论主题'); return }
    setError(null)
    setShowModal(true)
  }

  // --- Model selection helpers ---
  const toggleModel = (id) => {
    setSelectedModelIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
        if (hostModelId === id) {
          const remaining = allModels.filter(m => next.has(m.id))
          setHostModelId(remaining.length > 0 ? remaining[0].id : null)
        }
      } else {
        next.add(id)
      }
      return next
    })
  }

  const selectAllModels = () => {
    setSelectedModelIds(new Set(allModels.map(m => m.id)))
  }

  const deselectAllModels = () => {
    setSelectedModelIds(new Set())
    setHostModelId(null)
  }

  // --- Custom mode agent helpers ---
  const updateAgent = (idx, field, value) => {
    setAgents(prev => prev.map((a, i) => i === idx ? { ...a, [field]: value } : a))
  }
  const addAgent = () => setAgents(prev => [...prev, { name: '', role: 'panelist', persona: '', provider: 'openai', model: 'gpt-4o' }])
  const removeAgent = (idx) => {
    if (agents.length <= 2) return
    setAgents(prev => prev.filter((_, i) => i !== idx))
  }

  const providerModels = {}
  for (const p of providers) {
    const key = p.provider
    if (!providerModels[key]) providerModels[key] = { name: p.name, models: [], api_key: p.api_key, base_url: p.base_url }
    for (const m of (p.models || [])) {
      providerModels[key].models.push(m.model)
    }
  }

  // --- Final submit ---
  const handleSubmit = async () => {
    if (mode !== 'custom' && selectedModelIds.size === 0) {
      setError('请至少选择一个模型')
      return
    }
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

      if (mode !== 'custom') {
        data.selected_model_ids = [...selectedModelIds]
        if (hostModelId) data.host_model_id = hostModelId
      }

      if (mode === 'custom') {
        data.agents = agents.map(a => {
          const prov = providers.find(p => p.provider === a.provider)
          return {
            name: a.name.trim(),
            role: a.role,
            persona: a.persona.trim() || null,
            provider: a.provider.trim() || 'openai',
            model: a.model.trim() || 'gpt-4o',
            api_key: prov?.api_key || null,
            base_url: prov?.base_url || null,
          }
        })
      }

      const result = await createDiscussion(data)

      // Upload drag-drop files
      if (files.length > 0) {
        await uploadMaterials(result.id, files.map(f => f.file))
      }

      // Attach selected library items
      const libIds = [...selectedLibraryIds]
      if (libIds.length > 0) {
        await attachMaterialsToDiscussion(result.id, libIds)
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
  const totalMaterials = files.length + selectedLibraryIds.size

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

      {/* Material section with tabs */}
      <div className="form-section">
        <label className="form-label">
          讨论材料（可选）
          {totalMaterials > 0 && <span className="material-count">{totalMaterials} 项已选</span>}
        </label>

        <div className="material-tabs">
          <button
            className={`material-tab ${materialTab === 'upload' ? 'active' : ''}`}
            onClick={() => setMaterialTab('upload')}
          >
            上传文件{files.length > 0 && ` (${files.length})`}
          </button>
          <button
            className={`material-tab ${materialTab === 'paste' ? 'active' : ''}`}
            onClick={() => setMaterialTab('paste')}
          >
            粘贴文本
          </button>
          <button
            className={`material-tab ${materialTab === 'library' ? 'active' : ''}`}
            onClick={() => setMaterialTab('library')}
          >
            素材库{selectedLibraryIds.size > 0 && ` (${selectedLibraryIds.size})`}
          </button>
        </div>

        {/* Upload tab */}
        {materialTab === 'upload' && (
          <>
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
          </>
        )}

        {/* Paste text tab */}
        {materialTab === 'paste' && (
          <div className="paste-section">
            <textarea
              className="form-input paste-area"
              value={pasteText}
              onChange={e => setPasteText(e.target.value)}
              placeholder="粘贴文本内容，将自动生成文件名并保存到素材库..."
              rows={8}
            />
            <button
              className="btn btn-primary"
              onClick={handlePasteSubmit}
              disabled={pastingLoading || !pasteText.trim()}
              style={{ marginTop: 8, alignSelf: 'flex-end' }}
            >
              {pastingLoading ? '保存中...' : '保存到素材库'}
            </button>
          </div>
        )}

        {/* Library tab */}
        {materialTab === 'library' && (
          <div className="library-section">
            <input
              className="form-input library-search"
              placeholder="搜索素材..."
              value={librarySearch}
              onChange={e => setLibrarySearch(e.target.value)}
            />
            {libraryLoading ? (
              <div className="library-empty">加载中...</div>
            ) : filteredLibrary.length === 0 ? (
              <div className="library-empty">
                {libraryItems.length === 0 ? '素材库为空，上传文件或粘贴文本后会自动保存到这里' : '无匹配结果'}
              </div>
            ) : (
              <div className="library-list">
                {filteredLibrary.map(item => (
                  <label
                    key={item.id}
                    className={`library-item ${selectedLibraryIds.has(item.id) ? 'selected' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedLibraryIds.has(item.id)}
                      onChange={() => toggleLibraryItem(item.id)}
                    />
                    <div className="library-item-info">
                      <span className="library-item-name">
                        {item.status === 'processing' ? (
                          <span className="processing-indicator">处理中...</span>
                        ) : item.status === 'failed' ? (
                          <span className="failed-indicator">处理失败</span>
                        ) : (
                          item.filename
                        )}
                      </span>
                      <span className="library-item-meta">
                        {item.file_size ? formatFileSize(item.file_size) : ''} · {new Date(item.created_at).toLocaleDateString()}
                      </span>
                      {item.text_preview && (
                        <span className="library-item-preview">{item.text_preview}</span>
                      )}
                    </div>
                    {item.meta_info && item.status === 'ready' && (
                      <div className="library-item-tooltip">
                        {item.meta_info.summary && (
                          <div className="library-item-tooltip-row">{item.meta_info.summary}</div>
                        )}
                        {item.meta_info.keywords && (
                          <div className="library-item-tooltip-row">
                            <span className="library-item-tooltip-label">关键词:</span>
                            {item.meta_info.keywords.join(', ')}
                          </div>
                        )}
                        {item.meta_info.type && (
                          <div className="library-item-tooltip-row">
                            <span className="library-item-tooltip-label">类型:</span>
                            {item.meta_info.type}
                          </div>
                        )}
                      </div>
                    )}
                  </label>
                ))}
              </div>
            )}
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

              {/* Model selection — for non-custom modes */}
              {mode !== 'custom' && (
                <div className="form-section">
                  <div className="section-header">
                    <label className="form-label">参与模型</label>
                    <div className="section-actions">
                      <button type="button" className="btn btn-sm" onClick={selectAllModels}>全选</button>
                      <button type="button" className="btn btn-sm" onClick={deselectAllModels}>清空</button>
                    </div>
                  </div>
                  {allModels.length === 0 ? (
                    <p style={{ fontSize: 13, color: 'var(--text-dim)' }}>
                      暂无注册模型，请先在「设置」中添加 LLM 供应商和模型
                    </p>
                  ) : (
                    <div className="model-select-list">
                      {allModels.map(m => (
                        <label key={m.id} className={`model-select-item ${selectedModelIds.has(m.id) ? 'selected' : ''}`}>
                          <input
                            type="checkbox"
                            checked={selectedModelIds.has(m.id)}
                            onChange={() => toggleModel(m.id)}
                          />
                          <span className="model-select-provider">{m.providerName}</span>
                          <span className="model-select-name">{m.model}</span>
                        </label>
                      ))}
                    </div>
                  )}

                  {/* Host model selector */}
                  {selectedModelIds.size > 0 && (
                    <div className="form-group" style={{ marginTop: 12 }}>
                      <label className="form-label-sm">主持模型</label>
                      <select
                        className="form-select"
                        value={hostModelId || ''}
                        onChange={e => setHostModelId(Number(e.target.value))}
                      >
                        {allModels.filter(m => selectedModelIds.has(m.id)).map(m => (
                          <option key={m.id} value={m.id}>{m.providerName} / {m.model}</option>
                        ))}
                      </select>
                      <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
                        主持人将使用此模型进行规划和总结
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Custom mode: agent config with model dropdowns */}
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
                              <select
                                className="form-select"
                                value={agent.provider}
                                onChange={e => {
                                  const newProv = e.target.value
                                  updateAgent(idx, 'provider', newProv)
                                  const models = providerModels[newProv]?.models || []
                                  if (models.length > 0 && !models.includes(agent.model)) {
                                    updateAgent(idx, 'model', models[0])
                                  }
                                }}
                              >
                                {Object.entries(providerModels).map(([key, val]) => (
                                  <option key={key} value={key}>{val.name} ({key})</option>
                                ))}
                                {!providerModels[agent.provider] && (
                                  <option value={agent.provider}>{agent.provider}</option>
                                )}
                              </select>
                            </div>
                            <div className="form-group">
                              <label>模型</label>
                              <select
                                className="form-select"
                                value={agent.model}
                                onChange={e => updateAgent(idx, 'model', e.target.value)}
                              >
                                {(providerModels[agent.provider]?.models || []).map(m => (
                                  <option key={m} value={m}>{m}</option>
                                ))}
                                {!(providerModels[agent.provider]?.models || []).includes(agent.model) && (
                                  <option value={agent.model}>{agent.model}</option>
                                )}
                              </select>
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
