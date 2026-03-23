export interface NearBottomInput {
  scrollHeight: number;
  scrollOffset: number;
  clientHeight: number;
  threshold: number;
}

export interface AutoScrollDecisionInput {
  isNearBottom: boolean;
  messageCountChanged: boolean;
  streamingChanged: boolean;
}

export function isNearBottom({ scrollHeight, scrollOffset, clientHeight, threshold }: NearBottomInput): boolean {
  return scrollHeight - scrollOffset - clientHeight <= threshold;
}

export function shouldAutoScrollToBottom({
  isNearBottom,
  messageCountChanged,
  streamingChanged,
}: AutoScrollDecisionInput): boolean {
  return isNearBottom && (messageCountChanged || streamingChanged);
}
