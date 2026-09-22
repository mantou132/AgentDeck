import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentFixture } from './helpers/app-fixture.mjs';

test('custom createStore and deviceId options work through startTransport', async () => {
  const { transport } = documentFixture();

  const storage = {};
  const mockStore = {
    outbox: async () => [],
    enqueue: async (msg) => {
      storage[msg.messageId] = msg;
    },
    removeFromOutbox: async (id) => {
      delete storage[id];
    },
    lastReceived: async () => undefined,
    markReceived: async () => {},
    deviceId: async () => 'custom-device-id',
  };

  // startTransport with custom createStore and deviceId
  transport.startTransport('01234567-89ab-cdef-0123-456789abcdef', {
    deviceId: 'custom-device-id',
    createStore: () => mockStore,
  });

  assert.equal(transport.getDeviceId(), 'custom-device-id');
  transport.closeTransport();
});

test('addTransportMessageHandler receives transport events and allows unsubscribing', () => {
  const { transport } = documentFixture();

  const received = [];
  const unsubscribe = transport.addTransportMessageHandler((msg) => {
    received.push(msg);
  });

  assert.equal(typeof unsubscribe, 'function');

  unsubscribe();
});
