import test from "node:test";
import assert from "node:assert/strict";
import { env } from "./stubs/cloudflare-workers.mjs";
import { LinkJob } from "../src/batch/linkjob.ts";

/** In-memory Durable Object storage with the calls LinkJob uses. */
function fakeStorage() {
  const data = new Map();
  let alarm = null;
  return {
    data,
    get alarm() { return alarm; },
    async get(key) { return structuredClone(data.get(key)); },
    async put(key, value) {
      if (typeof key === "object") for (const [k, v] of Object.entries(key)) data.set(k, structuredClone(v));
      else data.set(key, structuredClone(value));
    },
    async list({ prefix }) {
      return new Map([...data].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)));
    },
    async setAlarm(at) { alarm = at; },
    async deleteAll() { data.clear(); },
  };
}

function fakeDb(rows) {
  return {
    prepare(sql) {
      return { bind: (...args) => ({ run: async () => rows.push({ sql, args }) }) };
    },
  };
}

function makeJob(rows) {
  const job = new LinkJob();
  job.ctx = { storage: fakeStorage() };
  job.env = { DB: fakeDb(rows) };
  return job;
}

async function runUntilFinished(job) {
  for (let i = 0; i < 20; i++) {
    const state = await job.ctx.storage.get("state");
    if (state?.status !== "running") return state;
    await job.alarm();
  }
  throw new Error("job did not finish");
}

test("a YouTube link job transcribes every clip on the server and saves one History row", async () => {
  env.GEMINI_API_KEYS = "key-one,key-two";
  env.GEMINI_API_BASE = "https://gemini.test";
  const seenStarts = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/models?")) {
      return new Response(JSON.stringify({ models: [{ name: "models/gemini-3.5-flash", supportedGenerationMethods: ["generateContent"] }] }));
    }
    const body = JSON.parse(init.body);
    const start = body.contents[0].parts[1].fileData && body.contents[0].parts[1].videoMetadata?.startOffset;
    seenStarts.push(start);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: `Part starting ${start}` }] } }] }));
  };
  try {
    const rows = [];
    const job = makeJob(rows);
    await job.start({
      id: "11111111-1111-1111-1111-111111111111",
      userId: "user-1",
      url: "https://www.youtube.com/watch?v=abcdefghijk",
      title: "Test video",
      duration: 900,
      mode: "smart",
      language: "English (US)",
      vocab: [],
      ranges: [{ start: 0, end: 300 }, { start: 300, end: 600 }, { start: 600, end: 900 }],
      createdAt: Date.now(),
    });
    assert.equal((await job.status("someone-else")), null);
    const state = await runUntilFinished(job);
    assert.equal(state.status, "done");
    assert.equal(seenStarts.length, 3);
    assert.equal(rows.length, 1);
    const transcript = rows[0].args[8];
    assert.equal(transcript, "Part starting 0s\n\nPart starting 300s\n\nPart starting 600s");
    const status = await job.status("user-1");
    assert.equal(status.done, 3);
    assert.equal(status.historyId, rows[0].args[0]);
  } finally {
    globalThis.fetch = original;
  }
});
