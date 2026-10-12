// A real OpenSSH server for tests (Linux, as root). Each run gets its own user, port and host key.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const available = () => process.platform === 'linux' && process.getuid && process.getuid() === 0 && fs.existsSync('/usr/sbin/sshd');

async function start(user) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-sshd-'));
  const pass = 'Popcorn-' + crypto.randomBytes(4).toString('hex');
  try { execFileSync('id', [user], { stdio: 'ignore' }); } catch (e) { execFileSync('useradd', ['-m', '-s', '/bin/bash', user]); }
  execFileSync('chpasswd', { input: user + ':' + pass + '\n' });
  const home = '/home/' + user;
  fs.rmSync(path.join(home, '.ssh'), { recursive: true, force: true });
  const media = path.join(home, 'media');
  fs.rmSync(media, { recursive: true, force: true });
  fs.mkdirSync(path.join(media, 'Movies'), { recursive: true }); fs.mkdirSync(path.join(media, 'TV Shows'), { recursive: true });
  execFileSync('chown', ['-R', user, media]);
  fs.mkdirSync('/run/sshd', { recursive: true });
  const port = 23000 + Math.floor(Math.random() * 2000);
  let proc = null, log = '';
  const s = { user, pass, port, home, media, tmp, fp: '', get log() { return log; } };
  function newKey() {
    fs.rmSync(path.join(tmp, 'host'), { force: true }); fs.rmSync(path.join(tmp, 'host.pub'), { force: true });
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(tmp, 'host')]);
    s.fp = execFileSync('ssh-keygen', ['-lf', path.join(tmp, 'host.pub')]).toString().split(' ')[1];
  }
  async function run() {
    fs.writeFileSync(path.join(tmp, 'cfg'), ['Port ' + port, 'ListenAddress 127.0.0.1', 'HostKey ' + path.join(tmp, 'host'), 'PasswordAuthentication yes',
      'KbdInteractiveAuthentication no', 'UsePAM yes', 'PidFile ' + path.join(tmp, 'pid'), 'Subsystem sftp internal-sftp', 'AllowUsers ' + user, 'LogLevel VERBOSE'].join('\n') + '\n');
    proc = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', path.join(tmp, 'cfg')], { stdio: ['ignore', 'ignore', 'pipe'] });
    proc.stderr.on('data', (d) => { log += d; });
    await new Promise((r) => setTimeout(r, 600));
  }
  function stopNow() {
    if (proc) { proc.kill(); proc.stderr.destroy(); proc = null; }
    try { execFileSync('pkill', ['-f', 'sshd: ' + user], { stdio: 'ignore' }); } catch (e) { /* none open */ } // open connections too
  }
  s.stop = () => { stopNow(); fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(media, { recursive: true, force: true }); };
  // The server "was reinstalled": a new host key.
  s.rekey = async () => { stopNow(); newKey(); await new Promise((r) => setTimeout(r, 300)); await run(); };
  s.authorizedKeys = () => { try { return fs.readFileSync(path.join(home, '.ssh', 'authorized_keys'), 'utf8'); } catch (e) { return ''; } };
  newKey();
  await run();
  return s;
}

module.exports = { start, available };
