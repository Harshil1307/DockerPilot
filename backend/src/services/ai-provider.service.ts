export type AiMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export function aiProviderConfiguration() {
  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  if (geminiKey) return { provider: 'gemini' as const, apiKey: geminiKey, model: process.env.GEMINI_MODEL?.trim() || 'gemini-3.5-flash-lite' };
  const openAiKey = process.env.OPENAI_API_KEY?.trim();
  if (openAiKey) return { provider: 'openai' as const, apiKey: openAiKey, model: process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini' };
  return null;
}

export async function requestAiText(messages: AiMessage[], options: { temperature: number; json?: boolean; timeoutMs?: number }) {
  const config = aiProviderConfiguration();
  if (!config) throw new Error('AI_PROVIDER_NOT_CONFIGURED');
  const signal = AbortSignal.timeout(options.timeoutMs ?? 30_000);
  let response: Response;
  if (config.provider === 'gemini') {
    const system = messages.find((message) => message.role === 'system')?.content;
    const input = messages.filter((message) => message.role !== 'system').map((message) => ({ type: message.role === 'assistant' ? 'model_output' : 'user_input', content: [{ type: 'text', text: message.content }] }));
    const body: Record<string, unknown> = { model: config.model, input, generation_config: { temperature: options.temperature }, store: false };
    if (system) body.system_instruction = system;
    if (options.json) body.response_format = { type: 'text', mime_type: 'application/json' };
    response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', { method: 'POST', headers: { 'x-goog-api-key': config.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    if (!response.ok) { await response.body?.cancel(); throw new Error('AI_PROVIDER_ERROR'); }
    const data = await response.json() as { steps?: { type?: string; content?: { type?: string; text?: unknown }[] }[] };
    const text = data.steps?.filter((step) => step.type === 'model_output').flatMap((step) => step.content ?? []).map((part) => typeof part.text === 'string' ? part.text : '').join('');
    if (!text?.trim()) throw new Error('AI_EMPTY_RESPONSE');
    return { text, model: config.model, provider: config.provider };
  }
  const body: Record<string, unknown> = { model: config.model, messages, temperature: options.temperature };
  if (options.json) body.response_format = { type: 'json_object' };
  response = await fetch(`${(process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!response.ok) { await response.body?.cancel(); throw new Error('AI_PROVIDER_ERROR'); }
  const data = await response.json() as { choices?: { message?: { content?: unknown } }[] };
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('AI_EMPTY_RESPONSE');
  return { text, model: config.model, provider: config.provider };
}
