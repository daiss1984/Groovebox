import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

const pythonServer = String.raw`
import sys
from impacket.ntlm import compute_lmhash, compute_nthash
from impacket.smbserver import SimpleSMBServer
server = SimpleSMBServer(listenAddress='127.0.0.1', listenPort=0)
server.setSMB2Support(True)
server.addShare('MUSIC', sys.argv[1], 'private fixture', readOnly='yes')
server.addCredential('fixture', 0, compute_lmhash('demo-pass').hex(), compute_nthash('demo-pass').hex())
print(server.getServer().server_address[1], flush=True)
server.start()
`;

export function launchSmb2(python, root) {
  const server = spawn(python, ['-I', '-c', pythonServer, root], { stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostic = '';
  server.stderr.setEncoding('utf8').on('data', data => { diagnostic = (diagnostic + data).slice(-1000); });
  const lines = createInterface({ input: server.stdout });
  const closed = once(server, 'close');
  const input = Promise.race([
    once(lines, 'line').then(([port]) => ({ url: 'smb://127.0.0.1:' + port + '/MUSIC', username: 'fixture', password: 'demo-pass' })),
    closed.then(() => { throw new Error('SMB2 fixture failed to start. ' + diagnostic); }),
  ]);
  return {
    input,
    async stop() {
      if (server.exitCode === null && server.signalCode === null) server.kill();
      await closed;
    },
  };
}
