// Nuvio host glue for the local test harness.
//
// Pulls the JavaScript that Nuvio itself evaluates around a plugin — the polyfill that defines
// fetch / URL / console inputs, the CommonJS wrapper and the getStreams call — straight out of
// the Nuvio sources, so the tests run the plugin inside the same glue as the device. Nothing is
// copied into this repo: point NUVIO_SOURCES at a checkout (or a partial fetch) of
//   NuvioMedia/NuvioTV      b70adbb8357e5c5042c35824ed1f060cd9fa973a
//   NuvioMedia/NuvioMobile   4ec93635a16aa3f5fc810c62158f6eb4aef261e5
// Layout under that directory: NuvioTV/<repo paths>, NuvioMobile/<repo paths>.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const SOURCES = Object.freeze({
  tv: {
    repo: 'NuvioMedia/NuvioTV',
    commit: 'b70adbb8357e5c5042c35824ed1f060cd9fa973a',
    runtime: 'NuvioTV/app/src/full/java/com/nuvio/tv/core/plugin/PluginRuntime.kt',
    timeouts: { pluginMs: 60000 },
  },
  mobile: {
    repo: 'NuvioMedia/NuvioMobile',
    commit: '4ec93635a16aa3f5fc810c62158f6eb4aef261e5',
    bindings: 'NuvioMobile/composeApp/src/fullCommonMain/kotlin/com/nuvio/app/features/plugins/runtime/js/JsBindings.kt',
    timeouts: { pluginMs: 60000 },
  },
});

const CANDIDATES = [
  process.env.NUVIO_SOURCES,
  join(HERE, '..', '..', '..', 'nuvio-research'),
].filter(Boolean);

export function findSourcesDir() {
  for (const dir of CANDIDATES) {
    const d = resolve(dir);
    if (existsSync(join(d, SOURCES.tv.runtime)) && existsSync(join(d, SOURCES.mobile.bindings))) return d;
  }
  return null;
}

function kotlinRawString(source, header) {
  const at = source.indexOf(header);
  if (at < 0) throw new Error('kotlin raw string not found: ' + header);
  const start = source.indexOf('"""', at);
  const end = source.indexOf('"""', start + 3);
  if (start < 0 || end < 0) throw new Error('unterminated kotlin raw string: ' + header);
  return source.slice(start + 3, end).replace(/\r/g, '');
}

// Same result as Kotlin's String.trimIndent(): drop blank first/last lines, remove the common indent.
function trimIndent(text) {
  const lines = text.split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  let indent = Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    indent = Math.min(indent, line.match(/^[ \t]*/)[0].length);
  }
  if (!Number.isFinite(indent)) indent = 0;
  return lines.map((line) => line.slice(indent)).join('\n');
}

export function loadGlue() {
  const dir = findSourcesDir();
  if (!dir) {
    throw new Error('Nuvio sources not found. Set NUVIO_SOURCES to a directory holding NuvioTV/ and NuvioMobile/ '
      + 'at the commits listed in test/host-glue.mjs (see README, "Testing").');
  }
  const tv = readFileSync(join(dir, SOURCES.tv.runtime), 'utf8');
  const mb = readFileSync(join(dir, SOURCES.mobile.bindings), 'utf8');

  // NuvioMobile builds its polyfill from Kotlin string templates: ${xxxPolyfill()}.
  let mobilePolyfill = kotlinRawString(mb, 'val staticPolyfillCode: String');
  const missing = [];
  mobilePolyfill = mobilePolyfill.replace(/\$\{(\w+)\(\)\}/g, (_, name) => {
    const body = kotlinRawString(mb, 'private fun ' + name + '()');
    if (body === undefined) missing.push(name);
    return trimIndent(body);
  });
  if (missing.length) throw new Error('polyfill parts missing from JsBindings.kt: ' + missing.join(', '));

  return {
    dir,
    commits: { tv: SOURCES.tv.commit, mobile: SOURCES.mobile.commit },
    tv: {
      polyfill: trimIndent(kotlinRawString(tv, 'private fun getStaticPolyfillCode()')),
      callCode: trimIndent(kotlinRawString(tv, 'private fun getStaticCallCode()')),
      timeoutMs: SOURCES.tv.timeouts.pluginMs,
    },
    mobile: {
      polyfill: trimIndent(mobilePolyfill),
      callCode: trimIndent(kotlinRawString(mb, 'val staticCallCode: String')),
      settingsCallCode: trimIndent(kotlinRawString(mb, 'val staticSettingsCallCode: String')),
      timeoutMs: SOURCES.mobile.timeouts.pluginMs,
    },
    // Identical in both hosts (PluginRuntime.kt / PluginRepository.wrapPluginModule).
    wrapper: [
      'var module = { exports: {} };',
      'var exports = module.exports;',
      '(function() {',
      '    __PLUGIN_CODE__',
      '})();',
    ].join('\n'),
  };
}
