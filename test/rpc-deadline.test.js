/*eslint-disable no-undef */
const http = require('http')
const {rpc} = require('@stellar/stellar-sdk')

//the sdk's rpc.Server ignores a `timeout` passed to its constructor (17.0.1 forwards only headers); the deadline set on
//httpClient.defaults is what its fetch adapter turns into an AbortSignal, so this test pins the mechanism makeServerRequest relies on
describe('rpc deadline mechanism', () => {
    let server
    let url

    beforeAll(async () => {
        server = http.createServer(() => {}) //accepts the request and never answers
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
        url = `http://127.0.0.1:${server.address().port}`
    })

    afterAll(async () => {
        server.closeAllConnections()
        await new Promise(resolve => server.close(resolve))
    })

    test('a server that never answers fails at the deadline set on the http client', async () => {
        const rpcServer = new rpc.Server(url, {allowHttp: true, timeout: 300})
        rpcServer.httpClient.defaults.timeout = 300
        const start = Date.now()
        await expect(rpcServer.getLatestLedger()).rejects.toThrow(/timeout of 300 ?ms exceeded/)
        expect(Date.now() - start).toBeLessThan(3000)
    })
})
