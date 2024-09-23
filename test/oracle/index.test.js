/*eslint-disable no-undef*/
/*eslint-disable no-inner-declarations */
const crypto = require('crypto')
const {Keypair, xdr, StrKey, Asset: StellarAsset, hash} = require('@stellar/stellar-sdk')
const Client = require('../../src/oracle')
const AssetType = require('../../src/asset-type')
const {parseSorobanResult} = require('../../src/xdr-values-helper')
const {init, createAccount, deployContract, installContract, getAccount, updateToMultiSigAccount, submitTx} = require('../test-utils')
const contractConfig = require('./example.contract.config.json')

if (contractConfig.assets.length < 2)
    throw new Error('Need at least 2 assets to run tests')

init(contractConfig.sorobanRpcUrl, contractConfig.network, contractConfig.friendbotUrl)

contractConfig.assets = contractConfig.assets.map(a => tryEncodeAssetContractId(a, contractConfig.network))
contractConfig.baseAsset = tryEncodeAssetContractId(contractConfig.baseAsset, contractConfig.network)

const initAssetLength = 1

const extraAsset = {type: AssetType.Other, code: 'JPY'}

const assetToString = (asset) => !asset ? 'null' : `${asset[0]}:${asset[1]}`

const priceToString = (price) => !price ? 'null' : `{price: ${price.price.toString()}, timestamp: ${price.timestamp.toString()}}`

function isValidContractId(contractId) {
    try {
        if (!contractId)
            return false
        StrKey.decodeContract(contractId)
        return true
    } catch (e) {
        return false
    }
}

function tryEncodeAssetContractId(asset) {
    let stellarAsset = null
    switch (asset.type) {
        case 1: {
            const splittedCode = asset.code.split(':')
            if (splittedCode.length === 2) {
                const [assetCode, issuer] = splittedCode
                if (!assetCode || !issuer)
                    throw new Error('Asset code and issuer must be defined')
                if (!StrKey.isValidEd25519PublicKey(issuer))
                    new Error('Asset issuer must be a valid ed25519 public key')
                stellarAsset = new StellarAsset(assetCode, issuer)
            } else if (asset.code === 'XLM') {
                stellarAsset = StellarAsset.native()
            } else {
                this.isContractId = isValidContractId(asset.code)
                if (!this.isContractId)
                    new Error(`Asset code ${asset.code} is invalid`)
                return asset
            }
        }
            break
        case 2:
            if (asset.code.length > 32)
                new Error('Asset code must be 32 characters or less')
            return asset
        default:
            throw new Error(`Asset type ${asset.type} is not supported`)
    }
    const assetContractId = new xdr.HashIdPreimageContractId({
        networkId: hash(Buffer.from(contractConfig.network)),
        contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAsset(stellarAsset.toXDRObject())
    })
    const preimage = xdr.HashIdPreimage.envelopeTypeContractId(assetContractId)
    return {type: 1, code: StrKey.encodeContract(hash(preimage.toXDR()))}
}

function normalize_timestamp(timestamp, timeframe) {
    timeframe = timeframe || contractConfig.resolution
    return Math.floor(timestamp / timeframe) * timeframe
}

function getNormalizedMaxDate(timeout, timeframe) {
    const maxDate = new Date(normalize_timestamp(Date.now(), timeframe) + timeout)
    console.log(`Max date: ${maxDate.toISOString()}, Current date: ${new Date().toISOString()}, Diff: ${maxDate - new Date()}, Timeout: ${timeout}, Timeframe: ${timeframe}`)
    return maxDate
}

const MAX_I128 = BigInt('170141183460469231731687303715884105727')
const ADJUSTED_MAX = MAX_I128 / (10n ** BigInt(contractConfig.decimals)) //divide by 10^14
let lastTimestamp = null
let currentPriceTimestamp = null

function initTimestamps() {
    lastTimestamp = currentPriceTimestamp = normalize_timestamp(Date.now())
}

let period = contractConfig.resolution * 10

