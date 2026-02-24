import type {
  DiscussionResponse,
  DiscussionDetail,
  DiscussionCreate,
  DiscussionEvent,
  LLMProviderResponse,
  MaterialResponse,
  ObserverChatRequest,
  SystemSettingResponse,
  AgentConfigResponse,
  MessageResponse,
} from '../types';

const API_BASE = '/api';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function requestVoid(url: string, init?: RequestInit): Promise<void> {
  const res = await fetch(`${API_BASE}${url}`, init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

// --- Discussions ---

export const listDiscussions = () => request<DiscussionResponse[]>('/discussions/');

export const getDiscussion = (id: number) => request<DiscussionDetail>(`/discussions/${id}`);

export const createDiscussion = (data: DiscussionCreate) =>
  request<DiscussionResponse>('/discussions/', {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(data),
  });

export const deleteDiscussion = (id: number) =>
  requestVoid(`/discussions/${id}`, { method: 'DELETE' });

export const stopDiscussion = (id: number) =>
  request<DiscussionResponse>(`/discussions/${id}/stop`, { method: 'POST' });

export const resetDiscussion = (id: number) =>
  request<DiscussionResponse>(`/discussions/${id}/reset`, { method: 'POST' });

export const completeDiscussion = (id: number) =>
  request<DiscussionResponse>(`/discussions/${id}/complete`, { method: 'POST' });

export const prepareAgents = (id: number) =>
  request<AgentConfigResponse[]>(`/discussions/${id}/prepare-agents`, { method: 'POST' });

export const generateTitle = (id: number) =>
  request<DiscussionResponse>(`/discussions/${id}/generate-title`, { method: 'POST' });

export const submitUserInput = (id: number, content: string) =>
  request<{ id: number; content: string }>(`/discussions/${id}/user-input`, {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ content }),
  });

// --- Agents ---

export const updateAgent = (discussionId: number, agentId: number, data: Record<string, unknown>) =>
  request<AgentConfigResponse>(`/discussions/${discussionId}/agents/${agentId}`, {
    method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(data),
  });

// --- Messages ---

export const deleteMessage = (discussionId: number, messageId: number) =>
  requestVoid(`/discussions/${discussionId}/messages/${messageId}`, { method: 'DELETE' });

export const updateMessage = (discussionId: number, messageId: number, content: string) =>
  request<MessageResponse>(`/discussions/${discussionId}/messages/${messageId}`, {
    method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ content }),
  });

export const updateTopic = (discussionId: number, content: string) =>
  request<{ id: number; topic: string }>(`/discussions/${discussionId}/topic`, {
    method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ content }),
  });

export const truncateMessagesAfter = (discussionId: number, messageId: number | null) =>
  request<{ deleted_count: number }>(`/discussions/${discussionId}/messages/truncate-after`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ message_id: messageId }),
  });

// --- Materials ---

export const uploadMaterials = async (discussionId: number, files: File[]) => {
  const formData = new FormData();
  for (const f of files) formData.append('files', f);
  return request<MaterialResponse[]>(`/discussions/${discussionId}/materials`, {
    method: 'POST', body: formData,
  });
};

export const listMaterials = (discussionId: number) =>
  request<MaterialResponse[]>(`/discussions/${discussionId}/materials`);

export const deleteMaterial = (discussionId: number, materialId: number) =>
  requestVoid(`/discussions/${discussionId}/materials/${materialId}`, { method: 'DELETE' });

export const attachMaterialsToDiscussion = (discussionId: number, materialIds: number[]) =>
  request<MaterialResponse[]>(`/discussions/${discussionId}/attach-materials`, {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ material_ids: materialIds }),
  });

// --- Material Library ---

export const listLibraryMaterials = () => request<MaterialResponse[]>('/materials/');

export const uploadToLibrary = async (files: File[]) => {
  const formData = new FormData();
  for (const f of files) formData.append('files', f);
  return request<MaterialResponse[]>('/materials/upload', { method: 'POST', body: formData });
};

export const pasteTextMaterial = (content: string) =>
  request<MaterialResponse>('/materials/paste', {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ content }),
  });

export const deleteLibraryMaterial = (id: number) =>
  requestVoid(`/materials/${id}`, { method: 'DELETE' });

// --- LLM Providers ---

export const listLLMProviders = () => request<LLMProviderResponse[]>('/llm-providers/');

