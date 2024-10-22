/*eslint-disable no-undef */
/*eslint-disable no-inner-declarations */
const {Keypair, Asset: StellarAsset} = require('@stellar/stellar-sdk')
const Client = require('../../src/dao')
const {parseSorobanResult} = require('../../src/xdr-values-helper')
const {init, deployAsset, installContract, deployContract, createAccount, setTrust, getAccount, mint, updateToMultiSigAccount, submitTx} = require('../test-utils')
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

/**
 * @type {{client: Client}}
 */
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

        config.updateContractWasmHash = await installContract('./test/dao/reflector_dao_contract.wasm', config.admin.secret())
        config.contractId = await deployContract(config.updateContractWasmHash, config.admin.secret())

        config.adminAccount = await getAccount(config.admin.publicKey())

        await createAccount(config.clientKp.publicKey())

        config.clientAccount = await getAccount(config.clientKp.publicKey())

        const tokenAsset = new StellarAsset(assetCode, config.admin.publicKey())
        await setTrust(config.clientAccount, tokenAsset, config.clientKp)

        await mint(tokenAsset, config.clientKp.publicKey(), '1000000', config.adminAccount, config.admin)

        config.developer = Keypair.random()
        await createAccount(config.developer.publicKey())
        config.developerAccount = await getAccount(config.developer.publicKey())
        await setTrust(config.developerAccount, tokenAsset, config.developer)
        config.developerAccount = await getAccount(config.developer.publicKey())

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
            updateContractWasmHash: config.updateContractWasmHash,
            developer: config.developer.secret()
        })
    } else {
        config.admin = Keypair.fromSecret(config.admin)
        config.updatesAdmin = Keypair.fromSecret(config.updatesAdmin)
        config.clientKp = Keypair.fromSecret(config.clientKp)
        config.nodes = config.nodes.map(k => Keypair.fromSecret(k))

        config.adminAccount = await getAccount(config.admin.publicKey())
        config.updatesAdminAccount = await getAccount(config.updatesAdmin.publicKey())
        config.clientAccount = await getAccount(config.clientKp.publicKey())

        config.developer = Keypair.fromSecret(config.developer)
        config.developerAccount = await getAccount(config.developer.publicKey())
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
            amount: 100000000000,
            depositParams: {
                "0": 100000,
                "1": 10000000,
                "2": 10000,
                "3": 10000000
            },
            //start date is now minus 2 weeks
            startDate: Math.floor((Date.now() - 1209600000) / 1000)
        }, txOptions),
        config.nodes,
        response => {
            expect(response.status).toBe('SUCCESS')
            config.adminAccount.incrementSequenceNumber()
        })
}, 300000)


test('setDeposit', async () => {
    //normalize to 1 minute and add 60 seconds
    txOptions.timebounds.maxTime = getNormalizedMaxDate(30000, 15000)
    await submitTx(
        config.client.setDeposit(config.adminAccount, {
            admin: config.admin.publicKey(),
            depositParams: {
                "0": 100000,
                "1": 10000001,
                "2": 10002,
                "3": 10000003
            }
        }, txOptions),
        config.nodes,
        response => {
            expect(response.status).toBe('SUCCESS')
            config.adminAccount.incrementSequenceNumber()
        })
}, 300000)


test('unlock', async () => {
    //normalize to 1 minute and add 60 seconds
    txOptions.timebounds.maxTime = getNormalizedMaxDate(30000, 15000)
    await submitTx(
        config.client.unlock(config.adminAccount, {
            admin: config.admin.publicKey(),
            developer: config.developer.publicKey(),
            operators: config.nodes.map(k => k.publicKey())
        }, txOptions),
        config.nodes,
        response => {
            expect(response.status).toBe('SUCCESS')
            config.adminAccount.incrementSequenceNumber()
        })
}, 300000)

test('available', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(30000, 15000)
    await submitTx(
        config.client.available(config.developerAccount, config.developer.publicKey(), txOptions),
        [config.developer],
        response => {
            const available = parseSorobanResult(response.resultMetaXdr)
            expect(available).toBeGreaterThan(0)
            config.developerAccount.incrementSequenceNumber()
        })
}, 300000)

test('claim', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(30000, 15000)
    await submitTx(
        config.client.claim(config.developerAccount,
            {
                claimant: config.developer.publicKey(),
                to: config.developer.publicKey(),
                amount: 60000000n
            }, txOptions),
        [config.developer],
        response => {
            expect(response.status).toBe('SUCCESS')
            config.developerAccount.incrementSequenceNumber()
        })
}, 300000)

test('createBallot', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(30000, 15000)
    await submitTx(
        config.client.createBallot(config.clientAccount, {
            title: 'Test ballot',
            description: 'Test ballot description',
            category: '0'
        }, txOptions),
        [config.clientKp],
        response => {
            const ballotId = parseSorobanResult(response.resultMetaXdr)
            expect(ballotId).toBe(1n)
            config.clientAccount.incrementSequenceNumber()
        })
}, 300000)

test('getBallot', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(30000, 15000)
    await submitTx(
        config.client.getBallot(config.clientAccount, '1', txOptions),
        [config.clientKp],
        response => {
            const ballot = parseSorobanResult(response.resultMetaXdr)
            expect(ballot.title).toBe('Test ballot')
            config.clientAccount.incrementSequenceNumber()
        })
}, 300000)

test('vote', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(30000, 15000)
    await submitTx(
        config.client.vote(config.adminAccount,
            {
                admin: config.admin.publicKey(),
                ballotId: 1n,
                accepted: false
            }, txOptions),
        config.nodes,
        response => {
            expect(response.status).toBe('SUCCESS')
            config.adminAccount.incrementSequenceNumber()
        })
}, 300000)

test('retractBallot', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(30000, 15000)
    await submitTx(
        config.client.retractBallot(config.clientAccount, '1', txOptions),
        [config.clientKp],
        response => {
            expect(response.status).toBe('SUCCESS')
            config.clientAccount.incrementSequenceNumber()
        })
}, 300000)