const {
    SorobanRpc,
    Contract,
    TransactionBuilder,
    Address,
    xdr,
    Transaction,
    Memo,
    Keypair,
    scValToBigInt,
    nativeToScVal,
    Operation
} = require('@stellar/stellar-sdk')
const AssetType = require('./asset-type')

/**
 * @typedef {import('soroban-client').Account} Account
 */

/**
 * @typedef {Object} Asset
 * @property {AssetType} type - Asset type
 * @property {string} code - Asset code
 */

/**
 * @typedef {Object} Price
 * @property {BigInt} price - Price
 * @property {BigInt} timestamp - Timestamp
 */

/**
 * @typedef {Object} Config
 * @property {string} admin - Valid Stellar account ID
 * @property {Asset[]} assets - Array of assets
 * @property {number} period - Redeem period in milliseconds
 * @property {number} decimals - Price precision
 * @property {number} resolution - Price resolution
 * @property {number} baseAsset - Base asset for the price
 */

/**
 * @typedef {Object} TxOptions
 * @property {number} fee - Transaction fee in stroops
 * @property {string} memo - Transaction memo
 * @property {{minTime: number | Data, maxTime: number | Date}} timebounds - Transaction timebounds. Date must be rounded to seconds
 * @property {string[]} signers - Transaction signers
 */

/**
 * @callback RequestFn
 * @param {SorobanRpc.Server} server - Soroban RPC server
 * @returns {Promise<any>}
 */

/**
 * @typedef {import('stellar-sdk').SorobanRpc.GetTransactionResponse} TransactionResponse
 */

function getFactorOfValue(n) {
    const exponent = Math.floor(Math.log10(n))
    return Math.pow(10, exponent)
}

function roundValue(value) {
    if (value === 0)
        return value
    const factor = getFactorOfValue(value)
    return Math.floor(((value * 2) / factor)) * factor
}

/**
 * @param {OracleClient} client - Oracle client instance
 * @param {Account} source - Account object
 * @param {xdr.Operation} operation - Stellar operation
 * @param {TxOptions} options - Transaction options
 * @returns {Promise<Transaction>}
 */
async function buildTransaction(client, source, operation, options) {

    if (!options)
        throw new Error('options are required')

    const txBuilderOptions = structuredClone(options)
    txBuilderOptions.memo = options.memo ? Memo.text(options.memo) : null
    txBuilderOptions.networkPassphrase = client.network
    txBuilderOptions.timebounds = options.timebounds

    const transaction = new TransactionBuilder(source, txBuilderOptions)
        .addOperation(operation)
        .build()

    const request = async (server) => await server.simulateTransaction(transaction)

    /**@type {SorobanRpc.Api.SimulateTransactionSuccessResponse} */
    const simulationResponse = await makeServerRequest(client.sorobanRpcUrl, request)

    //Round fee up to the nearest 1000 stroops to avoid differences between the nodes
    const rawFee = Number(simulationResponse.minResourceFee)
    let resourceFee = BigInt(roundValue(rawFee))
    if (resourceFee < 10000000n)
        resourceFee = 10000000n

    const resources = simulationResponse.transactionData._data.resources()
    const [rawInstructions, rawReadBytes, rawWriteBytes] = [
        resources.instructions(),
        resources.readBytes(),
        resources.writeBytes()
    ]
    const [instructions, readBytes, writeBytes] = [
        roundValue(rawInstructions),
        roundValue(rawReadBytes),
        roundValue(rawWriteBytes)
    ]

    simulationResponse.transactionData.setResourceFee(resourceFee)
    simulationResponse.minResourceFee = resourceFee.toString()
    simulationResponse.transactionData.setResources(instructions, readBytes, writeBytes)

    const tx = SorobanRpc.assembleTransaction(transaction, simulationResponse, client.network).build()
    console.debug(`Transaction ${tx.hash().toString('hex')} cost: {cpuInsns: ${rawInstructions}:${instructions}, readBytes: ${rawReadBytes}:${readBytes}, writeBytes: ${rawWriteBytes}:${writeBytes}, fee: ${rawFee}:${resourceFee.toString()}`)
    return tx
}