const config = {}
async function prepare() {
    if (!config.admin) {
        config.admin = Keypair.random()
        config.nodes = Array.from({length: 5}, () => (Keypair.random()))

        await createAccount(config.admin.publicKey())
        config.updateContractWasmHash = await installContract('./test/oracle/reflector_oracle.wasm', config.admin.secret())
        config.contractId = await deployContract(config.updateContractWasmHash, config.admin.secret())

        config.adminAccount = await getAccount(config.admin.publicKey())

        const nodePubkeys = config.nodes.map(k => k.publicKey())
        await updateToMultiSigAccount(config.adminAccount, config.admin, nodePubkeys)

        config.updatesAdmin = Keypair.random()

        await createAccount(config.updatesAdmin.publicKey())

        config.updatesAdminAccount = await getAccount(config.updatesAdmin.publicKey())

        await updateToMultiSigAccount(config.updatesAdminAccount, config.updatesAdmin, nodePubkeys)


        //console all created account secrets and contracts ids
        console.log({
            admin: config.admin.secret(),
            updatesAdmin: config.updatesAdmin.secret(),
            nodes: config.nodes.map(k => k.secret()),
            contractId: config.contractId,
            updateContractWasmHash: config.updateContractWasmHash
        })
    } else {
        config.admin = Keypair.fromSecret(config.admin)
        config.nodes = config.nodes.map(k => Keypair.fromSecret(k))
        config.updatesAdmin = Keypair.fromSecret(config.updatesAdmin)
        config.adminAccount = await getAccount(config.admin.publicKey())
        config.updatesAdminAccount = await getAccount(config.updatesAdmin.publicKey())
    }

    config.client = new Client(contractConfig.network, [contractConfig.sorobanRpcUrl], config.contractId)
}

function generateRandomI128() {
    //Generate a random 128-bit number
    const buffer = crypto.randomBytes(16) //Generate 16 random bytes = 128 bits
    const hex = buffer.toString('hex') //Convert to hexadecimal
    let randomNum = BigInt('0x' + hex) //Convert hex to BigInt

    const MAX_RANGE = 2n ** 128n

    randomNum = (randomNum * ADJUSTED_MAX) / MAX_RANGE

    return randomNum
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
            assets: contractConfig.assets.slice(0, initAssetLength),
            baseAsset: tryEncodeAssetContractId(contractConfig.baseAsset, contractConfig.network),
            decimals: contractConfig.decimals,
            resolution: contractConfig.resolution,
            period
        }, txOptions),
        config.nodes,
        response => {
            expect(response.status).toBe('SUCCESS')
            config.adminAccount.incrementSequenceNumber()
        })
}, 300000)

test('version', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
    await submitTx(
        config.client.version(config.adminAccount, txOptions),
        config.nodes,
        response => {
            const version = parseSorobanResult(response.resultMetaXdr)
            expect(version).toBeGreaterThan(0)
            config.adminAccount.incrementSequenceNumber()
            return `Version: ${version}`
        })
}, 300000)

test('add_assets', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(30000, 15000)
    await submitTx(
        config.client.addAssets(config.updatesAdminAccount, {
            admin: config.admin.publicKey(),
            assets: contractConfig.assets.slice(initAssetLength)
        }, txOptions),
        config.nodes,
        response => {
            expect(response.status).toBe('SUCCESS')
            config.updatesAdminAccount.incrementSequenceNumber()
        })
}, 300000)

test('set_period', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(30000, 15000)
    period += contractConfig.resolution
    await submitTx(
        config.client.setPeriod(config.updatesAdminAccount, {
            admin: config.admin.publicKey(),
            period
        }, txOptions), config.nodes, response => {
            expect(response.status).toBe('SUCCESS')
            config.updatesAdminAccount.incrementSequenceNumber()
        })

    await submitTx(
        config.client.period(config.adminAccount, txOptions),
        config.nodes,
        response => {
            const newPeriod = parseSorobanResult(response.resultMetaXdr)
            expect(newPeriod).toBe(BigInt(period / 1000))
            config.adminAccount.incrementSequenceNumber()
        })
}, 300000)

