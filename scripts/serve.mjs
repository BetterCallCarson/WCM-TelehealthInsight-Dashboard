// Author: Jiajun (Carson) Chen
// email: jic4015@med.cornell.edu
/**
 * @fileoverview Serves a loopback-only local preview with no persistent server state.
 * Path containment and hidden-path checks protect local analysis downloads.
 * This convenience server is not a production hosting service.
 */
import http from 'node:http';
import {readFile, stat} from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const types = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.md': 'text/plain',
  '.csv': 'text/csv',
};
const port = Number(process.env.PORT || 4173);
http
  .createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(
        new URL(req.url, 'http://localhost').pathname,
      );
      let file = path.resolve(root, '.' + pathname);
      if (!file.startsWith(root + path.sep) && file !== root) {
        throw Error('Forbidden');
      }
      if (pathname.split('/').some((s) => s.startsWith('.'))) {
        throw Error('Private');
      }
      if ((await stat(file)).isDirectory()) {
        file = path.join(file, 'index.html');
      }
      const data = await readFile(file);
      res.writeHead(200, {
        'Content-Type': types[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  })
  .listen(port, '127.0.0.1', () =>
    console.log(`Local: http://127.0.0.1:${port}`),
  );
