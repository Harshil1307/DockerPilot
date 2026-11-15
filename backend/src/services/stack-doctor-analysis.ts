import { validateComposeYaml } from './compose-validation.service.js';

export type DoctorSeverity = 'CRITICAL' | 'WARNING' | 'INFORMATIONAL';
export interface DoctorIssue {
  key: string; severity: DoctorSeverity; title: string; description: string; whyItMatters: string;
  recommendation: string; evidence: string; service: string | null;
}
export interface DoctorReport {
  projectId: string; scannedAt: string; healthScore: number; checksPerformed: number;
  passedChecks: number; warningCount: number; criticalCount: number; issues: DoctorIssue[];
}

export function scoreDoctorReport(issues: DoctorIssue[], checksPerformed: number): Pick<DoctorReport, 'healthScore' | 'passedChecks' | 'warningCount' | 'criticalCount'> {
  const criticalCount = issues.filter((issue) => issue.severity === 'CRITICAL').length;
  const warningCount = issues.filter((issue) => issue.severity === 'WARNING').length;
  const deductions = issues.reduce((sum, issue) => sum + (issue.severity === 'CRITICAL' ? 20 : issue.severity === 'WARNING' ? 7 : 1), 0);
  return { healthScore: Math.max(0, Math.min(100, 100 - deductions)), passedChecks: Math.max(0, checksPerformed - issues.length), warningCount, criticalCount };
}

export function analyzeComposeConfiguration(input: { id: string; name: string; yaml: string }): DoctorIssue[] {
  const issues: DoctorIssue[] = [];
  const validation = validateComposeYaml(input.yaml);
  if (!validation.valid) issues.push({ key: `${input.id}:compose-invalid`, severity: 'CRITICAL', title: 'Compose configuration is invalid', description: `${input.name} has configuration errors.`, whyItMatters: 'Invalid configuration can prevent a deployment from starting or updating.', recommendation: 'Open the Compose environment, correct the validation errors, and validate it again.', evidence: validation.errors.slice(0, 10).join(' ').replace(/(password|passwd|secret|token|api[_-]?key|authorization|credential)(\s*[=:]\s*)([^\s,;]+)/gi, '$1$2[REDACTED]'), service: null });
  const parsed = parseComposeSubset(input.yaml);
  if (!parsed) return issues;
  const ports = new Map<string, string>();
  for (const [service, config] of Object.entries(parsed)) {
    if (!config.restart || config.restart === 'no') issues.push({ key: `${input.id}:${service}:restart`, severity: 'WARNING', title: `${service} has no restart policy`, description: 'The service can remain stopped after a host or process restart.', whyItMatters: 'Manual recovery may be needed after routine host restarts.', recommendation: 'Consider setting restart: unless-stopped for services that should recover automatically.', evidence: `services.${service}.restart is ${config.restart ?? 'not set'}.`, service });
    for (const published of config.ports ?? []) {
      const hostPort = published.split(':').at(-2)?.split('/')[0];
      if (!hostPort) continue;
      const prior = ports.get(hostPort);
      if (prior) issues.push({ key: `${input.id}:port:${hostPort}`, severity: 'WARNING', title: `Host port ${hostPort} is declared more than once`, description: `${prior} and ${service} both publish host port ${hostPort}.`, whyItMatters: 'Docker cannot bind the same host address and port for multiple services.', recommendation: 'Assign distinct host ports or remove an unnecessary port mapping.', evidence: `services.${prior} and services.${service} both declare host port ${hostPort}.`, service });
      else ports.set(hostPort, service);
    }
    for (const dependency of config.depends_on ?? []) if (!Object.hasOwn(parsed, dependency)) issues.push({ key: `${input.id}:${service}:depends:${dependency}`, severity: 'CRITICAL', title: `${service} depends on missing service ${dependency}`, description: 'A dependency is referenced but not defined.', whyItMatters: 'The application stack may fail to start in the expected order.', recommendation: 'Add the missing service or update the dependency name.', evidence: `services.${service}.depends_on includes '${dependency}'.`, service });
  }
  return issues;
}

function parseComposeSubset(yaml: string): Record<string, { restart?: string; ports?: string[]; depends_on?: string[] }> | null {
  try {
    // Validation is authoritative for accepted fields; this small parser only reads their values.
    const services: Record<string, { restart?: string; ports?: string[]; depends_on?: string[] }> = {};
    let current: string | null = null; let section: 'ports' | 'depends_on' | null = null;
    for (const line of yaml.split(/\r?\n/)) {
      const service = /^  ([\w.-]+):\s*$/.exec(line);
      if (service) { current = service[1]!; services[current] = {}; section = null; continue; }
      if (!current) continue;
      const restart = /^    restart:\s*["']?([^"'\s#]+)["']?/.exec(line);
      if (restart) { services[current]!.restart = restart[1]; section = null; continue; }
      const list = /^    (ports|depends_on):\s*$/.exec(line);
      if (list) { section = list[1] as 'ports' | 'depends_on'; services[current]![section] = []; continue; }
      const value = /^      -\s*["']?([^"'#]+?)["']?\s*(?:#.*)?$/.exec(line);
      if (value && section) services[current]![section]!.push(value[1]!.trim());
      else if (/^    \S/.test(line)) section = null;
    }
    return Object.keys(services).length ? services : null;
  } catch { return null; }
}
