import type Docker from 'dockerode';

type StatsStream = NodeJS.ReadableStream & { destroy: () => void };

export function readDockerStats(stream: StatsStream, timeoutMs = 2_500): Promise<Docker.ContainerStats> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let previous: Docker.ContainerStats | null = null;
    let settled = false;

    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('error', onError);
      stream.removeListener('end', onEnd);
      action();
    };

    const finishWithLastSample = () => {
      if (previous) finish(() => resolve(previous!));
      else finish(() => reject(new Error('Docker Engine returned no container statistics.')));
    };

    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let current: Docker.ContainerStats;
        try { current = JSON.parse(line) as Docker.ContainerStats; }
        catch { continue; }
        if (previous) {
          const result: Docker.ContainerStats = { ...current, precpu_stats: previous.cpu_stats };
          finish(() => resolve(result));
          stream.destroy();
          return;
        }
        previous = current;
      }
    };

    const onError = (error: Error) => finish(() => reject(error));
    const onEnd = () => {
      if (buffer.trim()) {
        try {
          const current = JSON.parse(buffer) as Docker.ContainerStats;
          if (previous) {
            finish(() => resolve({ ...current, precpu_stats: previous!.cpu_stats }));
            return;
          }
          previous = current;
        } catch { /* Keep the last complete sample. */ }
      }
      finishWithLastSample();
    };

    const timer = setTimeout(() => {
      finishWithLastSample();
      stream.destroy();
    }, timeoutMs);
    stream.on('data', onData);
    stream.once('error', onError);
    stream.once('end', onEnd);
  });
}
