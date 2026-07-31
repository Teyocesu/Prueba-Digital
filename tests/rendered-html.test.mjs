import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("renderiza la aplicación judicial en español", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(
    html,
    /<title>Prueba Digital \| Hash SHA-256 y manifiesto judicial<\/title>/i,
  );
  assert.match(html, /Prepará tu prueba digital/);
  assert.match(html, /Procesamiento local/);
  assert.match(html, /Verificar un hash/);
  assert.match(html, /href="\/favicon\.png"/);
  assert.doesNotMatch(
    html,
    /href="https:\/\/prueba-digital\.onrender\.com\/favicon\.png"/,
  );
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("incluye cabeceras de seguridad y privacidad", async () => {
  const response = await render();
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(
    response.headers.get("permissions-policy") ?? "",
    /microphone=\(\)/,
  );
  const csp = response.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /worker-src 'self' blob:/);
  assert.match(csp, /media-src 'self' blob:/);
});