/**
 * @param {string[]} rpcUrls - Soroban RPC server URLs
 * @param {RequestFn} requestFn - Request function
 * @returns {Promise<any>}
 */
async function makeServerRequest(rpcUrls, requestFn) {
    const errors = []
    for (const rpcUrl of rpcUrls) {
        try {
            const server = new SorobanRpc.Server(rpcUrl, {allowHttp: true})
            return await requestFn(server)
        } catch (e) {
            //if soroban rpc url failed, try next one
            console.debug(`Failed to build update. Soroban RPC url: ${rpcUrl}, error: ${e.message}`)
            errors.push(e)
        }
    }
    for (const e of errors) {
        console.error(e)
    }
    throw new Error('Failed to make request.')
}

/**
 * @param {Asset} asset - Asset object
 * @returns {xdr.ScVal}
 */
function buildAssetScVal(asset) {
    switch (asset.type) {
        case AssetType.Stellar:
            return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Stellar'), new Address(asset.code).toScVal()])
        case AssetType.Other:
            return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Other'), xdr.ScVal.scvSymbol(asset.code)])
        default:
            throw new Error('Invalid asset type')
    }
}

/**
 * @param {any} result - XDR result meta
 * @returns {*}
 */
function getSorobanResultValue(result) {
    const value = result.value().sorobanMeta().returnValue()
    if (value.value() === false) //if footprint's data is different from the contract execution data, the result is false
        return undefined
    return value
}

/**
 * @param {any} xdrAssetResult - XDR asset result
 * @returns {Asset}
 */
function parseXdrAssetResult(xdrAssetResult) {
    const xdrAsset = xdrAssetResult.value()
    const assetType = xdrAsset[0].value().toString()
    switch (AssetType[assetType]) {
        case AssetType.Other:
            return {type: AssetType.Other, code: xdrAsset[1].value().toString()}
        case AssetType.Stellar:
            return {type: AssetType.Stellar, code: Address.contract(xdrAsset[1].value().value()).toString()}
        default:
            throw new Error(`Unknown asset type: ${assetType}`)
    }
}

/**
 * @param {any} xdrPriceResult - XDR price result
 * @returns {Price | null}
 */
function parseXdrPriceResult(xdrPriceResult) {
    const xdrPrice = xdrPriceResult.value()
    if (!xdrPrice)
        return null
    return {
        price: scValToBigInt(xdrPrice[0].val()),
        timestamp: scValToBigInt(xdrPrice[1].val())
    }
}

class OracleClient {

    /**
     * @type {string}
     * @description Valid Stellar contract ID
     */
    contractId

    /**
     * @type {Contract}
     * @description Stellar contract instance
     */
    contract

    /**
     * @type {string}
     * @description Stellar network passphrase
     */
    network

    /**
     * @type {string[]}
     * @description Soroban RPC server URLs
     */
    sorobanRpcUrl

    constructor(network, sorobanRpcUrl, contractId) {
        this.contractId = contractId
        this.contract = new Contract(contractId)
        this.network = network
        this.sorobanRpcUrl = sorobanRpcUrl
    }

