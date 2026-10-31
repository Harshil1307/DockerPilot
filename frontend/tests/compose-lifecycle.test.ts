import assert from 'node:assert/strict';
import { test } from 'node:test';
import { availableComposeActions, deploymentStatusLabel } from '../src/lib/composeLifecycle.ts';
import { monitoringPanelState } from '../src/lib/monitoringView.ts';

test('deployment state labels expose cleanup progress and removed states', () => {
  assert.equal(deploymentStatusLabel('CLEANING'), 'Cleaning');
  assert.equal(deploymentStatusLabel('CLEANUP_FAILED'), 'Cleanup failed');
  assert.equal(deploymentStatusLabel('REMOVED'), 'Removed');
});

test('monitoring panels have explicit loading, error, empty, and ready states', () => {
  assert.equal(monitoringPanelState({ loaded: false, loading: true, error: null, itemCount: 0 }), 'loading');
  assert.equal(monitoringPanelState({ loaded: false, loading: false, error: 'offline', itemCount: 0 }), 'error');
  assert.equal(monitoringPanelState({ loaded: true, loading: false, error: null, itemCount: 0 }), 'empty');
  assert.equal(monitoringPanelState({ loaded: true, loading: false, error: null, itemCount: 2 }), 'ready');
});

test('lifecycle controls are limited to valid deployment states', () => {
  assert.deepEqual(availableComposeActions('RUNNING', true), ['stop', 'restart', 'refresh', 'cleanup']);
  assert.deepEqual(availableComposeActions('STOPPED', true), ['start', 'refresh', 'cleanup']);
  assert.deepEqual(availableComposeActions('CLEANUP_FAILED', true), ['refresh', 'cleanup']);
  assert.deepEqual(availableComposeActions('CLEANING', true), ['refresh']);
  assert.deepEqual(availableComposeActions('NOT_DEPLOYED', false), ['refresh']);
  assert.deepEqual(availableComposeActions('REMOVED', false), ['refresh']);
});
