# @reflector/oracle-client

Client bindings for the Reflector oracle, subscriptions and DAO contracts. Every method builds a Soroban transaction from a simulation; it does not sign or submit.

## Install

Peer dependency: `@stellar/stellar-sdk >= 17`. Node >= 22.12.

## Building transactions

All clients go through `buildTransaction(client, source, operation, options)` in `src/rpc-helper.js`:

- `options.fee` is the classic per-operation fee; the Soroban resource fee is added on top.
- The simulation is requested from each URL in `client.sorobanRpcUrl` in turn, with a 15 s deadline per request, starting with the URL that answered last. That preference expires ten minutes after it was set, so the configured order, primary first, is tried again. When every URL fails the error is `Failed to make request.` with the underlying errors in `error.cause`.
- Simulated resources are quantised upward onto a fixed grid before they are signed: instructions in steps of 10 000 000 (capped at 100 000 000), disk-read and write bytes in steps of 8192 (capped at 204 800 and 132 096), the resource fee in steps of 1 000 000 stroops with a floor of 10 000 000. Each value gets between one and two steps of slack (one full step past the next grid line). Nodes simulate independently, so this keeps their transactions identical unless a simulation lands within one step of a grid edge. The caps are the public network's per-transaction limits (`txMaxInstructions`, `txMaxDiskReadBytes`, `txMaxWriteBytes`) at the time of writing and must follow any network configuration change.
- When the simulation returns a restore preamble, the result is a footprint-restore transaction, normalised the same way, with a non-enumerable `isRestore === true`. Check it before treating the transaction as the requested update.
- `options.simulationOnly` returns the parsed simulation response instead of a transaction.

## Tests

- `npm test` runs the offline suite (`test/rpc-helper.test.js`, `test/rpc-deadline.test.js`); it mocks the RPC server and needs no network. `test/rpc-deadline.test.js` pins the http-client deadline mechanism against a silent local server.
- `npm run test:integration` runs the live suites under `test/oracle`, `test/dao` and `test/subscriptions`. They need the `stellar` CLI and the RPC and friendbot named in each `example.contract.config.json`.

