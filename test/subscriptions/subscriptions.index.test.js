/*eslint-disable no-undef */
/*eslint-disable no-inner-declarations */
const {Keypair, StrKey, Asset: StellarAsset} = require('@stellar/stellar-sdk')
const Client = require('../../src/subscriptions')
const {parseNumberResult, parseAdminResult, getSorobanResultValue} = require('../../src/xdr-values-helper')
const {init, deployAsset, installContract, deployContract, createAccount, setTrust, getAccount, mint, updateToMultiSigAccount, getMajority, submitTx} = require('../test-utils')
const contractConfig = require('./example.contract.config.json')

init(contractConfig.sorobanRpcUrl, contractConfig.network, contractConfig.friendbotUrl)

function normalize_timestamp(timestamp, timeframe) {
    timeframe = timeframe || contractConfig.resolution
    return Math.floor(timestamp / timeframe) * timeframe
}

function getNormalizedMaxDate(timeout, timeframe) {
    const maxDate = new Date(normalize_timestamp(Date.now(), timeframe) + timeout)
    console.log(`Max date: ${maxDate.toISOString()}, Current date: ${new Date().toISOString()}, Diff: ${maxDate - new Date()}, Timeout: ${timeout}, Timeframe: ${timeframe}`)
    return maxDate
}

const config = {}
const assetCode = 'SBS'

async function prepare() {
    if (!config.admin) {
        config.admin = Keypair.random()
        config.clientKp = Keypair.random()
        config.nodes = Array.from({length: 5}, () => (Keypair.random()))

        const nodePubkeys = config.nodes.map(k => k.publicKey())

        await createAccount(config.admin.publicKey())
        config.token = await deployAsset(`${assetCode}:${config.admin.publicKey()}`, config.admin.secret())

        config.updateContractWasmHash = await installContract('./test/subscriptions/reflector_subscription.wasm', config.admin.secret())
        config.contractId = await deployContract(config.updateContractWasmHash, config.admin.secret())

        config.adminAccount = await getAccount(config.admin.publicKey())

        await createAccount(config.clientKp.publicKey())

        config.clientAccount = await getAccount(config.clientKp.publicKey())

        const tokenAsset = new StellarAsset(assetCode, config.admin.publicKey())
        await setTrust(config.clientAccount, tokenAsset, config.clientKp)

        await mint(tokenAsset, config.clientKp.publicKey(), '1000000', config.adminAccount, config.admin)

        await updateToMultiSigAccount(config.adminAccount, config.admin, nodePubkeys)

        config.updatesAdmin = Keypair.random()

        console.log(`Updates config.admin: ${config.updatesAdmin.secret()}`)

        await createAccount(config.updatesAdmin.publicKey())

        config.updatesAdminAccount = await getAccount(config.updatesAdmin.publicKey())

        await updateToMultiSigAccount(config.updatesAdminAccount, config.updatesAdmin, nodePubkeys)

        //console all created account secrets and contracts ids
        console.log({
            admin: config.admin.secret(),
            updatesAdmin: config.updatesAdmin.secret(),
            clientKp: config.clientKp.secret(),
            nodes: config.nodes.map(k => k.secret()),
            contractId: config.contractId,
            token: config.token,
            updateContractWasmHash: config.updateContractWasmHash
        })
    } else {
        config.admin = Keypair.fromSecret(config.admin)
        config.updatesAdmin = Keypair.fromSecret(config.updatesAdmin)
        config.clientKp = Keypair.fromSecret(config.clientKp)
        config.nodes = config.nodes.map(k => Keypair.fromSecret(k))

        config.adminAccount = await getAccount(config.admin.publicKey())
        config.updatesAdminAccount = await getAccount(config.updatesAdmin.publicKey())
        config.clientAccount = await getAccount(config.clientKp.publicKey())
    }

    config.client = new Client(contractConfig.network, [contractConfig.sorobanRpcUrl], config.contractId)
}

const txOptions = {
    fee: 10000000,
    timebounds: {
        minTime: 0,
        maxTime: 0
    }
}

beforeAll(async () => {
    await prepare()
}, 3000000)

test('config', async () => {
    //normalize to 1 minute and add 60 seconds
    txOptions.timebounds.maxTime = getNormalizedMaxDate(30000, 15000)
    await submitTx(
        config.client.config(config.adminAccount, {
            admin: config.admin.publicKey(),
            token: config.token,
            fee: 100
        }, txOptions),
        config.nodes,
        response => {
            expect(response.status).toBe('SUCCESS')
        })
}, 300000)