test('set_price (extra price)', async () => {
    contractConfig.assets.push(extraAsset)
    const prices = Array.from({length: contractConfig.assets.length}, () => generateRandomI128())
    initTimestamps()
    //30 seconds timeout + 15 seconds for DB delay
    txOptions.timebounds.maxTime = getNormalizedMaxDate(30000, 15000)
    await submitTx(
        config.client.setPrice(
            config.adminAccount,
            {admin: config.admin.publicKey(), prices, timestamp: currentPriceTimestamp},
            txOptions
        ),
        config.nodes,
        response => {
            expect(response.status).toBe('SUCCESS')
            config.adminAccount.incrementSequenceNumber()
        })
    currentPriceTimestamp -= contractConfig.resolution
}, 300000)

test('set_price', async () => {
    const prices = Array.from({length: contractConfig.assets.length}, () => generateRandomI128())

    txOptions.timebounds.maxTime = getNormalizedMaxDate(30000, 15000)
    await submitTx(
        config.client.setPrice(
            config.adminAccount,
            {admin: config.admin.publicKey(), prices, timestamp: currentPriceTimestamp},
            txOptions
        ),
        config.nodes,
        response => {
            expect(response.status).toBe('SUCCESS')
            config.adminAccount.incrementSequenceNumber()
        })
    currentPriceTimestamp -= contractConfig.resolution
}, 300000)

test('twap', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
    await submitTx(
        config.client.twap(config.adminAccount, contractConfig.assets[0], 2, txOptions),
        config.nodes,
        response => {
            const twap = parseSorobanResult(response.resultMetaXdr)
            expect(twap > 0n).toBe(true)
            config.adminAccount.incrementSequenceNumber()
            return `Twap: ${twap.toString()}`
        })
}, 300000)

test('x_twap', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
    await submitTx(
        config.client.xTwap(config.adminAccount, contractConfig.assets[0], contractConfig.assets[1], 2, txOptions),
        config.nodes,
        response => {
            const twap = parseSorobanResult(response.resultMetaXdr)
            expect(twap > 0n).toBe(true)
            config.adminAccount.incrementSequenceNumber()
            return `Twap: ${twap.toString()}`
        })
}, 300000)

test('lastprice', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
    await submitTx(
        config.client.lastPrice(config.adminAccount, contractConfig.assets[0], txOptions),
        config.nodes,
        response => {
            const price = parseSorobanResult(response.resultMetaXdr)
            expect(price.price).toBeGreaterThan(0n)
            config.adminAccount.incrementSequenceNumber()
            return `Price: ${priceToString(price)}`
        })
}, 300000)

test('x_lt_price', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
    await submitTx(
        config.client.xLastPrice(config.adminAccount, contractConfig.assets[0], contractConfig.assets[1], txOptions),
        config.nodes,
        response => {
            const price = parseSorobanResult(response.resultMetaXdr)
            expect(price.price).toBeGreaterThan(0n)
            config.adminAccount.incrementSequenceNumber()
            return `Price: ${priceToString(price)}`
        })
}, 300000)

test('price', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
    await submitTx(
        config.client.price(config.adminAccount, contractConfig.assets[1], lastTimestamp / 1000, txOptions),
        config.nodes,
        response => {
            const price = parseSorobanResult(response.resultMetaXdr)
            expect(price.price).toBeGreaterThan(0n)
            config.adminAccount.incrementSequenceNumber()
            return `Price: ${priceToString(price)}`
        })
}, 300000)


test('price (non existing)', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
    await submitTx(
        config.client.price(config.adminAccount, contractConfig.assets[1], 10000000000, txOptions),
        config.nodes,
        response => {
            const price = parseSorobanResult(response.resultMetaXdr)
            expect(price).toBe(null)
            config.adminAccount.incrementSequenceNumber()
        })
}, 300000)

test('x_price', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
    await submitTx(
        config.client.xPrice(config.adminAccount, contractConfig.assets[0], contractConfig.assets[1], lastTimestamp / 1000, txOptions),
        config.nodes,
        response => {
            const price = parseSorobanResult(response.resultMetaXdr)
            expect(price.price).toBeGreaterThan(0n)
            config.adminAccount.incrementSequenceNumber()
            return `Price: ${priceToString(price)}`
        })
}, 300000)

