const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const dns = require('dns');
const { URL } = require('url');

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '127.0.0.1';

/* ── /api/fetch: SSRF-safe generic proxy ────────────────── */
const FETCH_MAX_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10000;
const FETCH_MAX_REDIRECTS = 3;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;

const ipBlockList = new net.BlockList();
ipBlockList.addAddress('0.0.0.0', 'ipv4');
ipBlockList.addRange('10.0.0.0', '10.255.255.255', 'ipv4');
ipBlockList.addRange('100.64.0.0', '100.127.255.255', 'ipv4');
ipBlockList.addRange('127.0.0.0', '127.255.255.255', 'ipv4');
ipBlockList.addRange('169.254.0.0', '169.254.255.255', 'ipv4');
ipBlockList.addRange('172.16.0.0', '172.31.255.255', 'ipv4');
ipBlockList.addRange('192.0.0.0', '192.0.0.255', 'ipv4');
ipBlockList.addRange('192.0.2.0', '192.0.2.255', 'ipv4');
ipBlockList.addRange('192.168.0.0', '192.168.255.255', 'ipv4');
ipBlockList.addRange('198.18.0.0', '198.19.255.255', 'ipv4');
ipBlockList.addRange('198.51.100.0', '198.51.100.255', 'ipv4');
ipBlockList.addRange('203.0.113.0', '203.0.113.255', 'ipv4');
ipBlockList.addRange('224.0.0.0', '239.255.255.255', 'ipv4');
ipBlockList.addRange('240.0.0.0', '255.255.255.255', 'ipv4');
ipBlockList.addAddress('::1', 'ipv6');
ipBlockList.addRange('fc00::', 'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'ipv6');
ipBlockList.addRange('fe80::', 'febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'ipv6');

const rateBuckets = new Map();
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [k, v] of rateBuckets) if (v.windowStart < cutoff) rateBuckets.delete(k);
}, 60_000).unref();

function rateLimited(key) {
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    bucket = { windowStart: now, count: 1 };
    rateBuckets.set(key, bucket);
    return false;
  }
  bucket.count++;
  return bucket.count > RATE_LIMIT_MAX;
}

function resolveAndCheck(hostname) {
  return new Promise((resolve, reject) => {
    const v = net.isIP(hostname);
    if (v) {
      const type = v === 6 ? 'ipv6' : 'ipv4';
      if (ipBlockList.check(hostname, type)) return reject(new Error('blocked private/reserved IP'));
      return resolve({ ip: hostname, family: v });
    }
    dns.lookup(hostname, { all: true }, (err, addrs) => {
      if (err) return reject(err);
      if (!addrs || !addrs.length) return reject(new Error('no DNS records for ' + hostname));
      for (const a of addrs) {
        const type = a.family === 6 ? 'ipv6' : 'ipv4';
        if (ipBlockList.check(a.address, type)) return reject(new Error('blocked private/reserved IP'));
      }
      resolve({ ip: addrs[0].address, family: addrs[0].family });
    });
  });
}

function validateFetchUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); }
  catch { throw new Error('invalid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http/https allowed');
  if (!u.hostname) throw new Error('missing hostname');
  return u;
}