    /**
     * Builds a transaction for updating the contract
     * @param {Account} source - Account object
     * @param {{admin: string, wasmHash: string}} updateContractData - Wasm hash
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async updateContract(source, updateContractData, options) {
        const invocation = Operation.invokeContractFunction({
            source: updateContractData.admin,
            contract: this.contractId,
            function: 'update_contract',
            args: [xdr.ScVal.scvBytes(Buffer.from(updateContractData.wasmHash, 'hex'))]
        })
        return await buildTransaction(
            this,
            source,
            invocation,
            options
        )
    }

    /**
     * Builds a transaction to configure the oracle contract
     * @param {Account} source - Account object
     * @param {Config} config - Configuration object
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async config(source, config, options) {
        const configScVal = xdr.ScVal.scvMap([
            new xdr.ScMapEntry({key: xdr.ScVal.scvSymbol('admin'), val: new Address(config.admin).toScVal()}),
            new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol('assets'),
                val: xdr.ScVal.scvVec(config.assets.map(asset => buildAssetScVal(asset)))
            }),
            new xdr.ScMapEntry({key: xdr.ScVal.scvSymbol('base_asset'), val: buildAssetScVal(config.baseAsset)}),
            new xdr.ScMapEntry({key: xdr.ScVal.scvSymbol('decimals'), val: xdr.ScVal.scvU32(config.decimals)}),
            new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol('period'),
                val: xdr.ScVal.scvU64(xdr.Uint64.fromString(config.period.toString()))
            }),
            new xdr.ScMapEntry({key: xdr.ScVal.scvSymbol('resolution'), val: xdr.ScVal.scvU32(config.resolution)})
        ])
        const invocation = Operation.invokeContractFunction({
            source: config.admin,
            contract: this.contractId,
            function: 'config',
            args: [configScVal]
        })
        return await buildTransaction(
            this,
            source,
            invocation,
            options
        )
    }

    /**
     * Builds a transaction to register assets
     * @param {Account} source - Account object
     * @param {{admin: string, assets: Asset[]}} update - Array of assets
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async addAssets(source, update, options) {
        const invocation = Operation.invokeContractFunction({
            source: update.admin,
            contract: this.contractId,
            function: 'add_assets',
            args: [xdr.ScVal.scvVec(update.assets.map(asset => buildAssetScVal(asset)))]
        })
        return await buildTransaction(
            this,
            source,
            invocation,
            options
        )
    }

    /**
     * Builds a transaction to update period
     * @param {Account} source - Account object
     * @param {{admin: string, period: number}} update - Retention period in milliseconds
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async setPeriod(source, update, options) {
        const invocation = Operation.invokeContractFunction({
            source: update.admin,
            contract: this.contractId,
            function: 'set_period',
            args: [xdr.ScVal.scvU64(xdr.Uint64.fromString(update.period.toString()))]
        })
        return await buildTransaction(
            this,
            source,
            invocation,
            options
        )
    }

    /**
     * Builds a transaction to set prices
     * @param {Account} source - Account object
     * @param {{admin: string, prices: BigInt[], timestamp: number}} update - Array of prices
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async setPrice(source, update, options) {
        const invocation = Operation.invokeContractFunction({
            source: update.admin,
            contract: this.contractId,
            function: 'set_price',
            args: [
                xdr.ScVal.scvVec(update.prices.map(u => nativeToScVal(u, {type: 'i128'}))),
                xdr.ScVal.scvU64(xdr.Uint64.fromString(update.timestamp.toString()))
            ]
        })
        return await buildTransaction(
            this,
            source,
            invocation,
            options
        )
    }


    /**
     * Builds a transaction to get contract major version
     * @param {Account} source - Account object
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async version(source, options) {
        return await buildTransaction(this, source, this.contract.call('version'), options)
    }

    /**
     * Builds a transaction to get admin
     * @param {Account} source - Account object
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async admin(source, options) {
        return await buildTransaction(this, source, this.contract.call('admin'), options)
    }

    /**
     * Builds a transaction to get base asset
     * @param {Account} source - Account object
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async base(source, options) {
        return await buildTransaction(this, source, this.contract.call('base'), options)
    }

    /**
     * Builds a transaction to get decimals
     * @param {Account} source - Account object
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async decimals(source, options) {
        return await buildTransaction(this, source, this.contract.call('decimals'), options)
    }

    /**
     * Builds a transaction to get resolution
     * @param {Account} source - Account object
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async resolution(source, options) {
        return await buildTransaction(this, source, this.contract.call('resolution'), options)
    }

    /**
     * Builds a transaction to get retention period
     * @param {Account} source - Account object
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async period(source, options) {
        return await buildTransaction(this, source, this.contract.call('period'), options)
    }

    /**
     * Builds a transaction to get supported assets
     * @param {Account} source - Account object
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async assets(source, options) {
        return await buildTransaction(this, source, this.contract.call('assets'), options)
    }

    /**
     * Builds a transaction to get last timestamp
     * @param {Account} source - Account object
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async lastTimestamp(source, options) {
        return await buildTransaction(this, source, this.contract.call('last_timestamp'), options)
    }

    /**
     * Builds a transaction to get asset price at timestamp
     * @param {Account} source - Account object
     * @param {Asset} asset - Asset to get price for
     * @param {number} timestamp - Timestamp in milliseconds
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async price(source, asset, timestamp, options) {
        return await buildTransaction(
            this,
            source,
            this.contract.call(
                'price',
                buildAssetScVal(asset),
                xdr.ScVal.scvU64(xdr.Uint64.fromString(timestamp.toString()))
            ),
            options
        )
    }

    /**
     * Builds a transaction to get cross asset price at timestamp
     * @param {Account} source - Account object
     * @param {Asset} baseAsset - Base asset
     * @param {Asset} quoteAsset - Quote asset
     * @param {number} timestamp - Timestamp in milliseconds
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async xPrice(source, baseAsset, quoteAsset, timestamp, options) {
        return await buildTransaction(
            this,
            source,
            this.contract.call(
                'x_price',
                buildAssetScVal(baseAsset),
                buildAssetScVal(quoteAsset),
                xdr.ScVal.scvU64(xdr.Uint64.fromString(timestamp.toString()))
            ),
            options
        )
    }

    /**
     * Builds a transaction to get last asset price
     * @param {Account} source - Account object
     * @param {Asset} asset - Asset to get price for
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async lastPrice(source, asset, options) {
        return await buildTransaction(
            this,
            source,
            this.contract.call('lastprice', buildAssetScVal(asset)),
            options
        )
    }

    /**
     * Builds a transaction to get last cross asset price
     * @param {Account} source - Account object
     * @param {Asset} baseAsset - Base asset
     * @param {Asset} quoteAsset - Quote asset
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async xLastPrice(source, baseAsset, quoteAsset, options) {
        return await buildTransaction(
            this,
            source,
            this.contract.call(
                'x_last_price',
                buildAssetScVal(baseAsset),
                buildAssetScVal(quoteAsset)
            ),
            options
        )
    }

    /**
     * Builds a transaction to get last asset price records
     * @param {Account} source - Account object
     * @param {Asset} asset - Asset to get prices for
     * @param {number} records - Number of records to return
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async prices(source, asset, records, options) {
        return await buildTransaction(
            this,
            source,
            this.contract.call(
                'prices',
                buildAssetScVal(asset),
                xdr.ScVal.scvU32(records)
            ),
            options
        )
    }

    /**
     * Builds a transaction to get last cross asset price records
     * @param {Account} source - Account object
     * @param {Asset} baseAsset - Base asset
     * @param {Asset} quoteAsset - Quote asset
     * @param {number} records - Number of records to return
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async xPrices(source, baseAsset, quoteAsset, records, options) {
        return await buildTransaction(
            this,
            source,
            this.contract.call(
                'x_prices',
                buildAssetScVal(baseAsset),
                buildAssetScVal(quoteAsset),
                xdr.ScVal.scvU32(records)
            ),
            options
        )
    }

    /**
     * Builds a transaction to get asset price records in a period
     * @param {Account} source - Account object
     * @param {Asset} asset - Asset to get prices for
     * @param {number} records - Number of records to return
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async twap(source, asset, records, options) {
        return await buildTransaction(
            this,
            source,
            this.contract.call(
                'twap',
                buildAssetScVal(asset),
                xdr.ScVal.scvU32(records)
            ),
            options
        )
    }

    /**
     * Builds a transaction to get last cross asset price in a period
     * @param {Account} source - Account object
     * @param {Asset} baseAsset - Base asset
     * @param {Asset} quoteAsset - Quote asset
     * @param {number} records - Number of records to return
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async xTwap(source, baseAsset, quoteAsset, records, options) {
        return await buildTransaction(
            this,
            source,
            this.contract.call(
                'x_twap',
                buildAssetScVal(baseAsset),
                buildAssetScVal(quoteAsset),
                xdr.ScVal.scvU32(records)
            ),
            options
        )
    }

    /**
     * @param {Transaction} transaction - Transaction to submit
     * @param {xdr.DecoratedSignature[]} signatures - Signatures
     * @returns {Promise<TransactionResponse>} Transaction response
     */
    async submitTransaction(transaction, signatures = []) {
        const txXdr = transaction.toXDR() //Get the raw XDR for the transaction to avoid modifying the transaction object
        const tx = new Transaction(txXdr, this.network) //Create a new transaction object from the XDR
        signatures.forEach(signature => tx.addDecoratedSignature(signature))

        const requestFn = async (server) => await server.sendTransaction(tx)
        const submitResult = await makeServerRequest(this.sorobanRpcUrl, requestFn)
        if (submitResult.status !== 'PENDING') {
            const error = new Error(`Transaction submit failed: ${submitResult.status}`)
            error.status = submitResult.status
            error.errorResultXdr = submitResult.errorResult.toXDR('base64')
            error.hash = submitResult.hash
            throw error
        }
        const hash = submitResult.hash
        let response = await this.getTransaction(hash)
        while (response.status === 'PENDING' || response.status === 'NOT_FOUND') {
            response = await this.getTransaction(hash)
            await new Promise(resolve => setTimeout(resolve, 500))
        }

        response.hash = hash //Add hash to response to avoid return new object
        if (response.status === 'FAILED') {
            const error = new Error(`Transaction submit failed, result: ${response.status}`)
            error.status = response.status
            error.hash = response.hash
            error.envelopeXdr = response.envelopeXdr
            error.resultXdr = response.resultXdr
            error.resultMetaXdr = response.resultMetaXdr

        }
        return response
    }

