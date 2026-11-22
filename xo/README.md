# Foreman as an XO template

`foreman.pod.template.json` describes the Foreman pod as an XO wallet template: roles, variables,
locking scripts, and the three transactions (fund, pull a chunk, refund).

## Verified

```
✓ parseTemplate (the engine's own zod schema) accepts it
  templateIdentifier: 6bc7202420bc83f5c491b4f74026baeecf760679832dc95c0b97ad72ab296063
✓ scriptsForLibauthCompiler resolves all three scripts: lockPod, unlockPod, lockProviderWallet
✓ CashAssembly compiles every script (variables bind at runtime, as the engine intends)
```

## Path to a chipnet invitation (state, honestly)

`build-template.mjs` builds and validates the template; `verify.mjs` compiles the scripts through the
engine. What is **not** done here is the live invitation: `Engine.create()` hangs in this sandbox (it opens a
SQLite store plus its Electrum application and never resolves; 60–300 s with no output, on two Node versions).
The remaining steps are the ones in the XO getting-started guide, on a machine where the engine starts:

```js
const engine = await Engine.create(mnemonic, { network: 'chipnet' });
const { templateIdentifier } = await engine.importTemplate(template);   // uses the JSON in this folder
await engine.setDefaultPolicies({ change: { templateIdentifier }, receive: { templateIdentifier }, address: { templateIdentifier } });

// fund a receive address from https://tbch.googol.cash/ , then:
const stored = await engine.createInvitation({
  templateIdentifier,
  action: 'requestSatoshis',      // "Pod funded"
  role: 'client',
  generate: ['clientKey'],
});
// listMissingRequirements → appendInvitation({ variables }) → appendInvitation({ inputs })
// → listOwnInputIndexes → signInvitation → executeAction({ broadcastTransaction: true })
// then import the same template + invitation at https://blaze.xo.cash to inspect it.
```

That last line is the submission artefact the Build-with-XO bounty asks for: the invitation, inspectable in the
debug tool.
