import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY = "test-key";
process.env.OPENROUTER_TIMEOUT_MS = "1000";

const { openrouterChat } = await import("../lib/openrouter.js");

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
const originalError = console.error;
const logs = [];

console.warn = (...args) => logs.push(["warn", args.join(" ")]);
console.error = (...args) => logs.push(["error", args.join(" ")]);

function completion(content, model = "test/model") {
  return {
    model,
    choices: [{ finish_reason: "stop", message: { content } }],
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function runWithFetch(fetchImpl, fn) {
  globalThis.fetch = fetchImpl;
  logs.length = 0;
  return fn();
}

try {
  await runWithFetch(
    async () => jsonResponse(200, completion("primary reply", "primary/model")),
    async () => {
      const data = await openrouterChat("primary/model", [
        { role: "user", content: "hi" },
      ]);
      assert.equal(data.choices[0].message.content, "primary reply");
    }
  );

  await runWithFetch(
    async (_url, init) => {
      const body = JSON.parse(init.body);
      return body.model === "bad/model"
        ? jsonResponse(404, {
            error: {
              code: 404,
              error_type: "not_found",
              message: "No endpoints found for bad/model",
            },
          })
        : jsonResponse(200, completion("fallback reply", "free/resolved-model"));
    },
    async () => {
      const data = await openrouterChat("bad/model", [
        { role: "user", content: "hi" },
      ]);
      assert.equal(data.choices[0].message.content, "fallback reply");
      assert.ok(logs.some(([, line]) => line.includes("status=404")));
      assert.ok(logs.some(([, line]) => line.includes("fallback succeeded")));
    }
  );

  let networkCalls = 0;
  await runWithFetch(
    async () => {
      networkCalls++;
      if (networkCalls === 1) throw new TypeError("network unavailable");
      return jsonResponse(200, completion("network fallback"));
    },
    async () => {
      const data = await openrouterChat("primary/model", []);
      assert.equal(data.choices[0].message.content, "network fallback");
      assert.equal(networkCalls, 2);
    }
  );

  let timeoutCalls = 0;
  process.env.OPENROUTER_TIMEOUT_MS = "10";
  await runWithFetch(
    async (_url, init) => {
      timeoutCalls++;
      if (timeoutCalls === 1) {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            reject(new DOMException("timed out", "AbortError"));
          });
        });
      }
      return jsonResponse(200, completion("timeout fallback"));
    },
    async () => {
      const data = await openrouterChat("primary/model", []);
      assert.equal(data.choices[0].message.content, "timeout fallback");
      assert.equal(timeoutCalls, 2);
    }
  );
  process.env.OPENROUTER_TIMEOUT_MS = "1000";

  let blankCalls = 0;
  await runWithFetch(
    async () => {
      blankCalls++;
      return blankCalls === 1
        ? jsonResponse(200, completion(""))
        : jsonResponse(200, completion("blank fallback"));
    },
    async () => {
      const data = await openrouterChat("primary/model", []);
      assert.equal(data.choices[0].message.content, "blank fallback");
      assert.equal(blankCalls, 2);
    }
  );

  let invalidJsonCalls = 0;
  await runWithFetch(
    async () => {
      invalidJsonCalls++;
      return invalidJsonCalls === 1
        ? new Response("{", { status: 200 })
        : jsonResponse(200, completion("JSON fallback"));
    },
    async () => {
      const data = await openrouterChat("primary/model", []);
      assert.equal(data.choices[0].message.content, "JSON fallback");
      assert.equal(invalidJsonCalls, 2);
    }
  );

  let authCalls = 0;
  await runWithFetch(
    async () => {
      authCalls++;
      return jsonResponse(401, {
        error: {
          code: 401,
          error_type: "authentication",
          message: "Invalid API key",
        },
      });
    },
    async () => {
      const data = await openrouterChat("primary/model", []);
      assert.equal(data, null);
      assert.equal(authCalls, 1);
    }
  );

  let sentBody;
  await runWithFetch(
    async (_url, init) => {
      sentBody = JSON.parse(init.body);
      return jsonResponse(200, completion("protected routing"));
    },
    async () => {
      await openrouterChat(
        "primary/model",
        [{ role: "user", content: "real transcript" }],
        { model: "override/model", messages: [] }
      );
      assert.equal(sentBody.model, "primary/model");
      assert.deepEqual(sentBody.messages, [
        { role: "user", content: "real transcript" },
      ]);
    }
  );
} finally {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
  console.error = originalError;
}

console.log("openrouter fallback checks passed");
