import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { listDiscussions, deleteDiscussion } from '../services/api'

const STATUS_LABELS = {
  created: '待开始',
  planning: '规划中',
  discussing: '讨论中',
  reflecting: '反思中',
  synthesizing: '总结中',
  round_summary: '轮次总结中',
  completed: '已完成',
  failed: '失败',
}

const STATUS_COLORS = {
  created: '#6b7280',
  planning: '#3b82f6',
  discussing: '#8b5cf6',
  reflecting: '#f59e0b',
  synthesizing: '#10b981',
  round_summary: '#059669',
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

export default function HomePage() {
  const [discussions, setDiscussions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    listDiscussions()
      .then(setDiscussions)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const handleDelete = async (e, id) => {
    e.preventDefault()
    e.stopPropagation()
    if (!confirm('确定要删除这个讨论吗？')) return
    try {
      await deleteDiscussion(id)
      setDiscussions(prev => prev.filter(d => d.id !== id))
    } catch (err) {
      setError(err.message)
    }
  }

  if (loading) return <div className="loading">加载中...</div>
  if (error) return <div className="error-msg">加载失败: {error}</div>

  return (
    <div className="home-page">
      <div className="page-header">
        <h1>圆桌讨论</h1>
        <Link to="/create" className="btn btn-primary">发起新讨论</Link>
      </div>

      {discussions.length === 0 ? (
        <div className="empty-state">
          <p>还没有讨论记录</p>
          <Link to="/create" className="btn btn-primary">创建第一个讨论</Link>
        </div>
      ) : (
        <div className="discussion-list">
          {discussions.map(d => (
            <Link key={d.id} to={`/discussion/${d.id}`} className="discussion-card">
              <div className="card-header">
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span
                    className="status-badge"
                    style={{ backgroundColor: STATUS_COLORS[d.status] || '#6b7280' }}
                  >
                    {STATUS_LABELS[d.status] || d.status}
                  </span>
                  {d.mode && (
                    <span className="status-badge" style={{ backgroundColor: '#4b5563' }}>
                      {MODE_LABELS[d.mode] || d.mode}
                    </span>
                  )}
                </div>
                <span className="card-meta">
                  轮次 {d.current_round}/{d.max_rounds}
                </span>
              </div>
              <h3 className="card-title">{d.topic}</h3>
              <div className="card-agents">
                {d.agents.map(a => (
                  <span key={a.id} className={`agent-tag agent-tag-${a.role}`}>
                    {a.name}
                  </span>
                ))}
              </div>
              <div className="card-footer">
                <span>{new Date(d.created_at).toLocaleString('zh-CN')}</span>
                <button
                  className="btn-icon btn-remove"
                  onClick={(e) => handleDelete(e, d.id)}
                  title="删除讨论"
                >×</button>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
