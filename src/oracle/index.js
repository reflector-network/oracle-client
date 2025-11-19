const {
    Address,
    xdr,
    nativeToScVal,
    Operation
} = require('@stellar/stellar-sdk')
const {buildTransaction} = require('../rpc-helper')
const ContractClientBase = require('../client-base')
const {buildAssetScVal, buildFeeConfigScVal} = require('../xdr-values-helper')

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
 * @property {boolean} [simulationOnly] - whether to build simulation only
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
 * @property {number} historyRetentionPeriod - History retention period in milliseconds
 * @property {number} decimals - Price precision
 * @property {number} resolution - Price resolution
 * @property {Asset} baseAsset - Base asset for the price
 * @property {number} cacheSize - Size of the price cache
 * @property {FeeConfig} feeConfig - Fee configuration
 * @property {number} initialExpirationPeriod - Initial expiration period in days
 */

/**
 * @typedef {Object} FeeConfig
 * @property {string} token - fee asset address
 * @property {BigInt} fee - fee in stroops
 */

/**
 * @typedef {Object} ExtendAssetExpirationArgs
 * @property {string} sponsor - sponsor account id
 * @property {Asset} asset - asset to extend
 * @property {BigInt} amount - amount to extend
 */

function resolvePeriodUpdateMaskPosition(assetIndex) {
    const byte = Math.floor(assetIndex / 8)
    const bitmask = 1 << (assetIndex % 8)
    return [byte, bitmask]
}

