const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '127.0.0.1';

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
