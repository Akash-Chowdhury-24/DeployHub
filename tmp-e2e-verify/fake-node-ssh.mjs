/** Minimal NodeSSH stand-in for real provider code paths (no remote infra). */
export class NodeSSH {
  constructor() {
    this._host = null;
  }
  async connect(opts = {}) {
    this._host = opts.host || 'mock-host';
    console.log(`[mock-ssh] connect ${opts.username || 'user'}@${this._host}:${opts.port || 22}`);
    return this;
  }
  async putFile(local, remote) {
    console.log(`[mock-ssh] putFile ${local} -> ${remote}`);
  }
  async putDirectory() {}
  async execCommand(cmd) {
    const c = String(cmd);
    console.log(`[mock-ssh] exec: ${c.slice(0, 200)}`);
    // remoteFileExists: `test -f ... && echo yes` — return non-yes so nginx is skipped
    if (/\btest -f\b/.test(c)) {
      return { code: 1, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: 'ok', stderr: '' };
  }
  dispose() {
    console.log(`[mock-ssh] dispose ${this._host || ''}`);
  }
}

export default { NodeSSH };
