// Updates: version order, the "What's new" text, and which file is offered. Run: node tests/updates.test.js
const assert = require('assert');
const U = require('../desktop/updates.js');

let pass = 0, fail = 0;
async function check(name, fn) { try { await fn(); pass++; } catch (e) { fail++; console.log('FAIL', name, '\n  ', e.message); } }

(async () => {
  await check('newer versions', () => {
    assert.ok(U.newer('1.7.5', '1.7.4'));
    assert.ok(U.newer('1.10.0', '1.9.9'));
    assert.ok(U.newer('v2.0.0', '1.99.99'));
    assert.ok(!U.newer('1.7.4', '1.7.4'));
    assert.ok(!U.newer('1.7.3', '1.7.4'));
  });
  await check('what’s new: only that part, as plain text', () => {
    const body = "## What's new\n- **Mark a title card** yourself ([how](https://example.com))\n  continued\n\n## Shelf for Windows\nDownload it.";
    assert.strictEqual(U.whatsNew(body), '- Mark a title card yourself (how)\n  continued');
    assert.strictEqual(U.whatsNew('no notes'), '');
  });
  await check('which file: installer, portable, or the page', () => {
    assert.strictEqual(U.installKind('win32', {}), 'setup');
    assert.strictEqual(U.installKind('win32', { PORTABLE_EXECUTABLE_FILE: 'C:\\x\\Shelf.exe' }), 'portable');
    assert.strictEqual(U.installKind('darwin', {}), 'page');
  });
  const rel = (assets) => ({ tag_name: 'v1.8.0', published_at: '2026-10-12T00:00:00Z', body: "## What's new\n- Updates", assets });
  const ok = { name: 'Shelf-Setup-1.8.0.exe', size: 10, digest: 'sha256:' + 'a'.repeat(64), browser_download_url: 'https://github.com/Groot36-yep/shelf/releases/download/v1.8.0/Shelf-Setup-1.8.0.exe' };
  const fakeFetch = (data) => async () => ({ ok: true, status: 200, json: async () => data });
  await check('offers only a Shelf release file with a fingerprint', async () => {
    let r = await U.check(fakeFetch(rel([ok])), '1.7.4', 'setup');
    assert.deepStrictEqual([r.newer, r.version, r.asset && r.asset.name, r.notes], [true, '1.8.0', 'Shelf-Setup-1.8.0.exe', '- Updates']);
    r = await U.check(fakeFetch(rel([Object.assign({}, ok, { digest: null })])), '1.7.4', 'setup');
    assert.strictEqual(r.asset, null, 'no fingerprint, no install');
    r = await U.check(fakeFetch(rel([Object.assign({}, ok, { browser_download_url: 'https://evil.example/Shelf-Setup-1.8.0.exe' })])), '1.7.4', 'setup');
    assert.strictEqual(r.asset, null, 'only from Shelf’s own releases');
    r = await U.check(fakeFetch(rel([ok])), '1.7.4', 'portable');
    assert.strictEqual(r.asset, null, 'portable copies get the portable file');
  });
  await check('download refuses anything but Shelf’s releases', async () => {
    await assert.rejects(U.download(async () => { throw new Error('should not fetch'); }, { name: 'x.exe', url: 'https://evil.example/x.exe', sha256: 'a' }, '/tmp'), /Not a Shelf release file/);
  });
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
