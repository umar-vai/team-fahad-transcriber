/**
 * GeminiRelay: a tiny Durable Object pinned to North America that forwards Gemini requests.
 *
 * Gemini refuses requests from some regions ("User location is not supported for the API use").
 * A Durable Object runs where it was first created, so a batch that started near Bangladesh keeps
 * hitting that error forever, whatever key is used. When that happens, gemini.ts sends the same
 * request through this relay instead, which reaches Google from a supported location.
 */
import { DurableObject } from "cloudflare:workers";

export interface RelayResponse {
  status: number;
  statusText: string;
  text: string;
}

export class GeminiRelay extends DurableObject<Env> {
  async send(url: string, key: string, method: string, body: string | undefined, timeoutMs: number): Promise<RelayResponse> {
    const response = await fetch(url, {
      method,
      headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, statusText: response.statusText, text: await response.text() };
  }
}