function generateUpdateRecordMask(updates) {
    const mask = Buffer.alloc(32, 0)

    for (let assetIndex = 0; assetIndex < updates.length; assetIndex++) {
        const price = updates[assetIndex]

        const isPositive = price > 0n

        if (isPositive) {
            const [byte, bitmask] = resolvePeriodUpdateMaskPosition(assetIndex)
            if (byte >= 32)
                continue
            mask[byte] = mask[byte] | bitmask
        }
    }
    return mask
}

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
            new xdr.ScMapEntry({key: xdr.ScVal.scvSymbol('cache_size'), val: xdr.ScVal.scvU32(config.cacheSize)}),
            new xdr.ScMapEntry({key: xdr.ScVal.scvSymbol('decimals'), val: xdr.ScVal.scvU32(config.decimals)}),
            new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol('fee_config'),
                val: buildFeeConfigScVal(config.feeConfig)
            }),
            new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol('history_retention_period'),
                val: xdr.ScVal.scvU64(xdr.Uint64.fromString(config.historyRetentionPeriod.toString()))
            }),
            new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol('resolution'),
                val: xdr.ScVal.scvU32(config.resolution)
            })
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
     * Builds a transaction to configure the oracle contract
     * @param {Account} source - Account object
     * @param {Config} config - Configuration object
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async config_v1(source, config, options) {
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
                val: xdr.ScVal.scvU64(xdr.Uint64.fromString(config.historyRetentionPeriod.toString()))
            }),
            new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol('resolution'),
                val: xdr.ScVal.scvU32(config.resolution)
            })
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
     * @param {{admin: string, historyRetentionPeriod: number}} update - Retention period in milliseconds
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async setHistoryRetentionPeriod(source, update, options) {
        const invocation = Operation.invokeContractFunction({
            source: update.admin,
            contract: this.contractId,
            function: 'set_history_retention_period',
            args: [xdr.ScVal.scvU64(xdr.Uint64.fromString(update.historyRetentionPeriod.toString()))]
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
     * @param {{admin: string, historyRetentionPeriod: number}} update - Retention period in milliseconds
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async setHistoryRetentionPeriod_v1(source, update, options) {
        const invocation = Operation.invokeContractFunction({
            source: update.admin,
            contract: this.contractId,
            function: 'set_period',
            args: [xdr.ScVal.scvU64(xdr.Uint64.fromString(update.historyRetentionPeriod.toString()))]
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
    async setPrices(source, update, options) {
        const invocation = Operation.invokeContractFunction({
            source: update.admin,
            contract: this.contractId,
            function: 'set_price',
            args: [
                xdr.ScVal.scvMap([
                    new xdr.ScMapEntry({
                        key: xdr.ScVal.scvSymbol('mask'),
                        val: xdr.ScVal.scvBytes(generateUpdateRecordMask(update.prices))
                    }),
                    new xdr.ScMapEntry({
                        key: xdr.ScVal.scvSymbol('prices'),
                        val: xdr.ScVal.scvVec(update.prices.filter(u => u > 0).map(u => nativeToScVal(u, {type: 'i128'})))
                    })
                ]),
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
     * Builds a transaction to set prices
     * @param {Account} source - Account object
     * @param {{admin: string, prices: BigInt[], timestamp: number}} update - Array of prices
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async setPrices_v1(source, update, options) {
        const invocation = Operation.invokeContractFunction({
            source: update.admin,
            contract: this.contractId,
            function: 'set_price',
            args: [
                xdr.ScVal.scvVec(update.prices.filter(u => u > 0).map(u => nativeToScVal(u, {type: 'i128'}))),
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
     * Builds a transaction to set fee configuration
     * @param {Account} source - Account object
     * @param {{admin: string, feeConfig: FeeConfig}} update - Fee configuration update
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async setFeeConfig(source, update, options) {
        const invocation = Operation.invokeContractFunction({
            source: update.admin,
            contract: this.contractId,
            function: 'set_fee_config',
            args: [buildFeeConfigScVal(update.feeConfig)]
        })
        return await buildTransaction(
            this,
            source,
            invocation,
            options
        )
    }

    /**
     * Builds a transaction to set cache size
     * @param {Account} source - Account object
     * @param {{admin: string, cacheSize: number}} update - Cache size update
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async setCacheSize(source, update, options) {
        const invocation = Operation.invokeContractFunction({
            source: update.admin,
            contract: this.contractId,
            function: 'set_cache_size',
            args: [xdr.ScVal.scvU32(update.cacheSize)]
        })
        return await buildTransaction(
            this,
            source,
            invocation,
            options
        )
    }

    /**
     * Builds a transaction to set invocation cost
     * @param {Account} source - Account object
     * @param {{admin: string, invocationCosts: BigInt[]}} update - Invocation costs update
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async setInvocationCosts(source, update, options) {
        const invocation = Operation.invokeContractFunction({
            source: update.admin,
            contract: this.contractId,
            function: 'set_invocation_costs_config',
            args: [xdr.ScVal.scvVec(update.invocationCosts.map(c => xdr.ScVal.scvU64(c)))]
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
     * Builds a transaction to get retention history period
     * @param {Account} source - Account object
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async historyRetentionPeriod(source, options) {
        return await buildTransaction(this, source, this.contract.call('history_retention_period'), options)
    }

    /**
     * Builds a transaction to get retention history period
     * @param {Account} source - Account object
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async historyRetentionPeriod_v1(source, options) {
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
     * @param {string} [caller] - Caller account id
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async price(source, asset, timestamp, options, caller = null) {
        const args = [
            buildAssetScVal(asset),
            xdr.ScVal.scvU64(xdr.Uint64.fromString(timestamp.toString()))
        ]
        if (caller) {
            args.unshift(new Address(caller).toScVal())
        }
        return await buildTransaction(
            this,
            source,
            this.contract.call(
                'price',
                ...args
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
     * @param {string} [caller] - Caller account id
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async xPrice(source, baseAsset, quoteAsset, timestamp, options, caller = null) {
        const args = [
            buildAssetScVal(baseAsset),
            buildAssetScVal(quoteAsset),
            xdr.ScVal.scvU64(xdr.Uint64.fromString(timestamp.toString()))
        ]
        if (caller) {
            args.unshift(new Address(caller).toScVal())
        }
        return await buildTransaction(
            this,
            source,
            this.contract.call(
                'x_price',
                ...args
            ),
            options
        )
    }

    /**
     * Builds a transaction to get last asset price
     * @param {Account} source - Account object
     * @param {Asset} asset - Asset to get price for
     * @param {TxOptions} options - Transaction options
     * @param {string} [caller] - Caller account id
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async lastPrice(source, asset, options, caller = null) {
        const args = [
            buildAssetScVal(asset)
        ]
        if (caller) {
            args.unshift(new Address(caller).toScVal())
        }
        return await buildTransaction(
            this,
            source,
            this.contract.call('lastprice', ...args),
            options
        )
    }

    /**
     * Builds a transaction to get last cross asset price
     * @param {Account} source - Account object
     * @param {Asset} baseAsset - Base asset
     * @param {Asset} quoteAsset - Quote asset
     * @param {TxOptions} options - Transaction options
     * @param {string} [caller] - Caller account id
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async xLastPrice(source, baseAsset, quoteAsset, options, caller = null) {
        const args = [
            buildAssetScVal(baseAsset),
            buildAssetScVal(quoteAsset)
        ]
        if (caller) {
            args.unshift(new Address(caller).toScVal())
        }
        return await buildTransaction(
            this,
            source,
            this.contract.call(
                'x_last_price',
                ...args
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
     * @param {string} [caller] - Caller account id
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async prices(source, asset, records, options, caller = null) {
        const args = [
            buildAssetScVal(asset),
            xdr.ScVal.scvU32(records)
        ]
        if (caller) {
            args.unshift(new Address(caller).toScVal())
        }
        return await buildTransaction(
            this,
            source,
            this.contract.call(
                'prices',
                ...args
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
     * @param {string} [caller] - Caller account id
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async xPrices(source, baseAsset, quoteAsset, records, options, caller = null) {
        const args = [
            buildAssetScVal(baseAsset),
            buildAssetScVal(quoteAsset),
            xdr.ScVal.scvU32(records)
        ]
        if (caller) {
            args.unshift(new Address(caller).toScVal())
        }
        return await buildTransaction(
            this,
            source,
            this.contract.call(
                'x_prices',
                ...args
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
     * @param {string} [caller] - Caller account id
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async twap(source, asset, records, options, caller = null) {
        const args = [
            buildAssetScVal(asset),
            xdr.ScVal.scvU32(records)
        ]
        if (caller) {
            args.unshift(new Address(caller).toScVal())
        }
        return await buildTransaction(
            this,
            source,
            this.contract.call(
                'twap',
                ...args
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
     * @param {string} [caller] - Caller account id
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async xTwap(source, baseAsset, quoteAsset, records, options, caller = null) {
        const args = [
            buildAssetScVal(baseAsset),
            buildAssetScVal(quoteAsset),
            xdr.ScVal.scvU32(records)
        ]
        if (caller) {
            args.unshift(new Address(caller).toScVal())
        }
        return await buildTransaction(
            this,
            source,
            this.contract.call(
                'x_twap',
                ...args
            ),
            options
        )
    }

    /**
     * Builds a transaction to get asset's expiration time
     * @param {Account} source - Account object
     * @param {Asset} asset - Asset to get expiration time for
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async expires(source, asset, options) {
        return await buildTransaction(
            this,
            source,
            this.contract.call(
                'expires',
                buildAssetScVal(asset)
            ),
            options
        )
    }

    /**
     * Builds a transaction to get asset price records in a period
     * @param {Account} source - Account object
     * @param {ExtendAssetExpirationArgs} extendArgs - Extend asset expiration time arguments
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
                nativeToScVal(extendArgs.amount, {type: 'i128'})
            ),
            options
        )
    }

    /**
     * Builds a transaction to get fee configuration
     * @param {Account} source - Account object
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async feeConfig(source, options) {
        return await buildTransaction(this, source, this.contract.call('fee_config'), options)
    }

    /**
     * Builds a transaction to get cache size
     * @param {Account} source - Account object
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async cacheSize(source, options) {
        return await buildTransaction(this, source, this.contract.call('cache_size'), options)
    }

    /**
     * Builds a transaction to get invocation costs
     * @param {Account} source - Account object
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async invocationCosts(source, options) {
        return await buildTransaction(this, source, this.contract.call('invocation_costs'), options)
    }
}

module.exports = OracleClient