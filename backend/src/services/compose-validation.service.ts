import { parseDocument } from 'yaml';

export interface ComposeValidationResult {
  valid: boolean;
  servicesCount: number;
  errors: string[];
}

export interface ApprovedComposeService {
  image: string;
  ports?: string[];
  restart?: string;
  depends_on?: string[];
}

export interface ApprovedComposeConfiguration {
  services: Record<string, ApprovedComposeService>;
}

const SERVICE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const ALLOWED_SERVICE_FIELDS = new Set(['image', 'ports', 'restart', 'depends_on']);
const SECRET_FIELD = /^(?:env(?:ironment)?|env_file|secrets?|.*(?:pass(?:word)?|secret|token|credential|api[_-]?key|private[_-]?key).*)$/i;
const DANGEROUS_FIELD_MESSAGES: Record<string, string> = {
  environment: 'environment variables may contain secrets and are not supported.',
  env_file: 'environment files may contain secrets and are not supported.',
  secrets: 'Compose secrets are outside the supported subset and are not stored.',
  privileged: 'privileged containers are not supported.',
  devices: 'host device access is not supported.',
  volumes: 'mounts are not supported, including Docker socket mounts.',
  network_mode: 'host or custom network modes are not supported.',
  pid: 'host PID namespaces are not supported.',
  ipc: 'host IPC namespaces are not supported.',
  cap_add: 'adding Linux capabilities is not supported.',
  security_opt: 'security option overrides are not supported.',
  build: 'arbitrary image build instructions are not supported.',
  container_name: 'custom container names are not supported.',
  runtime: 'custom runtimes are not supported.',
  sysctls: 'host kernel settings are not supported.',
  ulimits: 'host resource limit overrides are not supported.',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function findComposeSecretFields(composeYaml: string): string[] {
  let parsed: unknown;
  try {
    const document = parseDocument(composeYaml, { uniqueKeys: true, stringKeys: true, prettyErrors: false, logLevel: 'silent' });
    parsed = document.toJS({ maxAliasCount: 0 });
  } catch {
    const matches = composeYaml.matchAll(/(?:^|\n)\s*(environment|env_file|secrets?|[\w.-]*(?:pass(?:word)?|secret|token|credential|api[_-]?key|private[_-]?key)[\w.-]*)\s*:/gim);
    return [...new Set([...matches].map((match) => match[1]?.toLowerCase()).filter((field): field is string => Boolean(field)))];
  }

  const found = new Set<string>();
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (SECRET_FIELD.test(key)) found.add(childPath);
      visit(child, childPath);
    }
  };
  visit(parsed, '');
  return [...found];
}

function validPort(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^127\.0\.0\.1:(\d+):(\d+)(?:\/(tcp|udp))?$/.exec(value);
  if (!match) return false;
  const hostPort = Number(match[1]);
  const containerPort = Number(match[2]);
  return hostPort >= 1 && hostPort <= 65535 && containerPort >= 1 && containerPort <= 65535;
}

function validRestartPolicy(value: unknown): value is string {
  return typeof value === 'string'
    && (/^(no|always|unless-stopped)$/.test(value) || /^on-failure(?::[1-9]\d*)?$/.test(value));
}

