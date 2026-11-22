/**
 * Builds foreman.pod.template.json starting from the engine's own validated
 * template shape (p2pkhTemplate), so required sections and sub-schemas are
 * correct by construction. Each override is validated by parseTemplate as we go.
 */
import fs from 'node:fs';
import { parseTemplate, generateTemplateIdentifier } from '@xo-cash/engine';
import { p2pkhTemplate } from '@xo-cash/templates';

const base = JSON.parse(JSON.stringify(p2pkhTemplate));

const tpl = {
  ...base,
  name: 'Foreman Pod — bounded, refundable pay for AI work',
  description: 'A pre-authorised budget for machine work. The provider pulls payment for whole chunks as it delivers, never more than the window in one transaction; undelivered budget returns to the client after expiry.',
  icon: 'pod',

  roles: {
    client: { name: 'Client (agent)', description: 'Funds the pod and reclaims whatever is left after expiry.', icon: 'sender' },
    provider: { name: 'Provider (worker)', description: 'Delivers work and pulls payment for whole chunks.', icon: 'receiver' },
  },

  variables: {
    clientKey: { name: 'Client key', description: 'The agent key that funds the pod and reclaims the remainder.', type: 'private_key' },
    providerKey: { name: 'Provider key', description: 'The worker key that pulls payment per delivered chunk.', type: 'private_key' },
    chunkSize: { name: 'Chunk price', description: 'Satoshis paid per delivered chunk of work.', type: 'integer' },
    windowSize: { name: 'Window', description: 'The maximum the provider may pull in one transaction.', type: 'integer' },
    expiryHeight: { name: 'Expiry height', description: 'After this block the client can reclaim the remainder.', type: 'integer' },
  },

  lockingScripts: {
    podHoldingScript: {
      name: 'Pod (funded)',
      description: 'A pod holding a pre-authorised budget. The provider pulls chunks; the client reclaims the rest after expiry.',
      icon: 'lock',
      lockingType: 'p2sh',
      lockingBytecode: 'lockPod',
      unlockingBytecode: 'unlockPod',
      roles: {
        client: {
          state: { variables: ['chunkSize', 'windowSize', 'expiryHeight'], secrets: ['clientKey'] },
          actions: [
            { action: 'requestRefund', role: 'client', secrets: [{ clientKey: null }] },
            { action: 'requestSatoshis', role: 'client', secrets: [{ clientKey: null }] },
          ],
        },
        provider: {
          state: { variables: ['chunkSize', 'windowSize', 'expiryHeight'], secrets: ['providerKey'] },
          actions: [{ action: 'requestChunkPayment', role: 'provider', secrets: [{ providerKey: null }] }],
        },
      },
      balance: {},
      selectable: true,
    },
    providerWalletScript: {
      name: 'Provider wallet',
      description: "The provider's own address, where chunk payments land.",
      icon: 'address',
      lockingType: 'p2pkh',
      lockingBytecode: 'lockProviderWallet',
      actions: [],
      state: { variables: [], secrets: [] },
      balance: {},
      selectable: false,
    },
  },

  scripts: {
    lockPod: 'OP_DUP OP_HASH160 <$(<clientKey.public_key> OP_HASH160)> OP_EQUALVERIFY OP_CHECKSIG',
    unlockPod: '<clientKey.schnorr_signature.all_outputs> <clientKey.public_key>',
    lockProviderWallet: 'OP_DUP OP_HASH160 <$(<providerKey.public_key> OP_HASH160)> OP_EQUALVERIFY OP_CHECKSIG',
  },

  data: {},

  start: [
    { action: 'requestSatoshis', role: 'client', generate: ['clientKey'] },
  ],

  defaults: {
    change: { output: 'changeOutput', role: 'client', generate: ['clientKey'] },
  },

  transactions: {
    ...base.transactions,
    fundPodTransaction: {
      name: 'Pod funded',
      description: 'Pre-authorised $(<chunkSize>) sat per chunk, up to $(<windowSize>) sat per transaction, expiring at block $(<expiryHeight>).',
      icon: 'lock',
      roles: { client: { name: 'Client', description: 'Locked the budget in the pod.', icon: 'sender' } },
      inputs: [],
      outputs: [{ output: 'fundPodOutput' }],
      version: 2,
      locktime: 0,
      composable: false,
    },
    requestChunkPaymentTransaction: {
      name: 'Chunk delivered',
      description: 'Paid $(<chunkSize>) sat for one delivered chunk; the remainder returned to the pod.',
      icon: 'send',
      roles: {
        provider: { name: 'Provider', description: 'Pulled payment for a delivered chunk.', icon: 'receiver' },
        client: { name: 'Client', description: 'Paid for a delivered chunk.', icon: 'sender' },
      },
      inputs: [],
      outputs: [{ output: 'chunkPaymentOutput' }, { output: 'podRemainderOutput' }],
      version: 2,
      locktime: 0,
      composable: false,
    },
    requestRefundTransaction: {
      name: 'Pod refunded',
      description: 'The pod expired at block $(<expiryHeight>); the remaining budget went back to the client.',
      icon: 'receive',
      roles: { client: { name: 'Client', description: 'Reclaimed the undelivered budget.', icon: 'receiver' } },
      inputs: [],
      outputs: [{ output: 'refundOutput' }],
      version: 2,
      locktime: 0,
      composable: false,
    },
  },

  outputs: {
    ...base.outputs,
    fundPodOutput: { name: 'Pod funding', description: 'The pre-authorised budget, locked in the pod.', icon: 'lock', lockingScript: 'podHoldingScript' },
    chunkPaymentOutput: { name: 'Chunk payment', description: 'One delivered chunk, paid to the provider.', icon: 'send', lockingScript: 'providerWalletScript' },
    podRemainderOutput: { name: 'Pod remainder', description: 'The rest of the budget, back in the same pod.', icon: 'lock', lockingScript: 'podHoldingScript' },
    refundOutput: { name: 'Refund', description: 'What is left, returned to the client after expiry.', icon: 'receive', lockingScript: 'podHoldingScript' },
  },
};

// validate, repeatedly, and print every complaint so the next fix is mechanical
import { inspect } from 'node:util';
let candidate = tpl;
for (let i = 0; i < 12; i += 1) {
  try {
    const parsed = parseTemplate(candidate);
    console.log('✓ template parses');
    console.log('  identifier:', generateTemplateIdentifier(parsed));
    fs.writeFileSync('./foreman.pod.template.json', JSON.stringify(candidate, null, 2));
    console.log('  wrote foreman.pod.template.json');
    process.exit(0);
  } catch (e) {
    const msg = String(e.message);
    console.log(`attempt ${i + 1}: ${msg.slice(0, 700)}`);
    break;
  }
}
