import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..");

const PORT = parseInt(process.env.LFS_PORT || "3100");
const DEMO = process.argv.includes("--demo");

// MIME types
const MIME = {
  ".html": "text/html",
  ".mjs": "application/javascript",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".glb": "model/gltf-binary",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

// SSE client registry
const sseClients = new Set();

// Signal ring buffer (for late-joining clients)
const signalBuffer = [];
const BUFFER_MAX = 200;

export function broadcastSignal(signal) {
  const data = `data: ${JSON.stringify(signal)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch { sseClients.delete(res); }
  }
  signalBuffer.push(signal);
  if (signalBuffer.length > BUFFER_MAX) signalBuffer.shift();
}

// Serve a static file
async function serveFile(res, filePath) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) { send404(res); return; }
    const ext = extname(filePath);
    const mime = MIME[ext] || "application/octet-stream";
    const content = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mime,
      "Content-Length": content.length,
      "Cache-Control": ext === ".glb" ? "public, max-age=3600" : "no-cache",
    });
    res.end(content);
  } catch {
    send404(res);
  }
}

function send404(res) {
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

// Read POST body as JSON
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

// Demo module (lazy loaded)
let demoModule = null;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  // SSE endpoint
  if (method === "GET" && path === "/api/signals") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(":connected\n\n");

    // Send buffered signals for catch-up
    for (const sig of signalBuffer) {
      res.write(`data: ${JSON.stringify(sig)}\n\n`);
    }

    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));

    // Heartbeat every 15s
    const hb = setInterval(() => {
      try { res.write(":heartbeat\n\n"); } catch { clearInterval(hb); }
    }, 15_000);
    req.on("close", () => clearInterval(hb));
    return;
  }

  // POST signal from gro
  if (method === "POST" && path === "/api/signal") {
    try {
      const body = await readBody(req);
      // Accept single signal or array
      const signals = Array.isArray(body) ? body : [body];
      for (const sig of signals) broadcastSignal(sig);
      sendJson(res, 200, { ok: true, count: signals.length });
    } catch (e) {
      sendJson(res, 400, { error: "Invalid JSON" });
    }
    return;
  }

  // Demo controls
  if (method === "POST" && path === "/api/demo/start") {
    if (!demoModule) demoModule = await import("./demo.mjs");
    demoModule.startDemo(broadcastSignal);
    sendJson(res, 200, { ok: true, demo: "started" });
    return;
  }
  if (method === "POST" && path === "/api/demo/stop") {
    if (demoModule) demoModule.stopDemo();
    sendJson(res, 200, { ok: true, demo: "stopped" });
    return;
  }

  // Static file serving
  if (method === "GET") {
    // Root -> viewer
    if (path === "/" || path === "/index.html") {
      return serveFile(res, join(__dirname, "viewer", "index.html"));
    }
    // /viewer/* -> src/viewer/*
    if (path.startsWith("/viewer/")) {
      const rel = path.slice("/viewer/".length);
      return serveFile(res, join(__dirname, "viewer", rel));
    }
    // *.mjs / *.js at root -> src/viewer/* (relative imports from index.html)
    if (path.endsWith(".mjs") || path.endsWith(".js") || path.endsWith(".css")) {
      const rel = path.slice(1); // strip leading /
      return serveFile(res, join(__dirname, "viewer", rel));
    }
    // /ellie/* -> ellie/*
    if (path.startsWith("/ellie/")) {
      const rel = path.slice("/ellie/".length);
      return serveFile(res, join(ROOT, "ellie", rel));
    }
    // /owl/* -> owl/*
    if (path.startsWith("/owl/")) {
      const rel = path.slice("/owl/".length);
      return serveFile(res, join(ROOT, "owl", rel));
    }
  }

  send404(res);
});

server.listen(PORT, () => {
  console.log(`LFS personas server on http://localhost:${PORT}`);
  if (DEMO) {
    import("./demo.mjs").then((m) => {
      demoModule = m;
      m.startDemo(broadcastSignal);
      console.log("Demo mode active — synthetic signals streaming");
    });
  }
});
