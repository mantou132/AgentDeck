import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentFixture } from './helpers/app-fixture.mjs';

test('deviceId option works through startTransport', () => {
  const { transport } = documentFixture();
  transport.startTransport('01234567-89ab-cdef-0123-456789abcdef', { deviceId: 'custom-device-id' });
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

  // Trigger a transport event and verify it is received
  transport.closeTransport();
  assert.equal(received.length, 1);
  assert.equal(received[0].type, 'connection');
  assert.equal(received[0].connection, 'disconnected');

  // After unsubscribe, further events must not be delivered
  unsubscribe();
  transport.closeTransport();
  assert.equal(received.length, 1);
});
