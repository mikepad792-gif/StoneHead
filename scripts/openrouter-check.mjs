import assert from "node:assert/strict";

process.env.OPENROUTER_API_KEY = "test-key";
process.env.OPENROUTER_TIMEOUT_MS = "1000";
// config.js throws at load when no model resolves — that is the point of it.
// Stub the shared default so this harness exercises the client, not the guard.
// The guard itself is asserted separately at the bottom of this file.
process.env.AI_MODEL = "primary/model";

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

  // 402 = insufficient credit. Both models bill from the SAME OpenRouter
  // balance, so the retry cannot help — it must hard-fail like 401 does
  // rather than burning a second request to fail identically.
  let creditCalls = 0;
  await runWithFetch(
    async () => {
      creditCalls++;
      return jsonResponse(402, {
        error: {
          code: 402,
          error_type: "insufficient_credits",
          message: "Insufficient credits",
        },
      });
    },
    async () => {
      const data = await openrouterChat("primary/model", []);
      assert.equal(data, null);
      assert.equal(creditCalls, 1, "402 must not fall back to a second model");
    }
  );

  // An explicit timeoutMs overrides OPENROUTER_TIMEOUT_MS. This is what keeps
  // the synchronous chat path inside Netlify's 10s function ceiling while the
  // background paths keep the longer default.
  let overrideCalls = 0;
  process.env.OPENROUTER_TIMEOUT_MS = "60000";
  await runWithFetch(
    async (_url, init) => {
      overrideCalls++;
      if (overrideCalls === 1) {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            reject(new DOMException("timed out", "AbortError"));
          });
        });
      }
      return jsonResponse(200, completion("override fallback"));
    },
    async () => {
      const data = await openrouterChat("primary/model", [], {}, { timeoutMs: 10 });
      assert.equal(data.choices[0].message.content, "override fallback");
      assert.equal(overrideCalls, 2, "override timeout must fire before the env default");
    }
  );
  process.env.OPENROUTER_TIMEOUT_MS = "1000";

  // A blank model is a configuration error, not something to paper over by
  // silently substituting the fallback.
  await runWithFetch(
    async () => jsonResponse(200, completion("should not be reached")),
    async () => {
      await assert.rejects(
        () => openrouterChat("", [{ role: "user", content: "hi" }]),
        /configuration error/,
        "blank model must throw rather than substitute the fallback"
      );
      await assert.rejects(
        () => openrouterChat(undefined, [{ role: "user", content: "hi" }]),
        /configuration error/,
        "absent model must throw rather than substitute the fallback"
      );
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

// ── config guard, in a child process ────────────────────────────────
// lib/config.js resolves models at MODULE LOAD, so this cannot be asserted
// in-process — the module is already cached with AI_MODEL stubbed above.
// A deploy with no model configured must fail loudly at cold start rather
// than serve traffic on an unintended endpoint.
{
  const { spawnSync } = await import("node:child_process");
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "AI_MODEL" || key.startsWith("AI_MODEL_")) delete env[key];
  }
  const probe = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", 'await import("./lib/config.js");'],
    { env, cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" }
  );
  assert.notEqual(probe.status, 0, "config.js must throw when no model is configured");
  assert.match(
    probe.stderr,
    /Missing model configuration/,
    `expected a config error, got: ${probe.stderr.slice(0, 300)}`
  );

  // ...and it must NOT throw once a model resolves.
  const ok = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", 'await import("./lib/config.js");'],
    {
      env: { ...env, AI_MODEL: "some/model" },
      cwd: new URL("..", import.meta.url).pathname,
      encoding: "utf8",
    }
  );
  assert.equal(ok.status, 0, `config.js must load with AI_MODEL set: ${ok.stderr.slice(0, 300)}`);
}

console.log("openrouter fallback checks passed");
