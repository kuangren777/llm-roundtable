import { useState, useEffect } from 'react'
import {
  listLLMProviders, addLLMProvider, updateLLMProvider, deleteLLMProvider,
  addLLMModel, updateLLMModel, deleteLLMModel,
  getSystemSetting, setSystemSetting,
} from '../services/api'

const PROVIDER_PRESETS = [
  { label: 'OpenAI', provider: 'openai', models: ['gpt-4o', 'gpt-4o-mini'] },
  { label: 'Anthropic', provider: 'anthropic', models: ['claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'] },
  { label: 'Gemini', provider: 'gemini', models: ['gemini-2.0-flash', 'gemini-2.5-pro-preview-06-05'] },
  { label: 'DeepSeek', provider: 'deepseek', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { label: 'Groq', provider: 'groq', models: ['llama-3.3-70b-versatile'] },
  { label: 'Ollama', provider: 'ollama', models: ['llama3'] },
]

function parseSummaryConfig(raw) {
  if (!raw) return null
  try {
    let parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (typeof parsed === 'string') parsed = JSON.parse(parsed)
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

export default function SettingsPage() {
  const [providers, setProviders] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [adding, setAdding] = useState(false)

  // Summary model config
  const [summaryConfig, setSummaryConfig] = useState(null) // { provider_id, model }
  const [summaryDirty, setSummaryDirty] = useState(false)
  const [savingSummary, setSavingSummary] = useState(false)

  // Add provider form
  const [form, setForm] = useState({ name: '', provider: '', api_key: '', base_url: '' })

  // Editing state
  const [editingProvider, setEditingProvider] = useState(null) // { id, name, provider, api_key, base_url }
  const [editingModel, setEditingModel] = useState(null) // { id, providerId, model, name }
  const [addingModelTo, setAddingModelTo] = useState(null) // provider id
  const [newModel, setNewModel] = useState({ model: '', name: '' })

  useEffect(() => {
    Promise.all([
      listLLMProviders(),
      getSystemSetting('summary_model'),
    ])
      .then(([provs, setting]) => {
        setProviders(provs)
        setSummaryConfig(parseSummaryConfig(setting.value))
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const applyPreset = (idx) => {
    const p = PROVIDER_PRESETS[idx]
    if (p) setForm(prev => ({ ...prev, name: p.label, provider: p.provider }))
  }

  const handleAddProvider = async () => {
    if (!form.name.trim() || !form.provider.trim()) {
      setError('名称和供应商类型不能为空')
      return
    }
    setAdding(true)
    setError(null)
    try {
      const data = {
        name: form.name.trim(),
        provider: form.provider.trim(),
        api_key: form.api_key.trim() || null,
        base_url: form.base_url.trim() || null,
      }
      const created = await addLLMProvider(data)

      // Auto-add preset models if matching
      const preset = PROVIDER_PRESETS.find(p => p.provider === data.provider)
      if (preset) {
        for (const m of preset.models) {
          const model = await addLLMModel(created.id, { model: m })
          created.models = [...(created.models || []), model]
        }
      }

      setProviders(prev => [created, ...prev])
      setForm({ name: '', provider: '', api_key: '', base_url: '' })
    } catch (e) {
      setError(e.message)
    } finally {
      setAdding(false)
    }
  }

  const handleDeleteProvider = async (id) => {
    try {
      await deleteLLMProvider(id)
      setProviders(prev => prev.filter(p => p.id !== id))
    } catch (e) {
      setError(e.message)
    }
  }

  const startEditProvider = (p) => {
    setEditingProvider({ id: p.id, name: p.name, provider: p.provider, api_key: '', base_url: p.base_url || '' })
    setEditingModel(null)
  }

  const handleUpdateProvider = async () => {
    if (!editingProvider) return
    setError(null)
    try {
      const data = {}
      if (editingProvider.name.trim()) data.name = editingProvider.name.trim()
      if (editingProvider.provider.trim()) data.provider = editingProvider.provider.trim()
      if (editingProvider.api_key.trim()) data.api_key = editingProvider.api_key.trim()
      if (editingProvider.base_url.trim()) data.base_url = editingProvider.base_url.trim()
      else if (editingProvider.base_url === '') data.base_url = null

      const updated = await updateLLMProvider(editingProvider.id, data)
      setProviders(prev => prev.map(p => p.id === updated.id ? updated : p))
      setEditingProvider(null)
    } catch (e) {
      setError(e.message)
    }
  }

  const handleAddModel = async (providerId) => {
    if (!newModel.model.trim()) {
      setError('模型标识不能为空')
      return
    }
    setError(null)
    try {
      const model = await addLLMModel(providerId, {
        model: newModel.model.trim(),
        name: newModel.name.trim() || null,
      })
      setProviders(prev => prev.map(p =>
        p.id === providerId ? { ...p, models: [...p.models, model] } : p
      ))
      setNewModel({ model: '', name: '' })
      setAddingModelTo(null)
    } catch (e) {
      setError(e.message)
    }
  }

  const startEditModel = (providerId, m) => {
    setEditingModel({ id: m.id, providerId, model: m.model, name: m.name || '' })
    setEditingProvider(null)
  }

  const handleUpdateModel = async () => {
    if (!editingModel) return
    setError(null)
    try {
      const data = {}
      if (editingModel.model.trim()) data.model = editingModel.model.trim()
      data.name = editingModel.name.trim() || editingModel.model.trim()
      const updated = await updateLLMModel(editingModel.providerId, editingModel.id, data)
      setProviders(prev => prev.map(p =>
        p.id === editingModel.providerId
          ? { ...p, models: p.models.map(m => m.id === updated.id ? updated : m) }
          : p
      ))
      setEditingModel(null)
    } catch (e) {
      setError(e.message)
    }
  }

  const handleDeleteModel = async (providerId, modelId) => {
    try {
      await deleteLLMModel(providerId, modelId)
      setProviders(prev => prev.map(p =>
        p.id === providerId ? { ...p, models: p.models.filter(m => m.id !== modelId) } : p
      ))
    } catch (e) {
      setError(e.message)
    }
  }

  const handleSaveSummaryModel = async () => {
    setSavingSummary(true)
    setError(null)
    try {
      await setSystemSetting('summary_model', summaryConfig)
      setSummaryDirty(false)
    } catch (e) {
      setError(e.message)
    } finally {
      setSavingSummary(false)
    }
  }

  // Build flat list of all provider+model combos for the summary model dropdown
  const allModelOptions = providers.flatMap(p =>
    p.models.map(m => ({
      provider_id: p.id,
      provider: p.provider,
      model: m.model,
      label: `${p.name} / ${m.name || m.model}`,
    }))
  )

  return (
    <div className="settings-page">
      <h1>全局 LLM 设置</h1>
      <p style={{ color: 'var(--text-dim)', fontSize: 14, marginTop: 8, marginBottom: 24 }}>
        管理 LLM 供应商和模型，创建讨论时将自动使用这些配置
      </p>

      {error && <div className="error-msg">{error}</div>}

      {/* Summary model selector */}
      <div className="settings-add-card" style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>消息总结模型</div>
        <p style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 12 }}>
          选择用于自动总结讨论消息的模型，长消息将自动生成摘要并折叠显示
        </p>
        <div className="form-row" style={{ alignItems: 'flex-end' }}>
          <div className="form-group" style={{ flex: 1 }}>
            <label>总结模型</label>
            <select
              className="form-select"
              value={summaryConfig ? `${summaryConfig.provider_id}:${summaryConfig.model}` : ''}
              onChange={e => {
                if (!e.target.value) {
                  setSummaryConfig(null)
                  setSummaryDirty(true)
                  return
                }
                const opt = allModelOptions.find(o => `${o.provider_id}:${o.model}` === e.target.value)
                if (opt) {
                  setSummaryConfig({ provider_id: opt.provider_id, provider: opt.provider, model: opt.model })
                  setSummaryDirty(true)
                }
              }}
            >
              <option value="">未设置 (不自动总结)</option>
              {allModelOptions.map(o => (
                <option key={`${o.provider_id}:${o.model}`} value={`${o.provider_id}:${o.model}`}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          {summaryDirty && (
            <button className="btn btn-primary btn-sm" onClick={handleSaveSummaryModel} disabled={savingSummary}
              style={{ marginBottom: 4 }}>
              {savingSummary ? '保存中...' : '保存'}
            </button>
          )}
        </div>
      </div>

      {/* Add provider form */}
      <div className="settings-add-card">
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>添加供应商</div>
        <div className="form-group">
          <label>快速预设</label>
          <select className="form-select" onChange={e => applyPreset(+e.target.value)} defaultValue="">
            <option value="" disabled>选择预设...</option>
            {PROVIDER_PRESETS.map((p, i) => (
              <option key={i} value={i}>{p.label}</option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>显示名称</label>
            <input
              className="form-input"
              value={form.name}
              onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
              placeholder="如：我的 OpenAI"
            />
          </div>
          <div className="form-group">
            <label>供应商类型</label>
            <input
              className="form-input"
              value={form.provider}
              onChange={e => setForm(prev => ({ ...prev, provider: e.target.value }))}
              placeholder="openai / anthropic / gemini ..."
            />
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>API Key (可选)</label>
            <input
              className="form-input"
              type="password"
              value={form.api_key}
              onChange={e => setForm(prev => ({ ...prev, api_key: e.target.value }))}
              placeholder="留空使用环境变量"
            />
          </div>
          <div className="form-group">
            <label>Base URL (可选)</label>
            <input
              className="form-input"
              value={form.base_url}
              onChange={e => setForm(prev => ({ ...prev, base_url: e.target.value }))}
              placeholder="留空使用默认"
            />
          </div>
        </div>
        <button className="btn btn-primary" onClick={handleAddProvider} disabled={adding}>
          {adding ? '添加中...' : '添加供应商'}
        </button>
      </div>

      {/* Provider list */}
      <h2 style={{ fontSize: 16, marginTop: 32, marginBottom: 16 }}>
        已配置的供应商 ({providers.length})
      </h2>
      {loading ? (
        <div className="loading">加载中...</div>
      ) : providers.length === 0 ? (
        <div className="empty-state">
          <p>还没有配置 LLM 供应商</p>
          <p style={{ fontSize: 13 }}>请先添加至少一个供应商和模型才能创建讨论</p>
        </div>
      ) : (
        <div className="provider-list">
          {providers.map(p => (
            <div key={p.id} className="provider-card">
              {/* Provider header */}
              <div className="provider-header">
                {editingProvider?.id === p.id ? (
                  <div className="provider-edit-form">
                    <div className="form-row">
                      <div className="form-group">
                        <label>名称</label>
                        <input className="form-input" value={editingProvider.name}
                          onChange={e => setEditingProvider(prev => ({ ...prev, name: e.target.value }))} />
                      </div>
                      <div className="form-group">
                        <label>供应商类型</label>
                        <input className="form-input" value={editingProvider.provider}
                          onChange={e => setEditingProvider(prev => ({ ...prev, provider: e.target.value }))} />
                      </div>
                    </div>
                    <div className="form-row">
                      <div className="form-group">
                        <label>API Key (留空不修改)</label>
                        <input className="form-input" type="password" value={editingProvider.api_key}
                          onChange={e => setEditingProvider(prev => ({ ...prev, api_key: e.target.value }))}
                          placeholder="留空保持不变" />
                      </div>
                      <div className="form-group">
                        <label>Base URL</label>
                        <input className="form-input" value={editingProvider.base_url}
                          onChange={e => setEditingProvider(prev => ({ ...prev, base_url: e.target.value }))}
                          placeholder="留空使用默认" />
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn btn-primary btn-sm" onClick={handleUpdateProvider}>保存</button>
                      <button className="btn btn-sm" onClick={() => setEditingProvider(null)}>取消</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="provider-info">
                      <span className="provider-name">{p.name}</span>
                      <span className="provider-detail">
                        {p.provider}
                        {p.has_api_key
                          ? <span className="key-badge key-set">Key 已配置</span>
                          : <span className="key-badge key-missing">Key 未配置</span>
                        }
                        {p.base_url && <span style={{ marginLeft: 8 }}>{p.base_url}</span>}
                      </span>
                    </div>
                    <div className="provider-actions">
                      <button className="btn btn-sm" onClick={() => startEditProvider(p)}>编辑</button>
                      <button className="btn-icon btn-remove" onClick={() => handleDeleteProvider(p.id)} title="删除">×</button>
                    </div>
                  </>
                )}
              </div>

              {/* Model list */}
              <div className="model-list">
                {p.models.map(m => (
                  <div key={m.id} className="model-item">
                    {editingModel?.id === m.id ? (
                      <div className="model-edit-form">
                        <input className="form-input" value={editingModel.model} placeholder="模型标识"
                          onChange={e => setEditingModel(prev => ({ ...prev, model: e.target.value }))} />
                        <input className="form-input" value={editingModel.name} placeholder="显示名称"
                          onChange={e => setEditingModel(prev => ({ ...prev, name: e.target.value }))} />
                        <button className="btn btn-primary btn-sm" onClick={handleUpdateModel}>保存</button>
                        <button className="btn btn-sm" onClick={() => setEditingModel(null)}>取消</button>
                      </div>
                    ) : (
                      <>
                        <div className="model-info">
                          <span className="model-name">{m.name || m.model}</span>
                          {m.name && m.name !== m.model && (
                            <span className="model-id">{m.model}</span>
                          )}
                        </div>
                        <div className="model-actions">
                          <button className="btn btn-sm" onClick={() => startEditModel(p.id, m)}>编辑</button>
                          <button className="btn-icon btn-remove" onClick={() => handleDeleteModel(p.id, m.id)} title="删除">×</button>
                        </div>
                      </>
                    )}
                  </div>
                ))}

                {/* Add model form */}
                {addingModelTo === p.id ? (
                  <div className="model-add-form">
                    <input className="form-input" value={newModel.model} placeholder="模型标识 (如 gpt-4o)"
                      onChange={e => setNewModel(prev => ({ ...prev, model: e.target.value }))} />
                    <input className="form-input" value={newModel.name} placeholder="显示名称 (可选)"
                      onChange={e => setNewModel(prev => ({ ...prev, name: e.target.value }))} />
                    <button className="btn btn-primary btn-sm" onClick={() => handleAddModel(p.id)}>添加</button>
                    <button className="btn btn-sm" onClick={() => { setAddingModelTo(null); setNewModel({ model: '', name: '' }) }}>取消</button>
                  </div>
                ) : (
                  <button className="model-add-btn" onClick={() => { setAddingModelTo(p.id); setNewModel({ model: '', name: '' }) }}>
                    + 添加模型
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
