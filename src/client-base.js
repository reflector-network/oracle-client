const {
    Contract,
    xdr,
    Operation
} = require('@stellar/stellar-sdk')
const {buildTransaction} = require('./rpc-helper')

/**
 * @typedef {import('soroban-client').Account} Account
 */

class ContractClientBase {

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
     * Builds a transaction to get admin
     * @param {Account} source - Account object
     * @param {TxOptions} options - Transaction options
     * @returns {Promise<Transaction>} Prepared transaction
     */
    async admin(source, options) {
        return await buildTransaction(this, source, this.contract.call('admin'), options)
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
}

module.exports = ContractClientBase