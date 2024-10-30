const {
    Address,
    xdr,
    Operation
} = require('@stellar/stellar-sdk')
const {buildTransaction} = require('../rpc-helper')
const {buildTickerAssetScVal} = require('../xdr-values-helper')
const ContractClientBase = require('../client-base')

/**
 * @typedef {import('@stellar/stellar-sdk').Account} Account
 * @typedef {import('@stellar/stellar-sdk').Transaction} Transaction
 */

/**
 * @typedef {Object} TxOptions
 * @property {number} fee - Transaction fee in stroops
 * @property {string} memo - Transaction memo
 * @property {{minTime: number | Data, maxTime: number | Date}} timebounds - Transaction timebounds. Date must be rounded to seconds
 */

/**
 * @typedef {Object} Config
 * @property {string} admin - Valid Stellar account ID
 * @property {string} token - Valid Stellar asset code
 * @property {number} fee - Subscription fee
 */

/**
 * @typedef {Object} TickerAsset
 * @property {string} asset - Asset code
 * @property {string} source - Asset source contract ID
 */

/**
 * @typedef {Object} CreateSubscription
 * @property {string} owner - Valid Stellar account ID
 * @property {TickerAsset} base - Base asset to subscribe
 * @property {TickerAsset} quote - Quote asset to subscribe
 * @property {number} threshold - Threshold value in percentage
 * @property {number} heartbeat - Heartbeat value in minutes
 * @property {Buffer} webhook - Webhook URL
 * @property {number} amount - Deposit amount
 */

class SubscriptionsClient extends ContractClientBase {

    /**
     * Builds a transaction to configure the contract
     * @param {Account} source - Account object
     * @param {Config} config - Configuration object
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async config(source, config, options) {
        const configScVal = xdr.ScVal.scvMap([
            new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol('admin'),
                val: new Address(config.admin).toScVal()
            }),
            new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol('fee'),
                val: xdr.ScVal.scvU64(xdr.Uint64.fromString(config.fee.toString()))
            }),
            new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol('token'),
                val: new Address(config.token).toScVal()
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
     * Builds a transaction to create a subscription
     * @param {Account} source - Account object
     * @param {CreateSubscription} subscription - Subscription object to create
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async createSubscription(source, subscription, options) {

        const subscriptionScVal = xdr.ScVal.scvMap([
            new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol('base'),
                val: buildTickerAssetScVal(subscription.base)
            }),
            new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol('heartbeat'),
                val: xdr.ScVal.scvU32(subscription.heartbeat)
            }),
            new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol('owner'),
                val: new Address(subscription.owner).toScVal()
            }),
            new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol('quote'),
                val: buildTickerAssetScVal(subscription.quote)
            }),
            new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol('threshold'),
                val: xdr.ScVal.scvU32(subscription.threshold)
            }),
            new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol('webhook'),
                val: xdr.ScVal.scvBytes(subscription.webhook)
            })
        ])

        const invocation = Operation.invokeContractFunction({
            contract: this.contractId,
            function: 'create_subscription',
            args: [
                subscriptionScVal,
                xdr.ScVal.scvU64(xdr.Uint64.fromString(subscription.amount.toString()))
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
     * Builds a transaction to trigger subscriptions
     * @param {Account} source - Account object
     * @param {{triggerHash: Buffer, timestamp: number, admin: string}} data - Subscription trigger data
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async trigger(source, data, options) {
        const invocation = Operation.invokeContractFunction({
            source: data.admin,
            contract: this.contractId,
            function: 'trigger',
            args: [
                xdr.ScVal.scvU64(xdr.Uint64.fromString(data.timestamp.toString())),
                xdr.ScVal.scvBytes(data.triggerHash)
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
     * Builds a transaction to cancel subscription
     * @param {Account} source - Account object
     * @param {{subscriptionId: number}} data - Subscription cancel data
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async cancel(source, data, options) {
        const invocation = Operation.invokeContractFunction({
            source: source.accountId(),
            contract: this.contractId,
            function: 'cancel',
            args: [xdr.ScVal.scvU64(xdr.Uint64.fromString(data.subscriptionId.toString()))]
        })
        return await buildTransaction(
            this,
            source,
            invocation,
            options
        )
    }

    /**
     * Builds a transaction to update fee
     * @param {Account} source - Account object
     * @param {{fee: number, admin: string}} update - Subscription fee update
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async setFee(source, update, options) {
        const invocation = Operation.invokeContractFunction({
            source: update.admin,
            contract: this.contractId,
            function: 'set_fee',
            args: [xdr.ScVal.scvU64(xdr.Uint64.fromString(update.fee.toString()))]
        })
        return await buildTransaction(
            this,
            source,
            invocation,
            options
        )
    }

    /**
     * Builds a transaction to deposit subscription
     * @param {Account} source - Account object
     * @param {{from: string, subscriptionId: number, amount: number}} data - Deposit data
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async deposit(source, data, options) {
        const invocation = Operation.invokeContractFunction({
            source: data.from,
            contract: this.contractId,
            function: 'deposit',
            args: [
                new Address(data.from).toScVal(),
                xdr.ScVal.scvU64(xdr.Uint64.fromString(data.subscriptionId.toString())),
                xdr.ScVal.scvU64(xdr.Uint64.fromString(data.amount.toString()))
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
     * Builds a transaction to charge subscription
     * @param {Account} source - Account object
     * @param {{ids: number[], admin: string}} data - Charge data
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async charge(source, data, options) {
        const invocation = Operation.invokeContractFunction({
            source: data.admin,
            contract: this.contractId,
            function: 'charge',
            args: [
                xdr.ScVal.scvVec(
                    data.ids.map(id => xdr.ScVal.scvU64(xdr.Uint64.fromString(id.toString())))
                )
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
     * Builds a transaction to get subscription object
     * @param {Account} source - Account object
     * @param {{subscriptionId: number}} data - Subscription data
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async getSubscription(source, data, options) {
        const invocation = Operation.invokeContractFunction({
            contract: this.contractId,
            function: 'get_subscription',
            args: [xdr.ScVal.scvU64(xdr.Uint64.fromString(data.subscriptionId.toString()))]
        })
        return await buildTransaction(
            this,
            source,
            invocation,
            options
        )
    }

    /**
     * Builds a transaction to get fee
     * @param {Account} source - Account object
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async getFee(source, options) {
        const invocation = Operation.invokeContractFunction({
            contract: this.contractId,
            function: 'fee',
            args: []
        })
        return await buildTransaction(
            this,
            source,
            invocation,
            options
        )
    }

    /**
     * Builds a transaction to get contract token
     * @param {Account} source - Account object
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async getToken(source, options) {
        const invocation = Operation.invokeContractFunction({
            contract: this.contractId,
            function: 'token',
            args: []
        })
        return await buildTransaction(
            this,
            source,
            invocation,
            options
        )
    }
}

module.exports = SubscriptionsClient