/*eslint-disable no-inner-declarations */
/*eslint-disable no-undef */
const crypto = require('crypto')
const {exec} = require('child_process')
const {Keypair, SorobanRpc, TransactionBuilder, Operation, xdr, StrKey, Asset: StellarAsset, hash} = require('@stellar/stellar-sdk')
const Client = require('../src')
const AssetType = require('../src/asset-type')
const contractConfig = require('./example.contract.config.json')

if (contractConfig.assets.length < 2)
    throw new Error('Need at least 2 assets to run tests')

contractConfig.assets = contractConfig.assets.map(a => tryEncodeAssetContractId(a, contractConfig.network))
contractConfig.baseAsset = tryEncodeAssetContractId(contractConfig.baseAsset, contractConfig.network)

const initAssetLength = 1

const server = new SorobanRpc.Server(contractConfig.sorobanRpcUrl)

const extraAsset = {type: AssetType.Other, code: 'JPY'}

const assetToString = (asset) => !asset ? 'null' : `${asset.type}:${asset.code}`

const priceToString = (price) => !price ? 'null' : `{price: ${price.price.toString()}, timestamp: ${price.timestamp.toString()}}`

function tryEncodeAssetContractId(asset, networkPassphrase) {
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
            } else if (code === 'XLM') {
                stellarAsset = StellarAsset.native()
            } else {
                this.isContractId = isValidContractId(code)
                if (!this.isContractId)
                    new Error(`Asset code ${code} is invalid`)
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

function normalize_timestamp(timestamp) {
    return Math.floor(timestamp / contractConfig.resolution) * contractConfig.resolution
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

function getMajority(totalSignersCount) {
    return Math.floor(totalSignersCount / 2) + 1
}

async function sendTransaction(server, tx) {
    let result = await server.sendTransaction(tx)
    const hash = result.hash
    while (result.status === 'PENDING' || result.status === 'NOT_FOUND') {
        await new Promise(resolve => setTimeout(resolve, 1000))
        result = await server.getTransaction(hash)
    }
    if (result.status !== 'SUCCESS') {
        throw new Error(`Tx failed: ${result}`)
    }
    return result
}

async function createAccount(publicKey) {
    return await server.requestAirdrop(publicKey, contractConfig.friendbotUrl)
}

async function prepare() {
    if (!config.admin) {
        config.admin = Keypair.random()
        config.nodesKeypairs = Array.from({length: 5}, () => (Keypair.random()))

        async function exexCommand(command) {
            return await new Promise((resolve, reject) => {
                exec(command, (error, stdout, stderr) => {
                    if (error) {
                        console.error(`exec error: ${error}`)
                        reject(error)
                        return
                    }
                    if (stderr) {
                        console.error(`stderr: ${stderr}`)
                        reject(new Error(stderr))
                        return
                    }
                    resolve(stdout.trim())
                })
            })
        }

        async function deployContract() {
            const command = `soroban contract deploy --wasm ./test/reflector_oracle.wasm --source ${config.admin.secret()} --rpc-url ${contractConfig.sorobanRpcUrl} --network-passphrase "${contractConfig.network}" --fee 1000000000`
            return await exexCommand(command)
        }

        async function installUpdateContract() {
            const command = `soroban contract install --wasm ./test/reflector_oracle.wasm --source ${config.admin.secret()} --rpc-url ${contractConfig.sorobanRpcUrl} --network-passphrase "${contractConfig.network}" --fee 1000000000`
            return await exexCommand(command)
        }

        await createAccount(config.admin.publicKey())
        config.contractId = await deployContract()
        updateContractWasmHash = await installUpdateContract()

        config.adminAccount = await server.getAccount(config.admin.publicKey())

        async function updateToMultiSigAccount(account, keypair) {
            const majorityCount = getMajority(config.nodesKeypairs.length)
            let txBuilder = new TransactionBuilder(account, {fee: 1000000, networkPassphrase: contractConfig.network})
            txBuilder = txBuilder
                .setTimeout(30000)
                .addOperation(
                    Operation.setOptions({
                        masterWeight: 0,
                        lowThreshold: majorityCount,
                        medThreshold: majorityCount,
                        highThreshold: majorityCount
                    })
                )

            for (const nodeKeypair of config.nodesKeypairs) {
                txBuilder = txBuilder.addOperation(
                    Operation.setOptions({
                        signer: {
                            ed25519PublicKey: nodeKeypair.publicKey(),
                            weight: 1
                        }
                    })
                )
            }

            const tx = txBuilder.build()

            tx.sign(keypair)

            await sendTransaction(server, tx)
        }

        await updateToMultiSigAccount(config.adminAccount, config.admin)

        config.updatesAdmin = Keypair.random()

        console.log(`Updates config.admin: ${config.updatesAdmin.secret()}`)

        await createAccount(config.updatesAdmin.publicKey())

        config.updatesAdminAccount = await server.getAccount(config.updatesAdmin.publicKey())

        await updateToMultiSigAccount(config.updatesAdminAccount, config.updatesAdmin)


        //console all created account secrets and contracts ids
        console.log({
            admin: config.admin.secret(),
            updatesAdmin: config.updatesAdmin.secret(),
            nodes: config.nodesKeypairs.map(k => k.secret()),
            contractId: config.contractId
        })
    } else {
        config.adminAccount = await server.getAccount(config.admin.publicKey())
        config.updatesAdminAccount = await server.getAccount(config.updatesAdmin.publicKey())
    }

    config.client = new Client(contractConfig.network, contractConfig.sorobanRpcUrl, config.contractId)
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

function signTransaction(transaction) {
    const shuffledSigners = config.nodesKeypairs.sort(() => 0.5 - Math.random())
    const selectedSigners = shuffledSigners.slice(0, getMajority(config.nodesKeypairs.length))
    const txHash = transaction.hash()
    const signatures = []
    for (const signer of selectedSigners) {
        const signature = signer.signDecorated(txHash)
        signatures.push(signature)
    }
    return signatures
}

const txOptions = {
    minAccountSequence: '0',
    fee: 10000000
}

beforeAll(async () => {
    await prepare()
}, 3000000)

test('config', async () => {
    await submitTx(config.client.config(config.adminAccount, {
        admin: config.admin.publicKey(),
        assets: contractConfig.assets.slice(0, initAssetLength),
        baseAsset: tryEncodeAssetContractId(contractConfig.baseAsset, contractConfig.network),
        decimals: contractConfig.decimals,
        resolution: contractConfig.resolution,
        period
    }, txOptions), response => {
        expect(response).toBeDefined()
    })
}, 300000)

test('version', async () => {
    await submitTx(config.client.version(config.adminAccount, txOptions), response => {
        const version = Client.parseNumberResult(response.resultMetaXdr)
        expect(version).toBeDefined()
        return `Version: ${version}`
    })
}, 300000)

test('bump', async () => {
    await submitTx(config.client.bump(config.adminAccount, 500_000, txOptions), response => {
        expect(response).toBeDefined()
    })
}, 300000)

test('add_assets', async () => {
    await submitTx(config.client.addAssets(config.updatesAdminAccount, {
        admin: config.admin.publicKey(),
        assets: contractConfig.assets.slice(initAssetLength)
    }, txOptions), response => {
        expect(response).toBeDefined()
    })
}, 300000)

test('set_period', async () => {
    period += contractConfig.resolution
    await submitTx(config.client.setPeriod(config.updatesAdminAccount, {
        admin: config.admin.publicKey(),
        period
    }, txOptions), response => {
        expect(response).toBeDefined()
    })

    await submitTx(config.client.period(config.adminAccount, txOptions), response => {
        const newPeriod = Client.parseNumberResult(response.resultMetaXdr)
        expect(newPeriod).toBe(period)
    })
}, 300000)

test('set_price (extra price)', async () => {
    contractConfig.assets.push(extraAsset)
    const prices = Array.from({length: contractConfig.assets.length}, () => generateRandomI128())
    initTimestamps()
    await submitTx(config.client.setPrice(config.adminAccount, {admin: config.admin.publicKey(), prices, timestamp: currentPriceTimestamp}, txOptions), response => {
        expect(response).toBeDefined()
    })
    currentPriceTimestamp -= contractConfig.resolution
}, 300000)

test('set_price', async () => {
    const prices = Array.from({length: contractConfig.assets.length}, () => generateRandomI128())

    await submitTx(config.client.setPrice(config.adminAccount, {admin: config.admin.publicKey(), prices, timestamp: currentPriceTimestamp}, txOptions), response => {
        expect(response).toBeDefined()
    })
    currentPriceTimestamp -= contractConfig.resolution
}, 300000)


test('price', async () => {
    await submitTx(config.client.price(config.adminAccount, contractConfig.assets[1], lastTimestamp, txOptions), response => {
        const price = Client.parsePriceResult(response.resultMetaXdr)
        expect(price).toBeDefined()
        return `Price: ${priceToString(price)}`
    })
}, 300000)


test('price (non existing)', async () => {
    await submitTx(config.client.price(config.adminAccount, contractConfig.assets[1], 10000000000, txOptions), response => {
        const price = Client.parsePriceResult(response.resultMetaXdr)
        expect(price).toBeDefined()
        return `Price: ${priceToString(price)}`
    })
}, 300000)

test('x_price', async () => {
    await submitTx(config.client.xPrice(config.adminAccount, contractConfig.assets[0], contractConfig.assets[1], lastTimestamp, txOptions), response => {
        const price = Client.parsePriceResult(response.resultMetaXdr)
        expect(price).toBeDefined()
        return `Price: ${priceToString(price)}`
    })
}, 300000)

test('lastprice', async () => {
    await submitTx(config.client.lastPrice(config.adminAccount, contractConfig.assets[0], txOptions), response => {
        const price = Client.parsePriceResult(response.resultMetaXdr)
        expect(price).toBeDefined()
        return `Price: ${priceToString(price)}`
    })
}, 300000)

test('x_lt_price', async () => {
    await submitTx(config.client.xLastPrice(config.adminAccount, contractConfig.assets[0], contractConfig.assets[1], txOptions), response => {
        const price = Client.parsePriceResult(response.resultMetaXdr)
        expect(price).toBeDefined()
        return `Price: ${priceToString(price)}`
    })
}, 300000)

test('prices', async () => {
    await submitTx(config.client.prices(config.adminAccount, contractConfig.assets[0], 2, txOptions), response => {
        const prices = Client.parsePricesResult(response.resultMetaXdr)
        expect(prices.length > 0).toBe(true)
        return `Prices: ${prices.map(p => priceToString(p)).join(', ')}`
    })
}, 300000)

test('x_prices', async () => {
    await submitTx(config.client.xPrices(config.adminAccount, contractConfig.assets[0], contractConfig.assets[1], 2, txOptions), response => {
        const prices = Client.parsePricesResult(response.resultMetaXdr)
        expect(prices.length > 0).toBe(true)
        return `Prices: ${prices.map(p => priceToString(p)).join(', ')}`
    })
}, 300000)

test('twap', async () => {
    await submitTx(config.client.twap(config.adminAccount, contractConfig.assets[0], 2, txOptions), response => {
        const twap = Client.parseTwapResult(response.resultMetaXdr)
        expect(twap > 0n).toBe(true)
        return `Twap: ${twap.toString()}`
    })
}, 300000)

test('x_twap', async () => {
    await submitTx(config.client.xTwap(config.adminAccount, contractConfig.assets[0], contractConfig.assets[1], 2, txOptions), response => {
        const twap = Client.parseTwapResult(response.resultMetaXdr)
        expect(twap > 0n).toBe(true)
        return `Twap: ${twap.toString()}`
    })
}, 300000)

test('add_asset (extra asset)', async () => {
    await submitTx(config.client.addAssets(config.updatesAdminAccount, {
        admin: config.admin.publicKey(),
        assets: [extraAsset]
    }, txOptions), response => {
        expect(response).toBeDefined()
    })
}, 300000)

//TODO: add test for get_price for extra asset before adding it (must be null) and after adding it (must be valid price)

test('admin', async () => {
    await submitTx(config.client.admin(config.adminAccount, txOptions), response => {
        const adminPublicKey = Client.parseAdminResult(response.resultMetaXdr)
        expect(config.admin.publicKey()).toBe(adminPublicKey)
        return `Admin: ${adminPublicKey}`
    })
}, 3000000)

test('base', async () => {
    await submitTx(config.client.base(config.adminAccount, txOptions), response => {
        const base = Client.parseBaseResult(response.resultMetaXdr)
        expect(base !== null && base !== undefined).toBe(true)
        return `Base: ${assetToString(base)}`
    })
}, 3000000)


test('decimals', async () => {
    await submitTx(config.client.decimals(config.adminAccount, txOptions), response => {
        const decimals = Client.parseNumberResult(response.resultMetaXdr)
        expect(decimals).toBe(contractConfig.decimals)
        return `Decimals: ${decimals}`
    })
}, 300000)

test('resolution', async () => {
    await submitTx(config.client.resolution(config.adminAccount, txOptions), response => {
        const resolution = Client.parseNumberResult(response.resultMetaXdr)
        expect(resolution).toBe(contractConfig.resolution / 1000) //in seconds
        return `Resolution: ${resolution}`
    })
}, 300000)

test('period', async () => {
    await submitTx(config.client.period(config.adminAccount, txOptions), response => {
        const periodValue = Client.parseNumberResult(response.resultMetaXdr)
        expect(periodValue).toBe(period)
        return `Period: ${periodValue}`
    })
}, 300000)

test('assets', async () => {
    await submitTx(config.client.assets(config.adminAccount, txOptions), response => {
        const assets = Client.parseAssetsResult(response.resultMetaXdr)
        expect(assets.length).toEqual(contractConfig.assets.length)
        return `Assets: ${assets.map(a => assetToString(a)).join(', ')}`
    })
}, 300000)

test('lasttimestamp', async () => {
    await submitTx(config.client.lastTimestamp(config.adminAccount, txOptions), response => {
        const timestamp = Client.parseNumberResult(response.resultMetaXdr)
        expect(timestamp).toBeGreaterThan(0)
        return `Timestamp: ${timestamp}`
    })
}, 300000)

test('update_contract', async () => {
    await submitTx(config.client.updateContract(config.updatesAdminAccount, {
        admin: config.admin.publicKey(),
        wasmHash: updateContractWasmHash
    }, txOptions), () => { })
}, 300000)

async function submitTx(txPromise, processResponse) {
    const tx = await txPromise
    const signatures = signTransaction(tx)
    const response = await config.client.submitTransaction(tx, signatures)
    const additional = processResponse(response)

    console.log(`Transaction ID: ${response.hash}, Status: ${response.status}, ${additional || 'Success'}`)
}