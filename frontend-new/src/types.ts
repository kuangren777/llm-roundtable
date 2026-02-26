export type DiscussionStatus = 'created' | 'planning' | 'discussing' | 'reflecting' | 'synthesizing' | 'waiting_input' | 'completed' | 'failed';
export type DiscussionMode = 'auto' | 'debate' | 'brainstorm' | 'sequential' | 'custom';
export type AgentRole = 'host' | 'panelist' | 'critic' | 'user';

export interface LLMModelResponse {
  id: number;
  model: string;
  name: string | null;
  provider_id: number;
  created_at: string;
}

export interface LLMProviderResponse {
  id: number;
  name: string;
  provider: string;
  base_url: string | null;
  has_api_key: boolean;
  created_at: string;
  models: LLMModelResponse[];
}

export interface AgentConfigResponse {
  id: number;
  name: string;
  role: AgentRole;
  persona: string | null;
  provider: string;
  model: string;
  base_url: string | null;
}

export interface MessageResponse {
  id: number;
  agent_name: string;
  agent_role: AgentRole;
  content: string;
  summary: string | null;
  round_number: number;
  cycle_index: number;
  phase: string | null;
  created_at: string;
}

export interface MaterialResponse {
  id: number;
  filename: string;
  file_type: string;
  mime_type: string | null;
  file_size: number | null;
  discussion_id: number | null;
  text_preview: string | null;
  status: string;
  meta_info: Record<string, unknown> | null;
  created_at: string;
}

export interface ObserverMessageResponse {
  id: number;
  role: string;
  content: string;
  created_at: string;
}

export interface DiscussionResponse {
  id: number;
  chat_code: string;
  topic: string;
  title: string | null;
  mode: DiscussionMode;
  status: DiscussionStatus;
  current_round: number;
  max_rounds: number;
  final_summary: string | null;
  created_at: string;
  updated_at: string;
  agents: AgentConfigResponse[];
}

export interface DiscussionDetail extends DiscussionResponse {
  messages: MessageResponse[];
  materials: MaterialResponse[];
  observer_messages: ObserverMessageResponse[];
}

export interface UserResponse {
  id: number;
  email: string;
  is_active: boolean;
  is_admin: boolean;
  created_at: string;
}

export interface AuthStatusResponse {
  user: UserResponse;
}

export interface DiscussionCreate {
  topic: string;
  mode: DiscussionMode;
  max_rounds: number;
  agents?: AgentConfigCreate[];
  selected_model_ids?: number[];
  host_model_id?: number;
}

export interface AgentConfigCreate {
  name: string;
  role: AgentRole;
  persona?: string;
  provider: string;
  model: string;
  api_key?: string;
  base_url?: string;
}

export interface DiscussionEvent {
  event_type: 'phase_change' | 'message' | 'llm_progress' | 'error' | 'complete' | 'cycle_complete';
  agent_name?: string;
  agent_role?: string;
  content?: string;
  phase?: string;
  round_number?: number;
  message_id?: number;
  cycle_index?: number;
  created_at?: string;
  chars_received?: number;
  llm_status?: string;
}

export interface ObserverEvent {
  event_type: 'chunk' | 'done' | 'error';
  content?: string;
}

export interface SummaryEvent {
  event_type: 'summary_progress' | 'summary_chunk' | 'summary_done' | 'summary_complete' | 'summary_error' | 'error';
  content?: string;
  message_id?: number;
  round_number?: number;
  agent_name?: string;
  chars_received?: number;
}

export interface ObserverChatRequest {
  content: string;
  provider: string;
  model: string;
  provider_id?: number;
  reuse_message_id?: number;
}

export interface SystemSettingResponse {
  key: string;
  value: string | null;
}