function fetchUpstream(targetUrl, redirectsLeft, outerCb) {
  let done = false;
  const cb = (err, ok) => { if (!done) { done = true; outerCb(err, ok); } };

  let u;
  try { u = validateFetchUrl(targetUrl); }
  catch (e) { return cb({ status: 400, message: e.message }); }

  resolveAndCheck(u.hostname).then((resolved) => {
    const lib = u.protocol === 'https:' ? https : http;
    const hostHeader = u.port ? `${u.hostname}:${u.port}` : u.hostname;
    const reqOpts = {
      method: 'GET',
      host: resolved.ip,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: {
        'User-Agent': 'md-viewer-fetch/1.0',
        'Accept': 'text/*, application/*, */*;q=0.1',
        'Host': hostHeader,
      },
      timeout: FETCH_TIMEOUT_MS,
    };
    if (u.protocol === 'https:') reqOpts.servername = u.hostname;

    const req = lib.request(reqOpts, (resp) => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        resp.resume();
        if (redirectsLeft <= 0) return cb({ status: 502, message: 'too many redirects' });
        let next;
        try { next = new URL(resp.headers.location, u).toString(); }
        catch { return cb({ status: 502, message: 'invalid redirect target' }); }
        return fetchUpstream(next, redirectsLeft - 1, cb);
      }
      if (resp.statusCode !== 200) {
        resp.resume();
        return cb({ status: 502, message: 'upstream HTTP ' + resp.statusCode });
      }

      const contentType = resp.headers['content-type'] || 'text/plain';
      const chunks = [];
      let size = 0;

      resp.on('data', (chunk) => {
        size += chunk.length;
        if (size > FETCH_MAX_BYTES) {
          cb({ status: 413, message: 'upstream body exceeds 10MB' });
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      resp.on('end', () => cb(null, { body: Buffer.concat(chunks), contentType }));
      resp.on('error', (err) => cb({ status: 502, message: 'upstream stream error: ' + err.message }));
    });

    req.on('timeout', () => { req.destroy(); cb({ status: 504, message: 'upstream timeout' }); });
    req.on('error', (err) => cb({ status: 502, message: 'upstream error: ' + err.message }));
    req.end();
  }).catch((e) => cb({ status: 400, message: e.message }));
}

function handleFetch(req, res) {
  const parsed = new URL(req.url, 'http://x');
  const target = parsed.searchParams.get('url');
  if (!target) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'missing url query param' }));
  }
  const clientIp = req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown';
  if (rateLimited(clientIp)) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'rate limit exceeded' }));
  }
  fetchUpstream(target, FETCH_MAX_REDIRECTS, (err, ok) => {
    if (err) {
      res.writeHead(err.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
    res.writeHead(200, {
      'Content-Type': ok.contentType,
      'Content-Length': ok.body.length,
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(ok.body);
  });
}


function processDataURIs(markdown, tmpDir) {
  let idx = 0;
  return markdown.replace(/!\[([^\]]*)\]\((data:[^;)]+;base64,[^)]+)\)/g, (match, alt, dataUri) => {
    const m = dataUri.match(/^data:image\/([^;]+);base64,(.+)$/);
    if (!m) return match;
    let ext = m[1];
    if (ext === 'svg+xml') ext = 'svg';
    else if (ext === 'jpeg') ext = 'jpg';
    else ext = ext.replace(/[^a-z0-9]/gi, '');
    const buf = Buffer.from(m[2], 'base64');
    const imgPath = path.join(tmpDir, `img_${idx++}.${ext}`);
    fs.writeFileSync(imgPath, buf);
    return `![${alt}](${imgPath})`;
  });
}

const server = http.createServer((req, res) => {
  if (req.url === '/api/export-docx' && req.method === 'GET') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url.startsWith('/api/fetch')) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400',
      });
      return res.end();
    }
    return handleFetch(req, res);
  }

  if (req.url !== '/api/export-docx' || req.method !== 'POST') {
    res.writeHead(404);
    res.end();
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const { markdown, filename } = JSON.parse(body);
      if (!markdown || typeof markdown !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'markdown must be a non-empty string' }));
        return;
      }

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdviewer-'));
      const tmpIn = path.join(tmpDir, 'input.md');
      const tmpOut = path.join(tmpDir, 'output.docx');

      let processed = markdown;
      try {
        processed = processDataURIs(markdown, tmpDir);
      } catch (e) {
        console.error('processDataURIs error:', e);
      }

      fs.writeFileSync(tmpIn, processed, 'utf8');

      const pandoc = spawn('pandoc', [
        '-f', 'gfm',
        '-t', 'docx',
        '--wrap=none',
        '--resource-path', tmpDir,
        '-o', tmpOut,
        tmpIn
      ], { timeout: 30000 });

      let stderr = '';
      pandoc.stderr.on('data', chunk => { stderr += chunk; });

      pandoc.on('error', (err) => {
        console.error('pandoc spawn error:', err);
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'pandoc not available' }));
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
      });

      pandoc.on('close', (code) => {
        if (code !== 0) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: stderr || 'pandoc failed' }));
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
          return;
        }

        let blob;
        try {
          blob = fs.readFileSync(tmpOut);
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'failed to read output' }));
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e2) {}
          return;
        }

        const outName = (filename || 'document.md').toString().replace(/\.md$/i, '') + '.docx';
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(outName)}"`,
          'Content-Length': blob.length
        });
        res.end(blob);

        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
      });

    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON body' }));
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`MD Viewer DOCX export backend listening on http://${HOST}:${PORT}`);
});
