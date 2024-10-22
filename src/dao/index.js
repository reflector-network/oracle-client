const {
    Address,
    xdr,
    nativeToScVal,
    Operation
} = require('@stellar/stellar-sdk')
const {buildTransaction} = require('../rpc-helper')
const ContractClientBase = require('../client-base')

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
 * @typedef {Object} Config
 * @property {string} admin - Valid Stellar account ID
 * @property {string} token - Valid Stellar asset contract ID
 * @property {string} amount - Redeem period in milliseconds
 * @property {Object.<number, string>} depositParams - deposit parameters
 * @property {string} startDate - Price resolution
 */

/**
 * @param {Object.<number, string>} depositParams - deposit parameters
 * @returns {xdr.ScVal}
 */
function buildDepositParamsScVal(depositParams) {
    return xdr.ScVal.scvMap(Object.entries(depositParams)
        .sort((a, b) => Number(a[0]) - Number(b[0])) //make sure the order is correct
        .map(v => new xdr.ScMapEntry({
            key: xdr.ScVal.scvU32(Number(v[0])),
            val: nativeToScVal(v[1].toString(), {type: 'i128'})
        }))
    )
}

class DAOClient extends ContractClientBase {

    /**
     * Builds a transaction to configure the DAO contract
     * @param {Account} source - Account object
     * @param {Config} config - Configuration object
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async config(source, config, options) {
        const configScVal = xdr.ScVal.scvMap([
            new xdr.ScMapEntry({key: xdr.ScVal.scvSymbol('admin'), val: new Address(config.admin).toScVal()}),
            new xdr.ScMapEntry({key: xdr.ScVal.scvSymbol('amount'), val: nativeToScVal(config.amount.toString(), {type: 'i128'})}),
            new xdr.ScMapEntry({key: xdr.ScVal.scvSymbol('deposit_params'), val: buildDepositParamsScVal(config.depositParams)}),
            new xdr.ScMapEntry({key: xdr.ScVal.scvSymbol('start_date'), val: nativeToScVal(config.startDate.toString(), {type: 'u64'})}),
            new xdr.ScMapEntry({key: xdr.ScVal.scvSymbol('token'), val: new Address(config.token).toScVal()})
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
     * Builds a transaction to set deposit parameters
     * @param {Account} source - Account object
     * @param {{admin: string, depositParams: Object.<number, string>}} update - deposit parameters
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async setDeposit(source, update, options) {
        const invocation = Operation.invokeContractFunction({
            source: update.admin,
            contract: this.contractId,
            function: 'set_deposit',
            args: [buildDepositParamsScVal(update.depositParams)]
        })
        return await buildTransaction(
            this,
            source,
            invocation,
            options
        )
    }

    /**
     * Builds a transaction to unlock funds
     * @param {Account} source - Account object
     * @param {{admin: string, developer: string, operators: string[]}} update - Array of operators and developer to unlock funds for
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async unlock(source, update, options) {
        const invocation = Operation.invokeContractFunction({
            source: update.admin,
            contract: this.contractId,
            function: 'unlock',
            args: [new Address(update.developer).toScVal(), xdr.ScVal.scvVec(update.operators.map(o => new Address(o).toScVal()))]
        })
        return await buildTransaction(
            this,
            source,
            invocation,
            options
        )
    }

    /**
     * Builds a transaction to vote for ballot
     * @param {Account} source - Account object
     * @param {{admin: string, ballotId: string, accepted: boolean}} update - Ballot ID and voting decision
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async vote(source, update, options) {
        const invocation = Operation.invokeContractFunction({
            source: update.admin,
            contract: this.contractId,
            function: 'vote',
            args: [
                nativeToScVal(update.ballotId.toString(), {type: 'u64'}),
                xdr.ScVal.scvBool(update.accepted)
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
     * Builds a transaction to get available funds
     * @param {Account} source - Account object
     * @param {string} claimant - Claimant account ID
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async available(source, claimant, options) {
        const invocation = Operation.invokeContractFunction({
            contract: this.contractId,
            function: 'available',
            args: [
                new Address(claimant).toScVal()
            ]
        })
        return await buildTransaction(this, source, invocation, options)
    }

    /**
     * Builds a transaction to get available funds
     * @param {Account} source - Account object
     * @param {{claimant: string, to: string, amount: string}} claim - Claim data
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async claim(source, claim, options) {
        const invocation = Operation.invokeContractFunction({
            contract: this.contractId,
            function: 'claim',
            args: [
                new Address(claim.claimant).toScVal(),
                new Address(claim.to).toScVal(),
                nativeToScVal(claim.amount.toString(), {type: 'i128'})
            ]
        })
        return await buildTransaction(this, source, invocation, options)
    }

    /**
     * Builds a transaction to create a ballot
     * @param {Account} source - Account object
     * @param {{category: (number|string), title: string, description: string}} ballot - Ballot data
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async createBallot(source, ballot, options) {
        const ballotScVal = xdr.ScVal.scvMap([
            new xdr.ScMapEntry({key: xdr.ScVal.scvSymbol('category'), val: nativeToScVal(ballot.category.toString(), {type: 'u32'})}),
            new xdr.ScMapEntry({key: xdr.ScVal.scvSymbol('description'), val: xdr.ScVal.scvString(ballot.description)}),
            new xdr.ScMapEntry({key: xdr.ScVal.scvSymbol('initiator'), val: new Address(source.accountId()).toScVal()}),
            new xdr.ScMapEntry({key: xdr.ScVal.scvSymbol('title'), val: xdr.ScVal.scvString(ballot.title)})
        ])
        const invocation = Operation.invokeContractFunction({
            source: source.accountId(),
            contract: this.contractId,
            function: 'create_ballot',
            args: [ballotScVal]
        })
        return await buildTransaction(
            this,
            source,
            invocation,
            options
        )
    }

    /**
     * Builds a transaction to get ballot
     * @param {Account} source - Account object
     * @param {string} ballotId - Ballot ID
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async getBallot(source, ballotId, options) {
        const invocation = Operation.invokeContractFunction({
            contract: this.contractId,
            function: 'get_ballot',
            args: [nativeToScVal(ballotId.toString(), {type: 'u64'})]
        })
        return await buildTransaction(
            this,
            source,
            invocation,
            options
        )
    }

    /**
     * Builds a transaction to retract ballot
     * @param {Account} source - Account object
     * @param {string} ballotId - Ballot ID
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async retractBallot(source, ballotId, options) {
        const invocation = Operation.invokeContractFunction({
            source: source.accountId(),
            contract: this.contractId,
            function: 'retract_ballot',
            args: [nativeToScVal(ballotId.toString(), {type: 'u64'})]
        })
        return await buildTransaction(
            this,
            source,
            invocation,
            options
        )
    }
}

module.exports = DAOClient