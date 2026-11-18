import test from "node:test";
import assert from "node:assert/strict";
import { driveRange } from "../src/lib/drivefetch.ts";

const FILE = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(String(url), init?.headers || {});
  return () => (globalThis.fetch = original);
}

test("reads a byte range and the file size from a 206 answer", async () => {
  const restore = stubFetch((url, headers) => {
    assert.match(url, /drive\.usercontent\.google\.com/);
    assert.equal(headers.range, "bytes=10-19");
    return new Response(FILE.slice(10, 20), { status: 206, headers: { "content-range": "bytes 10-19/1000", "content-type": "audio/mpeg" } });
  });
  try {
    const result = await driveRange("abc", 10, 20);
    assert.deepEqual([...result.bytes], [...FILE.slice(10, 20)]);
    assert.equal(result.total, 1000);
  } finally {
    restore();
  }
});

test("when the server ignores Range, only the needed bytes are kept", async () => {
  const restore = stubFetch(() => new Response(FILE, { status: 200, headers: { "content-type": "audio/mpeg" } }));
  try {
    const result = await driveRange("abc", 300, 310);
    assert.deepEqual([...result.bytes], [...FILE.slice(300, 310)]);
  } finally {
    restore();
  }
});

test("a Drive web page or an error gives a clear message", async () => {
  const restore = stubFetch(() => new Response("<html>quota</html>", { status: 200, headers: { "content-type": "text/html" } }));
  try {
    await assert.rejects(() => driveRange("abc", 0, 10), /Could not read this file from Google Drive/);
  } finally {
    restore();
  }
});
