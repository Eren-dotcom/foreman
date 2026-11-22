#!/usr/bin/env node
/**
 * tools/wallet-e2e.mjs — proves the wallet connector end to end, no phone needed.
 *
 *   node tools/wallet-e2e.mjs
 *
 * 1. opens a real WizardConnect relay session and prints the wiz:// URI
 * 2. runs the headless test wallet (tools/test-wallet-bot.mjs) against that URI
 * 3. builds a funding transaction for a fresh pod
 * 4. the wallet signs it over the relay (Foreman never holds the key)
 * 5. Foreman re-checks the signature and the payment locally, then broadcasts
 *
 * The coins come from the public chipnet faucet: `node tools/fund-bot.mjs 0`.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { WalletSession } from '../wallet.mjs';
import { buildWalletFund, verifySignedSpend, keyFromSeedHex, readPod } from '../lib.mjs';
import { ElectrumNetworkProvider, Network } from 'cashscript';

const seeds = JSON.parse(fs.readFileSync(new URL('../.secrets/server.json', import.meta.url), 'utf8'));
const client = keyFromSeedHex(seeds.client, 0);
const providerKey = keyFromSeedHex(seeds.provider, 0);
const height = await new ElectrumNetworkProvider(Network.CHIPNET).getBlockHeight();
const pod = {
  clientPkh: client.pkh, providerPkh: providerKey.pkh,
  chunk: 20000n, window: 60000n, validUntil: BigInt(height + 60),
};

const session = new WalletSession({ onLog: (m) => console.log('[dapp]', m) });
const uri = session.start();
console.log('\nscan this with a wallet, or let the test wallet below do it:');
console.log(`  ${uri}\n`);

const bot = spawn(process.execPath, [
  new URL('./test-wallet-bot.mjs', import.meta.url).pathname, uri,
], { env: { ...process.env, BOT_SECONDS: '120' }, stdio: ['ignore', 'pipe', 'pipe'] });
bot.stdout.on('data', (d) => process.stdout.write(String(d)));
bot.stderr.on('data', (d) => process.stderr.write('[bot-err] ' + String(d)));

for (let i = 0; i < 20 && !session.ready; i += 1) await new Promise((r) => setTimeout(r, 1000));
if (!session.ready) {
  console.log('wallet never paired — relay unreachable?');
  bot.kill('SIGKILL');
  process.exit(1);
}

const addresses = session.addresses('chipnet', 4).map((a) => a.address);
console.log('paired. the wallet will sign for:');
for (const a of addresses) console.log('  ' + a);

const fund = await buildWalletFund({
  pod, network: 'chipnet', funderAddresses: addresses, changeAddress: addresses[0], satoshis: 150000n,
});
console.log(`\nbuilt an unsigned funding tx: ${fund.spends.length} input(s), fee ${fund.fee} sat`);
console.log(`  pod output → ${fund.podAddress} (150000 sat)`);
console.log(`  change     → ${addresses[0]} (${fund.change} sat)`);

const signed = await session.sign({
  transaction: {
    transaction: fund.txHex,
    sourceOutputs: fund.relaySourceOutputs,
    broadcast: false,
    userPrompt: 'Authorise 150000 sat for a Foreman pod (chipnet)',
  },
  inputPaths: fund.inputPaths,
}, { timeoutMs: 90000 });
console.log(`\nthe wallet returned ${signed.signedTransaction.length / 2} bytes over the relay`);

const check = verifySignedSpend({
  txHex: signed.signedTransaction, pod, network: 'chipnet',
  expect: { sourceOutputs: fund.sourceOutputs, amount: 150000n },
});
console.log(`local check passed: signatures verify, pod output is exactly 150000 sat`);
console.log(`  txid ${check.txid}`);

const broadcast = await session.broadcast('chipnet', signed.signedTransaction);
console.log(`\nBROADCAST ${broadcast.txid}`);
console.log(`  ${broadcast.explorer}`);
console.log('  pod state:', JSON.stringify(await readPod(pod, 'chipnet')));

bot.kill('SIGKILL');
session.stop();
process.exit(0);
