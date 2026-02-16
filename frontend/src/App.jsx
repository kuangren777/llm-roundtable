import { useState, useEffect, useCallback } from 'react'
import { listDiscussions, deleteDiscussion, generateTitle } from './services/api'
import CreatePage from './pages/CreatePage'
import DiscussionPage from './pages/DiscussionPage'
import SettingsPage from './pages/SettingsPage'

const STATUS_COLORS = {
  created: '#6b7280',
  planning: '#3b82f6',
  discussing: '#8b5cf6',
  reflecting: '#f59e0b',
  synthesizing: '#10b981',
  completed: '#059669',
  failed: '#ef4444',
}

const MODE_LABELS = {
  auto: '自动',
  debate: '辩论',
  brainstorm: '头脑风暴',
  sequential: '顺序评审',
  custom: '自定义',
}

export default function App() {
  const [currentView, setCurrentView] = useState('create') // 'create' | 'discussion' | 'settings'
  const [selectedId, setSelectedId] = useState(null)
  const [discussions, setDiscussions] = useState([])
  const [loading, setLoading] = useState(true)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  const refreshList = useCallback(() => {
    listDiscussions()
      .then(setDiscussions)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { refreshList() }, [refreshList])

  const handleSelectDiscussion = (id) => {
    setSelectedId(id)
    setCurrentView('discussion')
  }

  const handleNewDiscussion = () => {
    setSelectedId(null)
    setCurrentView('create')
  }

  const handleCreated = (disc) => {
    refreshList()
    setSelectedId(disc.id)
    setCurrentView('discussion')
    // Auto-generate short title in background
    generateTitle(disc.id)
      .then(({ title }) => {
        setDiscussions(prev => prev.map(d =>
          d.id === disc.id ? { ...d, title } : d
        ))
      })
      .catch(() => {})
  }

  const handleDelete = async (e, id) => {
    e.stopPropagation()
    if (!confirm('确定要删除这个讨论吗？')) return
    try {
      await deleteDiscussion(id)
      setDiscussions(prev => prev.filter(d => d.id !== id))
      if (selectedId === id) {
        setSelectedId(null)
        setCurrentView('create')
      }
    } catch {}
  }

  return (
    <div className="app-layout">
      {/* Sidebar */}
      <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-header">
          {!sidebarCollapsed && <span className="sidebar-brand">圆桌讨论</span>}
          <button
            className="btn-icon sidebar-toggle"
            onClick={() => setSidebarCollapsed(v => !v)}
            title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
          >
            {sidebarCollapsed ? '▶' : '◀'}
          </button>
        </div>

        {!sidebarCollapsed && (
          <>
            <button className="btn btn-primary sidebar-new-btn" onClick={handleNewDiscussion}>
              + 新讨论
            </button>

            <div className="sidebar-list">
              {loading ? (
                <div className="sidebar-empty">加载中...</div>
              ) : discussions.length === 0 ? (
                <div className="sidebar-empty">暂无讨论</div>
              ) : (
                discussions.map(d => (
                  <div
                    key={d.id}
                    className={`sidebar-item ${selectedId === d.id && currentView === 'discussion' ? 'active' : ''}`}
                    onClick={() => handleSelectDiscussion(d.id)}
                  >
                    <div className="sidebar-item-top">
                      <span className="sidebar-item-title">{d.title || d.topic}</span>
                      <button
                        className="sidebar-item-delete"
                        onClick={(e) => handleDelete(e, d.id)}
                        title="删除"
                      >×</button>
                    </div>
                    <div className="sidebar-item-meta">
                      <span
                        className="sidebar-badge"
                        style={{ backgroundColor: STATUS_COLORS[d.status] || '#6b7280' }}
                      />
                      <span>{MODE_LABELS[d.mode] || d.mode}</span>
                      <span>·</span>
                      <span>{new Date(d.created_at).toLocaleDateString('zh-CN')}</span>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="sidebar-footer">
              <button
                className={`sidebar-settings-btn ${currentView === 'settings' ? 'active' : ''}`}
                onClick={() => setCurrentView('settings')}
              >
                ⚙ 设置
              </button>
            </div>
          </>
        )}
      </aside>

      {/* Main content — use display:none to keep DiscussionPage mounted */}
      <main className="main-panel">
        <div style={{ display: currentView === 'create' ? undefined : 'none', height: '100%' }}>
          <CreatePage onCreated={handleCreated} />
        </div>
        {selectedId && (
          <div style={{ display: currentView === 'discussion' ? undefined : 'none', height: '100%' }}>
            <DiscussionPage discussionId={selectedId} key={selectedId} />
          </div>
        )}
        <div style={{ display: currentView === 'settings' ? undefined : 'none', height: '100%' }}>
          <SettingsPage />
        </div>
      </main>
    </div>
  )
}