export function validateComposeYaml(composeYaml: string): ComposeValidationResult {
  const errors: string[] = [];
  let document;
  try {
    document = parseDocument(composeYaml, {
      uniqueKeys: true,
      stringKeys: true,
      prettyErrors: false,
      logLevel: 'silent',
    });
  } catch {
    return { valid: false, servicesCount: 0, errors: ['Compose YAML could not be parsed.'] };
  }

  if (document.errors.length > 0) {
    for (const error of document.errors) errors.push(error.message);
    return { valid: false, servicesCount: 0, errors };
  }

  let config: unknown;
  try {
    config = document.toJS({ maxAliasCount: 0 });
  } catch {
    return {
      valid: false,
      servicesCount: 0,
      errors: ['YAML aliases and complex YAML values are not supported.'],
    };
  }

  if (!isRecord(config)) {
    return { valid: false, servicesCount: 0, errors: ['Compose configuration must be a YAML mapping.'] };
  }

  for (const key of Object.keys(config)) {
    if (key !== 'services') errors.push(`Top-level field '${key}' is not supported.`);
  }

  if (!Object.hasOwn(config, 'services')) {
    errors.push("Required top-level field 'services' is missing.");
    return { valid: false, servicesCount: 0, errors };
  }

  const services = config.services;
  if (!isRecord(services)) {
    errors.push("'services' must be a mapping of service names to service definitions.");
    return { valid: false, servicesCount: 0, errors };
  }

  const serviceNames = Object.keys(services);
  if (serviceNames.length === 0) errors.push('At least one service must be defined.');

  for (const serviceName of serviceNames) {
    const prefix = `services.${serviceName}`;
    if (!SERVICE_NAME.test(serviceName)) {
      errors.push(`${prefix}: service name must start with a letter or number and contain only letters, numbers, '.', '_' or '-'.`);
    }

    const service = services[serviceName];
    if (!isRecord(service)) {
      errors.push(`${prefix}: service definition must be a mapping.`);
      continue;
    }

    for (const key of Object.keys(service)) {
      if (Object.hasOwn(DANGEROUS_FIELD_MESSAGES, key)) {
        errors.push(`${prefix}.${key}: ${DANGEROUS_FIELD_MESSAGES[key]}`);
      } else if (!ALLOWED_SERVICE_FIELDS.has(key)) {
        errors.push(`${prefix}.${key}: this Compose field is not supported.`);
      }
    }

    if (typeof service.image !== 'string' || service.image.trim().length === 0 || service.image.length > 255 || /[$\\\s]/.test(service.image)) {
      errors.push(`${prefix}.image: use a non-empty image reference of 255 characters or fewer without whitespace or Compose variable interpolation.`);
    }

    if (service.ports !== undefined) {
      if (!Array.isArray(service.ports)) {
        errors.push(`${prefix}.ports: ports must be a list of '127.0.0.1:HOST:CONTAINER' strings.`);
      } else {
        service.ports.forEach((port, index) => {
          if (!validPort(port)) {
            errors.push(`${prefix}.ports[${index}]: use '127.0.0.1:HOST:CONTAINER' with numeric ports from 1 to 65535 and optional /tcp or /udp.`);
          }
        });
      }
    }

    if (service.restart !== undefined && !validRestartPolicy(service.restart)) {
      errors.push(`${prefix}.restart: use 'no', 'always', 'unless-stopped', or 'on-failure[:N]'.`);
    }

    if (service.depends_on !== undefined) {
      if (!Array.isArray(service.depends_on)) {
        errors.push(`${prefix}.depends_on: provide a list of service names.`);
      } else {
        service.depends_on.forEach((dependency, index) => {
          if (typeof dependency !== 'string') {
            errors.push(`${prefix}.depends_on[${index}]: dependency must be a service name.`);
          } else if (!Object.hasOwn(services, dependency)) {
            errors.push(`${prefix}.depends_on[${index}]: service '${dependency}' is not defined.`);
          }
        });
      }
    }
  }

  return { valid: errors.length === 0, servicesCount: serviceNames.length, errors };
}

export function normalizeValidatedComposeYaml(composeYaml: string): {
  validation: ComposeValidationResult;
  configuration: ApprovedComposeConfiguration | null;
} {
  const validation = validateComposeYaml(composeYaml);
  if (!validation.valid) return { validation, configuration: null };

  const document = parseDocument(composeYaml, {
    uniqueKeys: true,
    stringKeys: true,
    prettyErrors: false,
    logLevel: 'silent',
  });
  const parsed = document.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
  const parsedServices = parsed.services as Record<string, Record<string, unknown>>;
  const services: Record<string, ApprovedComposeService> = {};

  for (const serviceName of Object.keys(parsedServices)) {
    const source = parsedServices[serviceName]!;
    const service: ApprovedComposeService = { image: source.image as string };
    if (Array.isArray(source.ports)) service.ports = source.ports as string[];
    if (typeof source.restart === 'string') service.restart = source.restart;
    if (Array.isArray(source.depends_on)) service.depends_on = source.depends_on as string[];
    services[serviceName] = service;
  }

  return { validation, configuration: { services } };
}