test('prices', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
    await submitTx(
        config.client.prices(config.adminAccount, contractConfig.assets[0], 2, txOptions),
        config.nodes,
        response => {
            const prices = parseSorobanResult(response.resultMetaXdr)
            expect(prices.length > 0).toBe(true)
            config.adminAccount.incrementSequenceNumber()
            return `Prices: ${prices.map(p => priceToString(p)).join(', ')}`
        })
}, 300000)

test('x_prices', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
    await submitTx(
        config.client.xPrices(config.adminAccount, contractConfig.assets[0], contractConfig.assets[1], 2, txOptions),
        config.nodes,
        response => {
            const prices = parseSorobanResult(response.resultMetaXdr)
            expect(prices.length > 0).toBe(true)
            config.adminAccount.incrementSequenceNumber()
            return `Prices: ${prices.map(p => priceToString(p)).join(', ')}`
        })
}, 300000)

test('add_asset (extra asset)', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
    await submitTx(
        config.client.addAssets(config.updatesAdminAccount, {
            admin: config.admin.publicKey(),
            assets: [extraAsset]
        }, txOptions),
        config.nodes,
        response => {
            expect(response.status).toBe('SUCCESS')
            config.updatesAdminAccount.incrementSequenceNumber()
        })
}, 300000)

//TODO: add test for get_price for extra asset before adding it (must be null) and after adding it (must be valid price)

test('admin', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
    await submitTx(
        config.client.admin(config.adminAccount, txOptions),
        config.nodes,
        response => {
            const adminPublicKey = parseSorobanResult(response.resultMetaXdr)
            expect(config.admin.publicKey()).toBe(adminPublicKey)
            config.adminAccount.incrementSequenceNumber()
            return `Admin: ${adminPublicKey}`
        })
}, 3000000)

test('base', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
    await submitTx(
        config.client.base(config.adminAccount, txOptions),
        config.nodes,
        response => {
            const base = parseSorobanResult(response.resultMetaXdr)
            expect(base).toBeDefined()
            config.adminAccount.incrementSequenceNumber()
            return `Base: ${assetToString(base)}`
        })
}, 3000000)


test('decimals', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
    await submitTx(
        config.client.decimals(config.adminAccount, txOptions),
        config.nodes,
        response => {
            const decimals = parseSorobanResult(response.resultMetaXdr)
            expect(decimals).toBe(contractConfig.decimals)
            config.adminAccount.incrementSequenceNumber()
            return `Decimals: ${decimals}`
        })
}, 300000)

test('resolution', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
    await submitTx(
        config.client.resolution(config.adminAccount, txOptions),
        config.nodes,
        response => {
            const resolution = parseSorobanResult(response.resultMetaXdr)
            expect(resolution).toBe(contractConfig.resolution / 1000) //in seconds
            config.adminAccount.incrementSequenceNumber()
            return `Resolution: ${resolution}`
        })
}, 300000)

test('period', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
    await submitTx(
        config.client.period(config.adminAccount, txOptions),
        config.nodes,
        response => {
            const periodValue = parseSorobanResult(response.resultMetaXdr)
            expect(periodValue).toBe(BigInt(period / 1000))
            config.adminAccount.incrementSequenceNumber()
            return `Period: ${periodValue}`
        })
}, 300000)

test('assets', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
    await submitTx(
        config.client.assets(config.adminAccount, txOptions),
        config.nodes,
        response => {
            const assets = parseSorobanResult(response.resultMetaXdr)
            expect(assets.length).toEqual(contractConfig.assets.length)
            config.adminAccount.incrementSequenceNumber()
            return `Assets: ${assets.map(a => assetToString(a)).join(', ')}`
        })
}, 300000)

test('lasttimestamp', async () => {
    txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
    await submitTx(
        config.client.lastTimestamp(config.adminAccount, txOptions),
        config.nodes,
        response => {
            const timestamp = parseSorobanResult(response.resultMetaXdr)
            expect(timestamp).toBeGreaterThan(0)
            expect(timestamp).toBeLessThanOrEqual(2147483647)
            config.adminAccount.incrementSequenceNumber()
            return `Timestamp: ${timestamp}`
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
            config.updatesAdminAccount.incrementSequenceNumber()
        })
}, 300000)