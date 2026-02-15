const API_BASE = '/api'

export async function createDiscussion(data) {
  const res = await fetch(`${API_BASE}/discussions/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error(`Failed to create discussion: ${res.statusText}`)
  return res.json()
}

export async function listDiscussions() {
  const res = await fetch(`${API_BASE}/discussions/`)
  if (!res.ok) throw new Error(`Failed to list discussions: ${res.statusText}`)
  return res.json()
}

export async function getDiscussion(id) {
  const res = await fetch(`${API_BASE}/discussions/${id}`)
  if (!res.ok) throw new Error(`Failed to get discussion: ${res.statusText}`)
  return res.json()
}

export async function deleteDiscussion(id) {
  const res = await fetch(`${API_BASE}/discussions/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`Failed to delete discussion: ${res.statusText}`)
}

/**
 * Stream discussion via POST-based SSE using fetch + ReadableStream.
 * EventSource only supports GET — this approach supports POST.
 */
// --- LLM Provider APIs ---
export async function listLLMProviders() {
  const res = await fetch(`${API_BASE}/llm-providers/`)
  if (!res.ok) throw new Error(`Failed to list LLM providers: ${res.statusText}`)
  return res.json()
}

export async function addLLMProvider(data) {
  const res = await fetch(`${API_BASE}/llm-providers/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error(`Failed to add LLM provider: ${res.statusText}`)
  return res.json()
}

export async function updateLLMProvider(id, data) {
  const res = await fetch(`${API_BASE}/llm-providers/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error(`Failed to update LLM provider: ${res.statusText}`)
  return res.json()
}

export async function deleteLLMProvider(id) {
  const res = await fetch(`${API_BASE}/llm-providers/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`Failed to delete LLM provider: ${res.statusText}`)
}

export async function addLLMModel(providerId, data) {
  const res = await fetch(`${API_BASE}/llm-providers/${providerId}/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error(`Failed to add model: ${res.statusText}`)
  return res.json()
}

export async function updateLLMModel(providerId, modelId, data) {
  const res = await fetch(`${API_BASE}/llm-providers/${providerId}/models/${modelId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error(`Failed to update model: ${res.statusText}`)
  return res.json()
}

export async function deleteLLMModel(providerId, modelId) {
  const res = await fetch(`${API_BASE}/llm-providers/${providerId}/models/${modelId}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`Failed to delete model: ${res.statusText}`)
}

export async function updateAgent(discussionId, agentId, data) {
  const res = await fetch(`${API_BASE}/discussions/${discussionId}/agents/${agentId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error(`Failed to update agent: ${res.statusText}`)
  return res.json()
}

export async function prepareAgents(discussionId) {
  const res = await fetch(`${API_BASE}/discussions/${discussionId}/prepare-agents`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error(`Failed to prepare agents: ${res.statusText}`)
  return res.json()
}

export async function generateTitle(discussionId) {
  const res = await fetch(`${API_BASE}/discussions/${discussionId}/generate-title`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error(`Failed to generate title: ${res.statusText}`)
  return res.json()
}

// --- Material APIs ---

export async function uploadMaterials(discussionId, files) {
  const formData = new FormData()
  for (const file of files) {
    formData.append('files', file)
  }
  const res = await fetch(`${API_BASE}/discussions/${discussionId}/materials`, {
    method: 'POST',
    body: formData,
  })
  if (!res.ok) throw new Error(`Failed to upload materials: ${res.statusText}`)
  return res.json()
}

export async function listMaterials(discussionId) {
  const res = await fetch(`${API_BASE}/discussions/${discussionId}/materials`)
  if (!res.ok) throw new Error(`Failed to list materials: ${res.statusText}`)
  return res.json()
}

export async function deleteMaterial(discussionId, materialId) {
  const res = await fetch(`${API_BASE}/discussions/${discussionId}/materials/${materialId}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`Failed to delete material: ${res.statusText}`)
}

export async function streamDiscussion(id, onEvent, onError, onComplete) {
  const controller = new AbortController()

  try {
    const res = await fetch(`${API_BASE}/discussions/${id}/run`, {
      method: 'POST',
      signal: controller.signal,
    })

    if (!res.ok) {
      onError?.(`Failed to start discussion: ${res.statusText}`)
      return controller
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() // keep incomplete line in buffer

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data: ')) continue
            const jsonStr = trimmed.slice(6)
            if (!jsonStr) continue

            try {
              const event = JSON.parse(jsonStr)
              if (event.event_type === 'complete') {
                onComplete?.(event)
              } else if (event.event_type === 'error') {
                onError?.(event.content)
              } else {
                onEvent?.(event)
              }
            } catch (e) {
              // skip malformed JSON lines
            }
          }
        }
        // Stream ended naturally without a complete event
      } catch (err) {
        if (err.name !== 'AbortError') {
          onError?.(err.message || 'Connection lost')
        }
      }
    }

    pump()
  } catch (err) {
    if (err.name !== 'AbortError') {
      onError?.(err.message || 'Failed to connect')
    }
  }

  return controller
}
