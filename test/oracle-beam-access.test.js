/*eslint-disable no-undef */
const {Address, Contract, Keypair, Networks, StrKey, nativeToScVal, xdr} = require('@stellar/stellar-sdk')

//the operation the client would simulate and prepare is what these tests compare
jest.mock('../src/rpc-helper', () => ({buildTransaction: (client, source, operation) => Promise.resolve(operation)}))

const {OracleClient} = require('../src')
const AssetType = require('../src/asset-type')

const contractId = StrKey.encodeContract(Buffer.alloc(32, 3))
const client = new OracleClient(Networks.TESTNET, ['http://localhost:8000'], contractId)
const sponsor = Keypair.random().publicKey()
const consumer = Keypair.random().publicKey()
const btc = {type: AssetType.Other, code: 'BTC'}
const otherAssetScVal = code => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Other'), xdr.ScVal.scvSymbol(code)])

describe('beam access', () => {
    test('track buys access to the assets for a consumer, paid by the sponsor', async () => {
        const operation = await client.track(null, {sponsor, consumer, assets: [btc, {type: AssetType.Other, code: 'ETH'}], amount: 1000n}, {})
        const expected = new Contract(contractId).call('track',
            new Address(sponsor).toScVal(),
            new Address(consumer).toScVal(),
            xdr.ScVal.scvVec([otherAssetScVal('BTC'), otherAssetScVal('ETH')]),
            nativeToScVal(1000n, {type: 'i128'}))
        expect(operation.toXDR('base64')).toBe(expected.toXDR('base64'))
    })

    test('trackedUntil reads when a consumer\'s access to each asset expires', async () => {
        const operation = await client.trackedUntil(null, consumer, [btc], {})
        const expected = new Contract(contractId).call('tracked_until',
            new Address(consumer).toScVal(),
            xdr.ScVal.scvVec([otherAssetScVal('BTC')]))
        expect(operation.toXDR('base64')).toBe(expected.toXDR('base64'))
    })

    test('the client has no invocation cost calls: no contract supports them', () => {
        expect(client.setInvocationCosts).toBeUndefined()
        expect(client.invocationCosts).toBeUndefined()
    })
})
