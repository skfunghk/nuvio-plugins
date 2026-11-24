// HTTP transports for the local harness.
//
// Nuvio's fetch runs on OkHttp (Android) / Ktor (iOS). The offline tests never touch the network
// (scriptedTransport); live-check.mjs puts curl in the HTTP stack's place, because the harness is
// about the plugin's logic. What the HTTP stack adds is emulated one level up, in native-fetch.mjs
// (1 MiB body cap, header joining, default User-Agent).
//
// A transport returns a "raw response":
//   { status, statusText, url, headers: [[name, value], ...] (repeats allowed), bodyBytes: Buffer }
// and throws when the request could not be made at all (the host reports that as status 0).

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

function buildArgs(request, dir) {
  const headers = request.headers instanceof Map ? [...request.headers] : Object.entries(request.headers || {});
  const args = ['--silent', '--show-error', '--compressed',
    '--output', join(dir, 'body'), '--dump-header', join(dir, 'headers'),
    '--write-out', '%{http_code}\n%{url_effective}\n%{content_type}',
    '--connect-timeout', String(request.connectTimeout ?? 30),
    '--max-time', String(request.maxTime ?? 75),
    '--proto', '=https'];                       // the plugin only ever talks https
  for (const [name, value] of headers) {
    if (name.toLowerCase() === 'accept-encoding') continue;   // OkHttp strips it too
    args.push('--header', name + ': ' + value);
  }
  if (request.method.toUpperCase() !== 'GET') args.push('--request', request.method.toUpperCase());
  if (request.followRedirects !== false) args.push('--location', '--max-redirs', '10');
  if (request.body !== undefined && request.body !== null && request.body.length) {
    const file = join(dir, 'request-body');
    writeFileSync(file, request.body);
    args.push('--data-binary', '@' + file);
  }
  args.push('--url', request.url);
  return args;
}

function parseOutput(dir, stdout, request) {
  const [codeText, url = '', contentType = ''] = stdout.toString().split('\n');
  const status = Number(codeText) || 0;
  const blocks = readFileSync(join(dir, 'headers'), 'latin1').split(/\r?\n\r?\n/).filter((b) => b.trim());
  const last = blocks[blocks.length - 1] || '';
  const lines = last.split(/\r?\n/);
  const headers = [];
  let statusText = '';
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  const reason = /^HTTP\/\S+\s+\d{3}\s*(.*)$/.exec(lines[0] || '');
  if (reason) statusText = reason[1];
  // "100 Continue" and auth-information blocks carry no reason phrase; fall back to the body-less status line.
  let bodyBytes = Buffer.alloc(0);
  try { bodyBytes = readFileSync(join(dir, 'body')); } catch { /* no body file */ }
  return { status, statusText, url: url || request.url, headers, bodyBytes, contentType };
}

const CURL_ERROR = {
  5: 'Could not resolve proxy name', 6: 'Could not resolve host', 7: 'Failed to connect to host',
  28: 'timeout', 35: 'SSL connect error', 52: 'Empty reply from server', 56: 'Failure when receiving data from the peer',
};

export function curlTransport(options = {}) {
  const base = { connectTimeout: 30, maxTime: 75, ...options };
  return {
    name: 'curl',
    send(request) {
      const dir = mkdtempSync(join(tmpdir(), 'nuvio-kanju-'));
      try {
        const proc = spawnSync('curl', buildArgs({ ...base, ...request }, dir), { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
        if (proc.error) throw proc.error;
        if (proc.status !== 0) {
          const message = (proc.stderr.toString().trim() || 'curl exit ' + proc.status);
          throw new Error(CURL_ERROR[proc.status] ? message + ' (' + CURL_ERROR[proc.status] + ')' : message);
        }
        return parseOutput(dir, proc.stdout, request);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    async sendAsync(request) {
      const dir = mkdtempSync(join(tmpdir(), 'nuvio-kanju-'));
      try {
        return await new Promise((resolve, reject) => {
          const child = spawn('curl', buildArgs({ ...base, ...request }, dir), { stdio: ['ignore', 'pipe', 'pipe'] });
          const out = [];
          child.stdout.on('data', (chunk) => out.push(chunk));
          let err = '';
          child.stderr.on('data', (chunk) => { err += chunk.toString(); });
          child.on('error', reject);
          child.on('close', (code) => {
            if (code !== 0) {
              const message = err.trim() || 'curl exit ' + code;
              reject(new Error(CURL_ERROR[code] ? message + ' (' + CURL_ERROR[code] + ')' : message));
            } else {
              try { resolve(parseOutput(dir, Buffer.concat(out), request)); } catch (error) { reject(error); }
            }
          });
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

// A transport scripted by the tests: handler(request) returns a raw response (or throws).
// `request` is { url, method, headers: Map (lower-case names), body: Buffer | null, followRedirects }.
export function scriptedTransport(handler) {
  const calls = [];
  const send = (request) => {
    // `lower` mirrors request.headers with lower-cased names, for convenient assertions.
    const record = { url: request.url, method: request.method, headers: request.headers, lower: request.lower, body: request.body, at: Date.now() };
    calls.push(record);
    const raw = handler(request);
    record.status = raw.status;
    return raw;
  };
  return {
    name: 'scripted',
    calls,
    send,
    async sendAsync(request) {
      // NuvioMobile's bridge is non-blocking; yield once so the guest can interleave other work.
      await new Promise((resolve) => setImmediate(resolve));
      return send(request);
    },
  };
}

// Tries each handler in order (null = "not mine") and falls back to the base transport.
export function compositeTransport(handlers, base) {
  const route = (request) => {
    for (const handler of handlers) {
      const raw = handler(request);
      if (raw) return { raw };
    }
    return null;
  };
  return {
    name: 'composite+' + base.name,
    send(request) {
      const hit = route(request);
      return hit ? hit.raw : base.send(request);
    },
    async sendAsync(request) {
      const hit = route(request);
      return hit ? hit.raw : base.sendAsync(request);
    },
  };
}

export function jsonResponse(status, body, headers = []) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { status, statusText: status === 200 ? 'OK' : '', url: '', headers: [['content-type', 'application/json; charset=utf-8'], ...headers], bodyBytes: Buffer.from(text, 'utf8') };
}

// One ranged GET to see whether a resolved URL really is a media file (play head only).
export async function probeMedia(url, transport) {
  let raw;
  try {
    raw = await transport.sendAsync({ url, method: 'GET', headers: new Map([['user-agent', DEFAULT_USER_AGENT], ['range', 'bytes=0-4095']]), body: null, followRedirects: true, maxTime: 25 });
  } catch (error) {
    return { ok: false, kind: 'error', detail: error.message };
  }
  const bytes = raw.bodyBytes;
  const head = bytes.subarray(0, 4096).toString('latin1');
  const type = (raw.headers.find(([name]) => name.toLowerCase() === 'content-type') || [null, ''])[1];
  let kind = 'unknown';
  if (/^\s*(#EXTM3U|<?xml)/.test(head) || /mpegurl/i.test(type)) kind = /#EXT-X-STREAMINF/.test(head) ? 'hls-master' : (/^<\?xml/.test(head) ? 'hls?' : 'hls-playlist');
  else if (bytes.length > 12 && bytes.subarray(4, 8).toString('latin1') === 'ftyp') kind = 'mp4';
  else if (bytes.length > 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') kind = 'webp-image';
  else if (/^<(!doctype|html)/i.test(head.trim())) kind = 'html';
  return { ok: raw.status >= 200 && raw.status < 300, status: raw.status, type, kind, firstBytes: head.slice(0, 48).replace(/\s+/g, ' ') };
}
