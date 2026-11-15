import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeComposeConfiguration, scoreDoctorReport } from '../src/services/stack-doctor-analysis.js';

test('reports malformed Compose configuration as critical', () => {
  const issues = analyzeComposeConfiguration({ id: 'env', name: 'broken', yaml: 'services:\n  web: [' });
  assert.equal(issues[0]?.severity, 'CRITICAL');
  assert.match(issues[0]?.evidence ?? '', /could not be parsed|flow sequence/i);
});

test('detects duplicate published ports and missing restart policies', () => {
  const compose = ['services:', '  web:', '    image: nginx', '    ports:', '      - "127.0.0.1:8080:80"', '  api:', '    image: node', '    ports:', '      - "127.0.0.1:8080:3000"', '    restart: unless-stopped', ''].join('\n');
  const issues = analyzeComposeConfiguration({ id: 'env', name: 'stack', yaml: compose });
  assert.ok(issues.some((issue) => issue.title.includes('port 8080')));
  assert.ok(issues.some((issue) => issue.title === 'web has no restart policy'));
  assert.ok(!issues.some((issue) => issue.title === 'api has no restart policy'));
});

test('calculates a bounded score and issue counts from findings', () => {
  const issues = analyzeComposeConfiguration({ id: 'env', name: 'broken', yaml: '' });
  const score = scoreDoctorReport(issues, 10);
  assert.equal(score.criticalCount, 1);
  assert.equal(score.healthScore, 80);
  assert.equal(score.passedChecks, 9);
  assert.equal(scoreDoctorReport([], 0).healthScore, 100);
});

test('invalid dependency configuration is flagged by Compose validation', () => {
  const compose = ['services:', '  web:', '    image: nginx', '    depends_on:', '      - database', ''].join('\n');
  const issues = analyzeComposeConfiguration({ id: 'env', name: 'stack', yaml: compose });
  assert.equal(issues[0]?.severity, 'CRITICAL');
  assert.match(issues[0]?.evidence ?? '', /database/);
});
