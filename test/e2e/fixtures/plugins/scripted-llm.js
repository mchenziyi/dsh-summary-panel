/**
 * Scripted model adapter for the real-process e2e harness.
 *
 * It registers the `scripted` provider on the real `llm` service, so the real
 * agent loop, real tool registry and real tools run exactly as they do with a
 * provider; only the model text/tool-calls come from `script.json` instead of
 * the network. One scripted response is consumed per ordinary model call;
 * auxiliary calls (session title, compaction) answer deterministically and do
 * not consume the program.
 *
 * The response shape is `{ tool, arguments }` for one tool call or `{ text }`
 * for a final answer. This is test infrastructure that exists only in the
 * throwaway profile — the product is untouched.
 */

import { readFileSync } from 'node:fs';

export const name = 'e2e-scripted-llm';
export const inject = ['llm'];

/** Chunks for one scripted response, in the adapter's raw streaming protocol. */
function chunksFor(response, serial, finishKind) {
  const start = { type: 'block-start', index: 0, blockType: finishKind === 'tool-calls' ? 'tool-call' : 'text' };
  const usage = { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } };
  const finish = { type: 'finish', reason: { kind: finishKind } };
  if (finishKind === 'tool-calls') {
    const id = `call-${serial}`;
    const args = JSON.stringify(response.arguments ?? {});
    return [
      start,
      { type: 'tool-call-delta', index: 0, id, name: response.tool, argumentsDelta: args },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: response.tool, arguments: args } },
      usage,
      finish,
    ];
  }
  const text = typeof response.text === 'string' ? response.text : '';
  return [
    start,
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    usage,
    finish,
  ];
}

export function apply(ctx, config = {}) {
  if (typeof config.script !== 'string') throw new Error('e2e-scripted-llm needs config.script');
  const program = JSON.parse(readFileSync(config.script, 'utf8'));
  const queue = Array.isArray(program.responses) ? [...program.responses] : [];
  let serial = 0;
  const adapter = {
    providerInfo: (provider) => ({ id: provider, name: 'Scripted (e2e)' }),
    providerRetryPolicy: () => undefined,
    async listModels(provider) {
      return [{ provider, id: 'scripted-1', name: 'scripted-1' }];
    },
    async resolveModel(provider, model) {
      return { provider, id: model, name: model };
    },
    async prepareCall(provider, model) {
      return { model: { provider, id: model, name: model }, stream: (options) => adapter.stream(options) };
    },
    stream(options) {
      serial += 1;
      const response = options?.purpose === 'session-title'
        ? { text: 'e2e session' }
        : (queue.length > 0 ? queue.shift() : { text: '[e2e script exhausted]' });
      const finishKind = typeof response.tool === 'string' ? 'tool-calls' : 'stop';
      return (async function* stream() {
        for (const chunk of chunksFor(response, serial, finishKind)) yield chunk;
      })();
    },
  };
  ctx.effect(() => ctx.llm.registerAdapter(['scripted'], adapter));
}
