const {
    Address,
    xdr,
    nativeToScVal,
    Operation
} = require('@stellar/stellar-sdk')
const {buildTransaction} = require('../rpc-helper')
const ContractClientBase = require('../client-base')
const {buildAssetScVal} = require('../xdr-values-helper')

/**
 * @typedef {import('@stellar/stellar-sdk').Account} Account
 * @typedef {import('@stellar/stellar-sdk').Transaction} Transaction
 */

/**
 * @typedef {Object} Asset
 * @property {AssetType} type - Asset type
 * @property {string} code - Asset code
 */

/**
 * @typedef {Object} TxOptions
 * @property {number} fee - Transaction fee in stroops
 * @property {string} memo - Transaction memo
 * @property {{minTime: number | Data, maxTime: number | Date}} timebounds - Transaction timebounds. Date must be rounded to seconds
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
 * @property {Asset} baseAsset - Base asset for the price
 */

/**
 * @typedef {Object} FeeData
 * @property {string} token - fee asset address
 * @property {BigInt} fee - fee in stroops
 */

/**
 * @typedef {Object} ExtendAssetTtlArgs
 * @property {string} sponsor - sponsor account id
 * @property {Asset} asset - asset to extend
 * @property {number} days - number of days to extend
 */

class OracleClient extends ContractClientBase {

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
     * Builds a transaction to set fee data
     * @param {Account} source - Account object
     * @param {{admin: string, feeData: FeeData}} update - Fee data update
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async setFeeData(source, update, options) {
        const invocation = Operation.invokeContractFunction({
            source: update.admin,
            contract: this.contractId,
            function: 'set_fee',
            args: [
                xdr.ScVal.scvVec([
                    new Address(update.feeData.token).toScVal(),
                    nativeToScVal(update.feeData.fee, {type: 'i128'})
                ])
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
     * Builds a transaction to get asset's ttl
     * @param {Account} source - Account object
     * @param {Asset} asset - Asset to get ttl for
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async assetTtl(source, asset, options) {
        return await buildTransaction(
            this,
            source,
            this.contract.call(
                'asset_ttl',
                buildAssetScVal(asset)
            ),
            options
        )
    }

    /**
     * Builds a transaction to get asset price records in a period
     * @param {Account} source - Account object
     * @param {ExtendAssetTtlArgs} extendArgs - Extend asset ttl arguments
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async extendAssetTtl(source, extendArgs, options) {
        return await buildTransaction(
            this,
            source,
            this.contract.call(
                'extend_asset_ttl',
                new Address(extendArgs.sponsor).toScVal(),
                buildAssetScVal(extendArgs.asset),
                xdr.ScVal.scvU32(extendArgs.days)
            ),
            options
        )
    }

    /**
     * Builds a transaction to get fee data
     * @param {Account} source - Account object
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async fee(source, options) {
        return await buildTransaction(this, source, this.contract.call('fee'), options)
    }
}

module.exports = OracleClient