#!/usr/bin/env node
import http from 'node:http';

// Connect only to this container. Preserve the configured public Host so the
// application host guard is exercised without depending on public DNS/TLS.
const host = process.env.ELEMARKET_DOMAIN;
const request = http.get({
  hostname: '127.0.0.1', port: 8080, path: '/api/health',
  headers: host ? { Host: host } : {}, timeout: 5000,
}, response => {
  let body = '';
  response.setEncoding('utf8');
  response.on('data', chunk => {
    body += chunk;
    if (body.length > 4096) response.destroy(new Error('Health response too large'));
  });
  response.on('error', () => { process.exitCode = 1; });
  response.on('end', () => {
    try {
      const result = JSON.parse(body);
      // Redis degradation is handled by the app's PostgreSQL fallback.
      if (response.statusCode !== 200 || result.ok !== true || result.checks?.database !== 'ok') process.exitCode = 1;
    } catch { process.exitCode = 1; }
  });
});
request.on('timeout', () => request.destroy(new Error('Health check timeout')));
request.on('error', () => { process.exitCode = 1; });
