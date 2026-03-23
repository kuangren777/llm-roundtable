import test from 'node:test';
import assert from 'node:assert/strict';

import { isNearBottom, shouldAutoScrollToBottom } from './messageListScroll.ts';

test('isNearBottom returns true when remaining distance is within threshold', () => {
  assert.equal(
    isNearBottom({ scrollHeight: 1200, scrollOffset: 820, clientHeight: 300, threshold: 100 }),
    true,
  );
});

test('isNearBottom returns false when user is reading history far from bottom', () => {
  assert.equal(
    isNearBottom({ scrollHeight: 1200, scrollOffset: 600, clientHeight: 300, threshold: 100 }),
    false,
  );
});

test('should auto scroll when near bottom and a persisted message is appended', () => {
  assert.equal(
    shouldAutoScrollToBottom({
      isNearBottom: true,
      messageCountChanged: true,
      streamingChanged: false,
    }),
    true,
  );
});

test('should auto scroll when near bottom and streaming content changes', () => {
  assert.equal(
    shouldAutoScrollToBottom({
      isNearBottom: true,
      messageCountChanged: false,
      streamingChanged: true,
    }),
    true,
  );
});

test('should not auto scroll when user is away from bottom', () => {
  assert.equal(
    shouldAutoScrollToBottom({
      isNearBottom: false,
      messageCountChanged: true,
      streamingChanged: true,
    }),
    false,
  );
});