export const addLLMProvider = (data: { name: string; provider: string; api_key?: string; base_url?: string }) =>
  request<LLMProviderResponse>('/llm-providers/', {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(data),
  });

export const updateLLMProvider = (id: number, data: Record<string, unknown>) =>
  request<LLMProviderResponse>(`/llm-providers/${id}`, {
    method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(data),
  });

export const deleteLLMProvider = (id: number) =>
  requestVoid(`/llm-providers/${id}`, { method: 'DELETE' });

export const addLLMModel = (providerId: number, data: { model: string; name?: string }) =>
  request<unknown>(`/llm-providers/${providerId}/models`, {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(data),
  });

export const updateLLMModel = (providerId: number, modelId: number, data: Record<string, unknown>) =>
  request<unknown>(`/llm-providers/${providerId}/models/${modelId}`, {
    method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(data),
  });

export const deleteLLMModel = (providerId: number, modelId: number) =>
  requestVoid(`/llm-providers/${providerId}/models/${modelId}`, { method: 'DELETE' });

// --- System Settings ---

export const getSystemSetting = (key: string) => request<SystemSettingResponse>(`/settings/${key}`);

export const setSystemSetting = (key: string, value: unknown) =>
  request<SystemSettingResponse>(`/settings/${key}`, {
    method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ value }),
  });

// --- Observer ---

export const getObserverHistory = (discussionId: number) =>
  request<unknown[]>(`/discussions/${discussionId}/observer/history`);

export const clearObserverHistory = (discussionId: number) =>
  requestVoid(`/discussions/${discussionId}/observer/history`, { method: 'DELETE' });

// --- SSE Streaming helpers ---

type SSECallback<T> = (event: T) => void;

function createSSEStream(
  url: string,
  method: 'POST' | 'GET',
  body: unknown | undefined,
  onEvent: SSECallback<Record<string, unknown>>,
  onError: SSECallback<string>,
  onComplete: SSECallback<Record<string, unknown>>,
  completeTypes: string[],
): AbortController {
  const controller = new AbortController();
  const init: RequestInit = { method, signal: controller.signal };
  if (body !== undefined) {
    init.headers = JSON_HEADERS;
    init.body = JSON.stringify(body);
  }

  (async () => {
    try {
      const res = await fetch(`${API_BASE}${url}`, init);
      if (!res.ok) { onError(`Failed: ${res.statusText}`); return; }
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const jsonStr = trimmed.slice(6);
          if (!jsonStr) continue;
          try {
            const event = JSON.parse(jsonStr);
            if (completeTypes.includes(event.event_type)) onComplete(event);
            else if (event.event_type === 'error') onError(event.content);
            else onEvent(event);
          } catch { /* skip malformed */ }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== 'AbortError') onError(err.message || 'Connection lost');
    }
  })();

  return controller;
}

export function streamDiscussion(
  id: number,
  onEvent: SSECallback<DiscussionEvent>,
  onError: SSECallback<string>,
  onComplete: SSECallback<DiscussionEvent>,
  options?: { singleRound?: boolean | null },
) {
  const query = options?.singleRound == null
    ? ''
    : `?single_round=${options.singleRound ? 'true' : 'false'}`;
  return createSSEStream(
    `/discussions/${id}/run${query}`, 'POST', undefined,
    onEvent as unknown as SSECallback<Record<string, unknown>>,
    onError,
    onComplete as unknown as SSECallback<Record<string, unknown>>,
    ['complete', 'cycle_complete'],
  );
}

export function streamSummarize(
  id: number,
  onEvent: SSECallback<Record<string, unknown>>,
  onError: SSECallback<string>,
  onComplete: SSECallback<Record<string, unknown>>,
) {
  return createSSEStream(
    `/discussions/${id}/summarize`, 'POST', undefined,
    onEvent, onError, onComplete, ['summary_complete'],
  );
}

export function streamObserverChat(
  discussionId: number,
  data: ObserverChatRequest,
  onChunk: (content: string) => void,
  onError: SSECallback<string>,
  onDone: () => void,
) {
  return createSSEStream(
    `/discussions/${discussionId}/observer/chat`, 'POST', data,
    (evt) => { if (evt.event_type === 'chunk') onChunk(evt.content as string); },
    onError,
    () => onDone(),
    ['done'],
  );
}
