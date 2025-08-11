const {exec} = require('child_process')
const {TransactionBuilder, Operation, rpc, Transaction} = require('@stellar/stellar-sdk')
const axios = require('axios')
const {makeServerRequest} = require('../src/rpc-helper')

/**
 * @typedef {import('@stellar/stellar-sdk').xdr.SorobanTransactionMeta} SorobanTransactionMeta
 */

/**@type {rpc.Server} */
let server = null
let rpcUrl = null
let network = null
let friendbotUrl = null

function init(sorobanRpcUrl, networkPassphrase, networkFriendbotUrl) {
    rpcUrl = sorobanRpcUrl
    network = networkPassphrase
    friendbotUrl = networkFriendbotUrl
    server = new rpc.Server(sorobanRpcUrl)
}

async function exexCommand(command) {
    return await new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error(`exec error: ${error}`)
                reject(error)
                return
            }
            //if (stderr) {
            //console.error(`stderr: ${stderr}`)
            //reject(new Error(stderr))
            //return
            //}
            resolve(stdout.trim())
        })
    })
}

async function deployContract(hash, secret) {
    const command = `stellar contract deploy --wasm-hash ${hash} --source ${secret} --rpc-url ${rpcUrl} --network-passphrase "${network}" --fee 1000000000`
    return await exexCommand(command)
}

async function installContract(contractPath, secret) {
    const command = `stellar contract upload --wasm ${contractPath} --source ${secret} --rpc-url ${rpcUrl} --network-passphrase "${network}" --fee 1000000000`
    return await exexCommand(command)
}

async function deployAsset(asset, secret) {
    const command = `stellar contract asset deploy --asset ${asset} --source ${secret} --rpc-url ${rpcUrl} --network-passphrase "${network}" --fee 1000000000`
    return await exexCommand(command)
}

async function mint(asset, destination, amount, account, signer) {
    let txBuilder = new TransactionBuilder(account, {fee: 1000000, networkPassphrase: network})
    txBuilder = txBuilder
        .setTimeout(30000)
        .addOperation(
            Operation.payment({
                destination,
                asset,
                amount
            })
        )

    const tx = txBuilder.build()

    tx.sign(signer)

    await sendTransaction(server, tx)
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


function getMajority(totalSignersCount) {
    return Math.floor(totalSignersCount / 2) + 1
}

async function createAccount(publicKey) {
    await axios.get(`${friendbotUrl}?addr=${publicKey}`)
}

async function setTrust(source, asset, signer) {
    let txBuilder = new TransactionBuilder(source, {fee: 1000000, networkPassphrase: network})
    txBuilder = txBuilder
        .setTimeout(30000)
        .addOperation(
            Operation.changeTrust({
                asset
            })
        )

    const tx = txBuilder.build()

    tx.sign(signer)

    await sendTransaction(server, tx)
}

async function getAccount(publicKey) {
    return await server.getAccount(publicKey)
}

async function updateToMultiSigAccount(account, keypair, nodes) {
    const majorityCount = getMajority(nodes.length)
    let txBuilder = new TransactionBuilder(account, {fee: 1000000, networkPassphrase: network})
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

    for (const nodePubkey of nodes) {
        txBuilder = txBuilder.addOperation(
            Operation.setOptions({
                signer: {
                    ed25519PublicKey: nodePubkey,
                    weight: 1
                }
            })
        )
    }

    const tx = txBuilder.build()

    tx.sign(keypair)

    await sendTransaction(server, tx)
}

async function submitTx(txPromise, keypairs, processResponse) {
    try {
        const tx = await txPromise
        const signatures = signTransaction(tx, keypairs)
        const response = await submitTransaction(tx, signatures)
        const additional = processResponse(response)

        console.log(`Transaction ID: ${response.hash}, Status: ${response.status}, ${additional || 'Success'}`)
    } catch (e) {
        console.error(e)
        throw e
    }
}

function signTransaction(transaction, keypairs) {
    const txHash = transaction.hash()
    const shuffledSigners = keypairs.sort(() => 0.5 - Math.random())
    const selectedSigners = shuffledSigners.slice(0, getMajority(keypairs.length))
    const signatures = []
    for (const signer of selectedSigners) {
        const signature = signer.signDecorated(txHash)
        signatures.push(signature)
    }
    return signatures
}


/**
 * @param {Transaction} transaction - Transaction to submit
 * @param {xdr.DecoratedSignature[]} signatures - Signatures
 * @returns {Promise<TransactionResponse>} Transaction response
 */
async function submitTransaction(transaction, signatures = []) {
    const txXdr = transaction.toXDR() //Get the raw XDR for the transaction to avoid modifying the transaction object
    const tx = new Transaction(txXdr, network) //Create a new transaction object from the XDR
    signatures.forEach(signature => tx.addDecoratedSignature(signature))

    const requestFn = async (server) => await server.sendTransaction(tx)
    const submitResult = await makeServerRequest([rpcUrl], requestFn)
    if (submitResult.status !== 'PENDING') {
        const error = new Error(`Transaction submit failed: ${submitResult.status}`)
        error.status = submitResult.status
        error.errorResultXdr = submitResult.errorResult.toXDR('base64')
        error.hash = submitResult.hash
        throw error
    }
    const hash = submitResult.hash
    let response = await getTransaction(hash)
    let tries = 0
    while (response.status === 'PENDING' || response.status === 'NOT_FOUND') {
        response = await getTransaction(hash)
        if (++tries > 20)
            throw new Error('Transaction not found after 10 tries')
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
async function getTransaction(hash) {
    const requestFn = async (server) => await server.getTransaction(hash)
    return await makeServerRequest([rpcUrl], requestFn)
}

module.exports = {
    init,
    deployContract,
    installContract,
    deployAsset,
    mint,
    createAccount,
    getMajority,
    setTrust,
    getAccount,
    updateToMultiSigAccount,
    submitTx,
    submitTransaction,
    getTransaction
}