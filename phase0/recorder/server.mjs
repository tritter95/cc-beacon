// Phase 0 hook recorder: logs every Claude Code HTTP hook request with timing and headers.
// Usage: node server.mjs [port] [outDir]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.argv[2] ?? 48899);
const outDir = path.resolve(process.argv[3] ?? new URL('../fixtures/raw', import.meta.url).pathname);
fs.mkdirSync(outDir, { recursive: true });
const logFile = path.join(outDir, 'events.jsonl');
let seq = 0;

const server = http.createServer((req, res) => {
  const t = Date.now();
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    // ACK first, before any processing: Claude Code waits on HTTP hooks.
    res.writeHead(204);
    res.end();

    const raw = Buffer.concat(chunks).toString('utf8');
    let body;
    try { body = JSON.parse(raw); } catch { body = { _unparsed: raw }; }
    const rec = {
      seq: ++seq,
      receivedAt: new Date(t).toISOString(),
      receivedAtMs: t,
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
    };
    fs.appendFileSync(logFile, JSON.stringify(rec) + '\n');
    const ev = body.hook_event_name ?? 'unknown';
    const sub = body.notification_type ?? body.tool_name ?? body.source ?? '';
    const name = `${String(rec.seq).padStart(3, '0')}-${ev}${sub ? '-' + sub : ''}.json`;
    fs.writeFileSync(path.join(outDir, name), JSON.stringify(rec, null, 2));
    console.log(`${rec.receivedAt} #${rec.seq} ${ev} ${sub} pid=${req.headers['x-cc-beacon-claude-pid'] ?? ''} window=${req.headers['x-cc-beacon-window'] ?? ''} entry=${req.headers['x-cc-beacon-entrypoint'] ?? ''}`);
  });
});

server.listen(port, '127.0.0.1', () => console.log(`recorder listening on 127.0.0.1:${port}, writing to ${outDir}`));
