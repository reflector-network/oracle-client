/*eslint-disable no-undef*/
/*eslint-disable no-inner-declarations */
const crypto = require('crypto')
const {Keypair, xdr, StrKey, Asset: StellarAsset, hash, Asset} = require('@stellar/stellar-sdk')
const Client = require('../../src/oracle')
const AssetType = require('../../src/asset-type')
const {parseSorobanResult} = require('../../src/xdr-values-helper')
const {init, createAccount, deployContract, installContract, getAccount, updateToMultiSigAccount, submitTx, deployAsset, setTrust, mint} = require('../test-utils')
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
    lastTimestamp = currentPriceTimestamp = normalize_timestamp(Date.now()) - contractConfig.resolution
}

let historyRetentionPeriod = contractConfig.resolution * 10

let config = {}
async function prepare(wasm) {
    if (!config.admin) {
        config.admin = Keypair.random()
        config.nodes = Array.from({length: 5}, () => (Keypair.random()))

        await createAccount(config.admin.publicKey())
        config.updateContractWasmHash = await installContract(`./test/oracle/${wasm}`, config.admin.secret())
        config.contractId = await deployContract(config.updateContractWasmHash, config.admin.secret())

        config.feeToken = await deployAsset(`FEE:${config.admin.publicKey()}`, config.admin.secret())

        config.consumer = Keypair.random()
        await createAccount(config.consumer.publicKey())
        config.consumerAccount = await getAccount(config.consumer.publicKey())
        await setTrust(config.consumerAccount, new Asset('FEE', config.admin.publicKey()), config.consumer)

        config.adminAccount = await getAccount(config.admin.publicKey())
        await mint(new Asset('FEE', config.admin.publicKey()), config.consumer.publicKey(), '100000000000', config.adminAccount, config.admin)

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
            updateContractWasmHash: config.updateContractWasmHash,
            feeToken: config.feeToken,
            consumer: config.consumer.secret()
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

let version = 0

const oracles = {
    "v1": "reflector_oracle.wasm",
    "pulse": "reflector_oracle_pulse.wasm",
    "beam": "reflector_oracle_beam.wasm"
}

describe.each(Object.entries(oracles))(`OracleClient %s`, (type, wasm) => {

    beforeAll(async () => {
        await prepare(wasm)
    }, 3000000)

    afterAll(() => {
        config = {}
        contractConfig.assets.pop()
    })

    test('version', async () => {
        txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
        const simResponse = await config.client.version(config.adminAccount, {...txOptions, simulationOnly: true})
        expect(simResponse.result.retval.value()).toBeGreaterThan(0)
        version = simResponse.result.retval.value()
    }, 300000)

    test('config', async () => {
        //normalize to 1 minute and add 60 seconds
        txOptions.timebounds.maxTime = getNormalizedMaxDate(30000, 15000)
        const fn = type === "v1" ? 'config_v1' : 'config'
        await submitTx(
            config.client[fn](config.adminAccount, {
                admin: config.admin.publicKey(),
                assets: contractConfig.assets.slice(0, initAssetLength),
                baseAsset: tryEncodeAssetContractId(contractConfig.baseAsset, contractConfig.network),
                decimals: contractConfig.decimals,
                resolution: contractConfig.resolution,
                historyRetentionPeriod,
                cacheSize: 3,
                retentionConfig: {
                    token: config.feeToken,
                    fee: 10000000n
                }
            }, txOptions),
            config.nodes,
            response => {
                expect(response.status).toBe('SUCCESS')
                config.adminAccount.incrementSequenceNumber()
            })
    }, 300000)


    test('set_retention_config', async () => {
        txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
        if (type === "v1") {
            console.log('Skipping set_retention_config test for v1')
            return
        }
        await submitTx(
            config.client.setFeeConfig(config.adminAccount, {
                admin: config.admin.publicKey(),
                feeConfig: {
                    token: config.feeToken,
                    fee: 5000000n
                }
            }, txOptions),
            config.nodes,
            response => {
                expect(response.status).toBe('SUCCESS')
                config.adminAccount.incrementSequenceNumber()
            })
    }, 300000)

    test('retention_config', async () => {
        if (type === "v1") {
            console.log('Skipping retention_config test for v1')
            return
        }
        txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
        await submitTx(
            config.client.feeConfig(config.adminAccount, txOptions),
            config.nodes,
            response => {
                const fee = parseSorobanResult(response.resultMetaXdr)
                expect(fee).toBeDefined()
                expect(fee.length).toBe(2)
                expect(fee[0]).toBe('Some')
                expect(fee[1][1]).toBe(5000000n)
                expect(fee[1][0]).toBe(config.feeToken)
                config.adminAccount.incrementSequenceNumber()
            })
    }, 300000)

    test('set_cache_size', async () => {
        if (type === "v1") {
            console.log('Skipping set_cache_size test for v1')
            return
        }
        txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
        await submitTx(
            config.client.setCacheSize(config.adminAccount, {
                admin: config.admin.publicKey(),
                cacheSize: 5
            }, txOptions),
            config.nodes,
            response => {
                expect(response.status).toBe('SUCCESS')
                config.adminAccount.incrementSequenceNumber()
            })
    }, 300000)

    test('cache_size', async () => {
        if (type === "v1") {
            console.log('Skipping cache_size test for v1')
            return
        }
        txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
        await submitTx(
            config.client.cacheSize(config.adminAccount, txOptions),
            config.nodes,
            response => {
                const cacheSize = parseSorobanResult(response.resultMetaXdr)
                expect(cacheSize).toBe(5)
                config.adminAccount.incrementSequenceNumber()
            })
    }, 300000)

    test('extend_asset_ttl', async () => {
        if (type === "v1") {
            console.log('Skipping extend_asset_ttl test for v1')
            return
        }
        txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
        await submitTx(
            config.client.extendAssetTtl(config.consumerAccount, {
                sponsor: config.consumer.publicKey(),
                asset: contractConfig.assets[0],
                amount: 2500000n
            }, txOptions),
            [config.consumer],
            response => {
                expect(response.status).toBe('SUCCESS')
                config.consumerAccount.incrementSequenceNumber()
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

    test('set_history_retention_period', async () => {
        txOptions.timebounds.maxTime = getNormalizedMaxDate(30000, 15000)
        historyRetentionPeriod += contractConfig.resolution
        const fn = type === "v1" ? 'setHistoryRetentionPeriod_v1' : 'setHistoryRetentionPeriod'
        await submitTx(
            config.client[fn](config.updatesAdminAccount, {
                admin: config.admin.publicKey(),
                historyRetentionPeriod
            }, txOptions), config.nodes, response => {
                expect(response.status).toBe('SUCCESS')
                config.updatesAdminAccount.incrementSequenceNumber()
            })
        const fnGet = type === "v1" ? 'historyRetentionPeriod_v1' : 'historyRetentionPeriod'
        await submitTx(
            config.client[fnGet](config.adminAccount, txOptions),
            config.nodes,
            response => {
                const newPeriod = parseSorobanResult(response.resultMetaXdr)
                expect(newPeriod).toBe(BigInt(historyRetentionPeriod / 1000))
                config.adminAccount.incrementSequenceNumber()
            })
    }, 300000)

    test('set_price', async () => {
        initTimestamps()
        //create two updates to have data for price queries
        const fn = type === "v1" ? 'setPrices_v1' : 'setPrices'
        for (let i = 0; i < 2; i++) {
            const prices = Array.from({length: contractConfig.assets.length}, () => generateRandomI128())
            txOptions.timebounds.maxTime = getNormalizedMaxDate(30000, 15000)
            await submitTx(
                config.client[fn](
                    config.adminAccount,
                    {admin: config.admin.publicKey(), prices, timestamp: currentPriceTimestamp},
                    txOptions
                ),
                config.nodes,
                response => {
                    expect(response.status).toBe('SUCCESS')
                    config.adminAccount.incrementSequenceNumber()
                })
            currentPriceTimestamp += contractConfig.resolution
        }
    }, 300000)

    test('twap', async () => {
        txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
        const caller = type === "beam" ? config.consumer.publicKey() : null
        await submitTx(
            config.client.twap(config.consumerAccount, contractConfig.assets[0], 2, txOptions, caller),
            [config.consumer],
            response => {
                const twap = parseSorobanResult(response.resultMetaXdr)
                expect(twap > 0n).toBe(true)
                config.consumerAccount.incrementSequenceNumber()
                return `Twap: ${twap.toString()}`
            })
    }, 300000)

    test('x_twap', async () => {
        txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
        const caller = type === "beam" ? config.consumer.publicKey() : null
        await submitTx(
            config.client.xTwap(config.consumerAccount, contractConfig.assets[0], contractConfig.assets[1], 2, txOptions, caller),
            [config.consumer],
            response => {
                const twap = parseSorobanResult(response.resultMetaXdr)
                expect(twap > 0n).toBe(true)
                config.consumerAccount.incrementSequenceNumber()
                return `Twap: ${twap.toString()}`
            })
    }, 300000)

    test('lastprice', async () => {
        txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
        const caller = type === "beam" ? config.consumer.publicKey() : null
        await submitTx(
            config.client.lastPrice(config.consumerAccount, contractConfig.assets[0], txOptions, caller),
            [config.consumer],
            response => {
                const price = parseSorobanResult(response.resultMetaXdr)
                expect(price.price).toBeGreaterThan(0n)
                config.consumerAccount.incrementSequenceNumber()
                return `Price: ${priceToString(price)}`
            })
    }, 300000)

    test('x_lt_price', async () => {
        txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
        const caller = type === "beam" ? config.consumer.publicKey() : null
        await submitTx(
            config.client.xLastPrice(config.consumerAccount, contractConfig.assets[0], contractConfig.assets[1], txOptions, caller),
            [config.consumer],
            response => {
                const price = parseSorobanResult(response.resultMetaXdr)
                expect(price.price).toBeGreaterThan(0n)
                config.consumerAccount.incrementSequenceNumber()
                return `Price: ${priceToString(price)}`
            })
    }, 300000)

    test('price', async () => {
        txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
        const caller = type === "beam" ? config.consumer.publicKey() : null
        await submitTx(
            config.client.price(config.consumerAccount, contractConfig.assets[1], lastTimestamp / 1000, txOptions, caller),
            [config.consumer],
            response => {
                const price = parseSorobanResult(response.resultMetaXdr)
                expect(price.price).toBeGreaterThan(0n)
                config.consumerAccount.incrementSequenceNumber()
                return `Price: ${priceToString(price)}`
            })
    }, 300000)


    test('price (non existing)', async () => {
        txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
        const caller = type === "beam" ? config.consumer.publicKey() : null
        await submitTx(
            config.client.price(config.consumerAccount, contractConfig.assets[1], 10000000000, txOptions, caller),
            [config.consumer],
            response => {
                const price = parseSorobanResult(response.resultMetaXdr)
                expect(price).toBe(null)
                config.consumerAccount.incrementSequenceNumber()
            })
    }, 300000)

    test('x_price', async () => {
        txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
        const caller = type === "beam" ? config.consumer.publicKey() : null
        await submitTx(
            config.client.xPrice(config.consumerAccount, contractConfig.assets[0], contractConfig.assets[1], lastTimestamp / 1000, txOptions, caller),
            [config.consumer],
            response => {
                const price = parseSorobanResult(response.resultMetaXdr)
                expect(price.price).toBeGreaterThan(0n)
                config.consumerAccount.incrementSequenceNumber()
                return `Price: ${priceToString(price)}`
            })
    }, 300000)

    test('prices', async () => {
        txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
        const caller = type === "beam" ? config.consumer.publicKey() : null
        await submitTx(
            config.client.prices(config.consumerAccount, contractConfig.assets[0], 2, txOptions, caller),
            [config.consumer],
            response => {
                const prices = parseSorobanResult(response.resultMetaXdr)
                expect(prices.length > 0).toBe(true)
                config.consumerAccount.incrementSequenceNumber()
                return `Prices: ${prices.map(p => priceToString(p)).join(', ')}`
            })
    }, 300000)

    test('x_prices', async () => {
        txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
        const caller = type === "beam" ? config.consumer.publicKey() : null
        await submitTx(
            config.client.xPrices(config.consumerAccount, contractConfig.assets[0], contractConfig.assets[1], 2, txOptions, caller),
            [config.consumer],
            response => {
                const prices = parseSorobanResult(response.resultMetaXdr)
                expect(prices.length > 0).toBe(true)
                config.consumerAccount.incrementSequenceNumber()
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
                contractConfig.assets.push(extraAsset)
            })
    }, 300000)

    test('admin', async () => {
        txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
        await submitTx(
            config.client.admin(config.consumerAccount, txOptions),
            [config.consumer],
            response => {
                const adminPublicKey = parseSorobanResult(response.resultMetaXdr)
                expect(config.admin.publicKey()).toBe(adminPublicKey)
                config.consumerAccount.incrementSequenceNumber()
                return `Admin: ${adminPublicKey}`
            })
    }, 3000000)

    test('base', async () => {
        txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
        await submitTx(
            config.client.base(config.consumerAccount, txOptions),
            [config.consumer],
            response => {
                const base = parseSorobanResult(response.resultMetaXdr)
                expect(base).toBeDefined()
                config.consumerAccount.incrementSequenceNumber()
                return `Base: ${assetToString(base)}`
            })
    }, 3000000)


    test('decimals', async () => {
        txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
        await submitTx(
            config.client.decimals(config.consumerAccount, txOptions),
            [config.consumer],
            response => {
                const decimals = parseSorobanResult(response.resultMetaXdr)
                expect(decimals).toBe(contractConfig.decimals)
                config.consumerAccount.incrementSequenceNumber()
                return `Decimals: ${decimals}`
            })
    }, 300000)

    test('resolution', async () => {
        txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
        await submitTx(
            config.client.resolution(config.consumerAccount, txOptions),
            [config.consumer],
            response => {
                const resolution = parseSorobanResult(response.resultMetaXdr)
                expect(resolution).toBe(contractConfig.resolution / 1000) //in seconds
                config.consumerAccount.incrementSequenceNumber()
                return `Resolution: ${resolution}`
            })
    }, 300000)

    test('history_retention_period', async () => {
        txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
        const fn = version < 6 ? 'historyRetentionPeriod_v1' : 'historyRetentionPeriod'
        await submitTx(
            config.client[fn](config.consumerAccount, txOptions),
            [config.consumer],
            response => {
                const periodValue = parseSorobanResult(response.resultMetaXdr)
                expect(periodValue).toBe(BigInt(historyRetentionPeriod / 1000))
                config.consumerAccount.incrementSequenceNumber()
                return `History retention period: ${periodValue}`
            })
    }, 300000)

    test('assets', async () => {
        txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
        await submitTx(
            config.client.assets(config.consumerAccount, txOptions),
            [config.consumer],
            response => {
                const assets = parseSorobanResult(response.resultMetaXdr)
                expect(assets.length).toEqual(contractConfig.assets.length)
                config.consumerAccount.incrementSequenceNumber()
                return `Assets: ${assets.map(a => assetToString(a)).join(', ')}`
            })
    }, 300000)

    test('lasttimestamp', async () => {
        txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
        await submitTx(
            config.client.lastTimestamp(config.consumerAccount, txOptions),
            [config.consumer],
            response => {
                const timestamp = parseSorobanResult(response.resultMetaXdr)
                expect(timestamp).toBeGreaterThan(0)
                expect(timestamp).toBeLessThanOrEqual(2147483647)
                config.consumerAccount.incrementSequenceNumber()
                return `Timestamp: ${timestamp}`
            })
    }, 300000)

    test('set_invocation_cost', async () => {
        if (type !== "beam") {
            console.log('Skipping set_invocation_cost test for non-beam types')
            return
        }
        txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
        await submitTx(
            config.client.setInvocationCosts(config.updatesAdminAccount, {
                admin: config.admin.publicKey(),
                invocationCosts: [1000000n, 2000000n, 3000000n, 4000000n, 5000000n]
            }, txOptions),
            config.nodes,
            response => {
                expect(response.status).toBe('SUCCESS')
                config.updatesAdminAccount.incrementSequenceNumber()
            })
    }, 300000)

    test('invocation_costs', async () => {
        if (type !== "beam") {
            console.log('Skipping invocation_costs test for non-beam types')
            return
        }
        txOptions.timebounds.maxTime = getNormalizedMaxDate(60000, 30000)
        await submitTx(
            config.client.invocationCosts(config.consumerAccount, txOptions),
            [config.consumer],
            response => {
                const costs = parseSorobanResult(response.resultMetaXdr)
                expect(costs.length).toBe(5)
                expect(costs[0]).toBe(1000000n)
                expect(costs[1]).toBe(2000000n)
                expect(costs[2]).toBe(3000000n)
                expect(costs[3]).toBe(4000000n)
                expect(costs[4]).toBe(5000000n)
                config.consumerAccount.incrementSequenceNumber()
                return `Invocation costs: ${costs.join(', ')}`
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

}, 3000000)