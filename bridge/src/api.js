/** Talks to the website. Every call has a timeout; errors say whether trying again can help. */
export class ApiError extends Error {
  constructor(message, status, retryable) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

export class Api {
  constructor(store, version) {
    this.store = store;
    this.version = version;
    /** When the website last answered, and when a call last failed because it could not be reached. */
    this.lastOkAt = 0;
    this.lastFailAt = 0;
  }

  async call(path, { method = "POST", body, headers = {}, timeoutMs = 60_000, auth = true } = {}) {
    const { server, token } = this.store.config;
    let response;
    try {
      response = await fetch(`${server}${path}`, {
        method,
        headers: { ...(auth && token ? { authorization: `Bearer ${token}` } : {}), "user-agent": `TeamFahadBridge/${this.version}`, ...headers },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // No internet, DNS, timeout: the file simply waits.
      this.lastFailAt = Date.now();
      throw new ApiError(`No connection to the website (${error.cause?.code || error.name}).`, 0, true);
    }
    // Any answer, even an error page, proves the website can be reached.
    this.lastOkAt = Date.now();
    const text = await response.text();
    let data = {};
    try {
      data = JSON.parse(text);
    } catch {}
    if (response.ok) return data;
    const message = data.error || `Website error ${response.status}`;
    // 401: this PC was removed or never paired. 400-class errors other than 408/422/429 will not fix themselves.
    const retryable = response.status >= 500 || [408, 429].includes(response.status);
    throw new ApiError(message, response.status, retryable);
  }

  pair(code) {
    return this.call("/api/bridge/pair", { auth: false, headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
  }

  /** The computers this PC may take over (needs the team PIN). */
  linkList(pin) {
    return this.call("/api/bridge/link", { auth: false, headers: { "content-type": "application/json" }, body: JSON.stringify({ pin }) });
  }

  /** Take over the chosen computer: same name, same sheet tab. The old computer is switched off. */
  link(pin, key) {
    return this.call("/api/bridge/link", { auth: false, headers: { "content-type": "application/json" }, body: JSON.stringify({ pin, key }) });
  }

  heartbeat(info) {
    return this.call("/api/bridge/heartbeat", { headers: { "content-type": "application/json" }, body: JSON.stringify({ version: this.version, ...info }), timeoutMs: 30_000 });
  }

  piece(data, mimeType, query) {
    return this.call(`/api/bridge/piece?${new URLSearchParams(query)}`, { headers: { "content-type": mimeType }, body: data, timeoutMs: 170_000 });
  }

  complete(payload) {
    return this.call("/api/bridge/complete", { headers: { "content-type": "application/json" }, body: JSON.stringify(payload), timeoutMs: 60_000 });
  }
}
