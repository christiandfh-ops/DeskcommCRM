import { describe, expect, it, vi } from 'vitest';

import { comEsforcoDeRaciocinioOpenRouter } from './providers';

const req = (body: Record<string, unknown>): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('OpenRouter reasoning effort fallback', () => {
  it('repete sem reasoning_effort quando o endpoint exige reasoning', async () => {
    const inner = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: 'Reasoning is mandatory for this endpoint and cannot be disabled.' } }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const wrapped = comEsforcoDeRaciocinioOpenRouter(inner, 'none');
    const original = { model: 'openrouter/free', messages: [] };
    const out = await wrapped('https://openrouter.ai/api/v1/chat/completions', req(original));

    expect(out.status).toBe(200);
    expect(inner).toHaveBeenCalledTimes(2);

    const firstBody = JSON.parse(String(inner.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(inner.mock.calls[1]?.[1]?.body));
    expect(firstBody.reasoning_effort).toBe('none');
    expect(secondBody).toEqual(original);
  });

  it('não esconde outros HTTP 400', async () => {
    const inner = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'invalid model' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const wrapped = comEsforcoDeRaciocinioOpenRouter(inner, 'none');
    const out = await wrapped(
      'https://openrouter.ai/api/v1/chat/completions',
      req({ model: 'openrouter/free' }),
    );

    expect(out.status).toBe(400);
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