test('version', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
    await submitTx(
        config.client.version(config.adminAccount, txOptions),
        config.nodes,
        response => {
            expect(response.status).toBe('SUCCESS')
            const version = parseNumberResult(response.resultMetaXdr)
            expect(version).toBeDefined()
            return `Version: ${version}`
        })
}, 300000)

test('setFee', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(30000, 15000)
    await submitTx(
        config.client.setFee(config.updatesAdminAccount, {
            admin: config.admin.publicKey(),
            fee: 50
        }, txOptions),
        config.nodes,
        response => {
            expect(response.status).toBe('SUCCESS')
        })
}, 300000)

test('createSubscription', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(30000, 15000)
    await submitTx(
        config.client.createSubscription(config.clientAccount, {
            owner: config.clientKp.publicKey(),
            asset1: {asset: {type: 2, code: 'BTC'}, source: 'CD22G3I2V5PH6EFRWW3I3HKFPAQI3TRCH34QFR6HJTAYMFGJNVNPPEWD'},
            asset2: {asset: {type: 2, code: 'USD'}, source: 'CD22G3I2V5PH6EFRWW3I3HKFPAQI3TRCH34QFR6HJTAYMFGJNVNPPEWD'},
            threshold: 2,
            heartbeat: 60,
            webhook: 'http://localhost:3000',
            amount: 1000
        }, txOptions),
        [config.clientKp],
        response => {
            expect(response.status).toBe('SUCCESS')
            const id = parseNumberResult(response.resultMetaXdr)
            expect(id).toBe(1)
        })
}, 300000)

test('deposit', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(30000, 15000)
    await submitTx(
        config.client.deposit(config.clientAccount, {
            from: config.clientKp.publicKey(),
            subscriptionId: 1,
            amount: 100
        }, txOptions),
        [config.clientKp],
        response => {
            expect(response.status).toBe('SUCCESS')
        })
}, 300000)

test('charge', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(30000, 15000)
    await submitTx(
        config.client.charge(config.adminAccount, {
            admin: config.admin.publicKey(),
            ids: [1]
        }, txOptions),
        config.nodes,
        response => {
            expect(response.status).toBe('SUCCESS')
        })
}, 300000)

test('trigger', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(30000, 15000)
    await submitTx(
        config.client.trigger(config.adminAccount, {
            admin: config.admin.publicKey(),
            ids: [1],
            isHeartbeat: false
        }, txOptions),
        config.nodes,
        response => {
            expect(response.status).toBe('SUCCESS')
        })
}, 300000)

test('trigger(heartbeat)', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(30000, 15000)
    await submitTx(
        config.client.trigger(config.adminAccount, {
            admin: config.admin.publicKey(),
            ids: [1],
            isHeartbeat: true
        }, txOptions),
        config.nodes,
        response => {
            expect(response.status).toBe('SUCCESS')
        })
}, 300000)

test('admin', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
    await submitTx(
        config.client.admin(config.adminAccount, txOptions),
        config.nodes,
        response => {
            expect(response.status).toBe('SUCCESS')
            const adminPublicKey = parseAdminResult(response.resultMetaXdr)
            expect(config.admin.publicKey()).toBe(adminPublicKey)
            return `Admin: ${adminPublicKey}`
        })
}, 3000000)

test('getFee', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
    await submitTx(
        config.client.getFee(config.adminAccount, txOptions),
        config.nodes,
        response => {
            expect(response.status).toBe('SUCCESS')
            const fee = parseNumberResult(response.resultMetaXdr)
            expect(fee).toBeGreaterThan(0)
        })
}, 3000000)


test('getToken', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
    await submitTx(
        config.client.getToken(config.adminAccount, txOptions),
        config.nodes,
        response => {
            expect(response.status).toBe('SUCCESS')
            const token = StrKey.encodeContract(
                getSorobanResultValue(response.resultMetaXdr).value().contractId()
            )
            expect(config.token).toBe(token)
        })
}, 300000)

test('update_contract', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
    await submitTx(
        config.client.updateContract(config.updatesAdminAccount, {
            admin: config.admin.publicKey(),
            wasmHash: config.updateContractWasmHash
        }, txOptions),
        config.nodes,
        response => {
            expect(response.status).toBe('SUCCESS')
        })
}, 300000)