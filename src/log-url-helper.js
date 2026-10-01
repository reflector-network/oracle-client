//An rpc or data provider often puts its api key in the url path (https://provider/<key>), where no query-key pattern
//looks, so a url that reaches a log line or an error a consumer logs keeps its scheme, host and port only: no userinfo,
//path, query or fragment. reflector-shared utils/log-url-helper.js is the same module, and
//reflector-node src/utils/log-redaction.js and node-orchestrator logger-cleanup.js cut urls the same way

//an http or websocket url: scheme, optional userinfo, the host and port, then whatever follows up to a blank or a quote.
//file urls - stack frames - keep their paths
const urlPattern = /\b((?:https?|wss?):\/\/)(?:[^\s/?#@"'<>`]*@)?([^\s/?#"'<>`]*)[^\s"'<>`]*/gi

/**
 * @param {string} [url] - request url
 * @returns {string|undefined} scheme, host and port only; undefined when it is not a url
 */
function safeUrl(url) {
    if (typeof url !== 'string')
        return undefined
    try {
        const {protocol, host} = new URL(url)
        return `${protocol}//${host}`
    } catch (e) {
        return undefined
    }
}

/**
 * @param {any} text - free text
 * @returns {any} the text with every http and websocket url cut to its scheme, host and port; anything but a string
 * unchanged
 */
function cutUrls(text) {
    return typeof text === 'string' ? text.replace(urlPattern, '$1$2') : text
}

/**
 * A request failure as it may be logged: the message, stack, code and status, with every url cut. An axios error carries
 * the full url in its config, its request and its response, and the request headers and body besides
 * @param {any} err - request failure
 * @returns {any} a new Error; anything but an object unchanged
 */
function safeError(err) {
    if (!err || typeof err !== 'object')
        return err
    const safe = new Error(cutUrls(String(err.message ?? '')))
    safe.name = err.name
    safe.stack = cutUrls(String(err.stack ?? ''))
    if (err.code !== undefined)
        safe.code = err.code
    const status = err.response?.status ?? err.status
    if (status !== undefined)
        safe.status = status
    return safe
}

module.exports = {safeUrl, cutUrls, safeError}
