// Talks to an open-weight model (Gemma 4) through one of two APIs:
// MODEL_API=ollama  -> Ollama's native API (local Mac, or Ollama on a Droplet)
// MODEL_API=openai  -> any OpenAI-compatible endpoint (DigitalOcean serverless inference, vLLM, llama.cpp server, ...)

const API = process.env.MODEL_API ?? 'ollama';
const BASE = process.env.MODEL_URL ?? 'http://localhost:11434';
export const MODEL = process.env.MODEL_NAME ?? 'gemma4:latest';
const KEY = process.env.MODEL_KEY;

// USD per million tokens, used only for the usage meter. Local Ollama is free.
const PRICE_IN = Number(process.env.MODEL_PRICE_IN ?? (API === 'ollama' ? 0 : 0.2));
const PRICE_OUT = Number(process.env.MODEL_PRICE_OUT ?? (API === 'ollama' ? 0 : 0.6));
export const costOf = (tin, tout) => (tin * PRICE_IN + tout * PRICE_OUT) / 1e6;

// Returns { data, tokensIn, tokensOut, ms }. `schema` is a JSON schema the reply must follow;
// `images` are JPEG buffers for the vision step.
export async function ask(prompt, { schema, images = [], temperature = 0.4, maxTokens = 2000 } = {}) {
  const t0 = Date.now();
  // OpenAI-compatible endpoints only promise "some JSON", so name the exact keys in the prompt.
  if (schema && API === 'openai') {
    prompt += `\nThe JSON object must use exactly these keys: ${schema.required.map((k) => `"${k}"${schema.properties[k].type === 'array' ? ' (array of strings)' : ''}`).join(', ')}.`;
  }
  const r = API === 'openai'
    ? await viaOpenAI(prompt, images, temperature, maxTokens)
    : await viaOllama(prompt, schema, images, temperature, maxTokens);
  if (process.env.MODEL_DEBUG) console.error('[model]', r.tout, r.text.slice(0, 400));
  let data = JSON.parse(extractJson(r.text));
  // Some replies wrap everything in one outer key ({"listing": {...}}); unwrap it.
  const vals = Object.values(data);
  if (schema && vals.length === 1 && vals[0] && typeof vals[0] === 'object' && !Array.isArray(vals[0]) && !(schema.required[0] in data)) data = vals[0];
  return { data, tokensIn: r.tin, tokensOut: r.tout, ms: Date.now() - t0 };
}

async function viaOllama(prompt, schema, images, temperature, maxTokens) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      think: false,
      keep_alive: '30m',
      ...(schema && { format: schema }),
      options: { temperature, num_predict: maxTokens },
      messages: [{ role: 'user', content: prompt, ...(images.length && { images: images.map((b) => b.toString('base64')) }) }],
    }),
  });
  if (!res.ok) throw new Error(`model ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return { text: j.message.content, tin: j.prompt_eval_count ?? 0, tout: j.eval_count ?? 0 };
}

async function viaOpenAI(prompt, images, temperature, maxTokens) {
  const content = images.length
    ? [{ type: 'text', text: prompt }, ...images.map((b) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b.toString('base64')}` } }))]
    : prompt;
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(KEY && { authorization: `Bearer ${KEY}` }) },
    body: JSON.stringify({
      model: MODEL,
      temperature,
      max_tokens: maxTokens,
      ...(process.env.MODEL_JSON_MODE !== 'false' && { response_format: { type: 'json_object' } }),
      ...(process.env.MODEL_REASONING && { reasoning_effort: process.env.MODEL_REASONING }),
      messages: [{ role: 'user', content }],
    }),
  });
  if (!res.ok) throw new Error(`model ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return { text: j.choices[0].message.content ?? '', tin: j.usage?.prompt_tokens ?? 0, tout: j.usage?.completion_tokens ?? 0 };
}

// Models sometimes wrap JSON in prose or code fences; take the outermost object.
function extractJson(text) {
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e < s) throw new Error(`model returned no JSON: ${text.slice(0, 200)}`);
  return text.slice(s, e + 1);
}
