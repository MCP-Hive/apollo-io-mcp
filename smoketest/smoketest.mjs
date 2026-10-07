#!/usr/bin/env node
/**
 * Smoke test for server/bundle.mjs, with no dependencies and no Apollo key.
 *
 * Starts a fake Apollo on localhost, launches the bundle over stdio pointed at
 * it via APOLLO_BASE_URL, and checks that:
 *   - the server starts and lists its tools, with `webhook_url` on both
 *     people-enrichment tools;
 *   - `webhook_url` reaches Apollo as a query parameter on /people/match and
 *     /people/bulk_match, which is what Apollo requires for phone reveals.
 *
 *   node smoketest/smoketest.mjs
 */
import { spawn } from "child_process";
import { createServer } from "http";
import { fileURLToPath } from "url";
import path from "path";
import assert from "assert/strict";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WEBHOOK = "https://hooks.example.com/webhooks/apollo/phone/req-1/tok-1";

const seen = [];
const apollo = createServer((req, res) => {
  seen.push(req.url);
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(req.url.startsWith("/people/bulk_match")
    ? { matches: [{ id: "p1" }] }
    : { person: { id: "p1" } }));
});
await new Promise((r) => apollo.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${apollo.address().port}`;

const child = spawn(process.execPath, [path.join(root, "server/bundle.mjs")], {
  env: { ...process.env, APOLLO_API_KEY: "smoketest", APOLLO_BASE_URL: baseUrl },
  stdio: ["pipe", "pipe", "inherit"],
});

let buffer = "";
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout on ${method}`)), 15000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
  });
}

try {
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoketest", version: "0" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const { result: { tools } } = await rpc("tools/list", {});
  for (const name of ["apollo_enrich_person", "apollo_bulk_enrich_people"]) {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `${name} is listed`);
    assert.ok(tool.inputSchema.properties.webhook_url, `${name} accepts webhook_url`);
  }

  const person = await rpc("tools/call", {
    name: "apollo_enrich_person",
    arguments: { email: "jane@example.com", reveal_phone_number: true, webhook_url: WEBHOOK },
  });
  assert.ok(!person.result.isError, JSON.stringify(person.result));

  const bulk = await rpc("tools/call", {
    name: "apollo_bulk_enrich_people",
    arguments: { people: [{ email: "jane@example.com" }], reveal_phone_number: true, webhook_url: WEBHOOK },
  });
  assert.ok(!bulk.result.isError, JSON.stringify(bulk.result));

  const expected = `webhook_url=${encodeURIComponent(WEBHOOK)}`;
  assert.ok(seen.some((u) => u.startsWith("/people/match?") && u.includes(expected)), seen.join("\n"));
  assert.ok(seen.some((u) => u.startsWith("/people/bulk_match?") && u.includes(expected)), seen.join("\n"));

  console.log(`smoketest passed: ${tools.length} tools, webhook_url forwarded on both enrichment calls`);
} finally {
  child.kill();
  apollo.close();
}