    /**
     * @param {string} hash - Transaction hash
     * @returns {Promise<TransactionResponse>} - Transaction response
     */
    async getTransaction(hash) {
        const requestFn = async (server) => await server.getTransaction(hash)
        return await makeServerRequest(this.sorobanRpcUrl, requestFn)
    }

    /**
     * @param {string} result - Trasanction meta XDR
     * @returns {string} - Keypair public key
     */
    static parseAdminResult(result) {
        const adminBuffer = getSorobanResultValue(result)?.value()?.value()?.value()
        if (adminBuffer === undefined)
            return null
        const adminPublicKey = new Keypair({type: 'ed25519', publicKey: adminBuffer})
        return adminPublicKey.publicKey()
    }

    /**
     * @param {string} result - Trasanction meta XDR
     * @returns {Asset} - Asset object
     */
    static parseBaseResult(result) {
        const val = getSorobanResultValue(result)
        if (val === undefined)
            return null
        return parseXdrAssetResult(val)
    }

    /**
     * @param {string} result - Trasanction meta XDR
     * @returns {number} - Number value
     */
    static parseNumberResult(result) {
        const val = getSorobanResultValue(result)?.value()
        if (val === undefined)
            return null
        return Number(val)
    }

    /**
     * @param {string} result - Trasanction meta XDR
     * @returns {Asset[]} - Array of asset objects
     */
    static parseAssetsResult(result) {
        const val = getSorobanResultValue(result)?.value()
        if (val === undefined)
            return null
        const assets = []
        for (const assetResult of val)
            assets.push(parseXdrAssetResult(assetResult))
        return assets
    }

    /**
     * @param {string} result - Trasanction meta XDR
     * @returns {Price} - Price object
     */
    static parsePriceResult(result) {
        const val = getSorobanResultValue(result)
        if (val === undefined)
            return null
        return parseXdrPriceResult(val)
    }

    /**
     * @param {string} result - Trasanction meta XDR
     * @returns {Price[]} - Array of price objects
     */
    static parsePricesResult(result) {
        const val = getSorobanResultValue(result)?.value()
        if (val === undefined)
            return null
        const prices = []
        for (const priceResult of val)
            prices.push(parseXdrPriceResult(priceResult))
        return prices
    }

    /**
     * @param {string} result - Trasanction meta XDR
     * @returns {BigInt} - twap value
     */
    static parseTwapResult(result) {
        const val = getSorobanResultValue(result)
        if (val === undefined)
            return null
        return scValToBigInt(val)
    }
}

module.exports = OracleClient