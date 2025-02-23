const net = require('net')
const EventEmitter = require('events')

const DEFAULT_RECONNECT_INTERVAL = 3 // seconds
const DEFAULT_TIMEOUT = 5 // seconds
const SECOND = 1000 // ms

class Device extends EventEmitter {
    constructor({ host, ip, port, parser, reconnectInterval = DEFAULT_RECONNECT_INTERVAL, responseTimeout = DEFAULT_TIMEOUT }) {
        super()
        if (ip) {
            console.warn('Device.ip has been deprecated. Please use Device.host instead.')
            if (!host) host = ip
        }
        this.host = host
        this.port = port
        this.reconnectInterval = reconnectInterval
        this.responseTimeout = responseTimeout * SECOND
        this.connected = false
        this.userClose = false
        this.parser = parser
        this._dataEmitter = this.emit.bind(this, 'data')
    }
    async connect(reconnect = false) {
        // Don't re-run if already connected
        if (this.connected) return Promise.resolve()
        this.userClose = false
        this.socket = new net.Socket()
        this.socket.on('close', this.onDisconnect.bind(this))
        this.socket.on('error', this.emit.bind(this, 'error'))
        this.socket.on('timeout', this.onTimeout.bind(this))
        // Keep connection alive
        this.socket.setKeepAlive(true)
        this.socket.setTimeout(this.responseTimeout)
        // Send immediately when write() is called, no buffering
        this.socket.setNoDelay()

        // Handle data piping
        this.dataPipe = this.socket
        if (this.parser) this.dataPipe = this.dataPipe.pipe(this.parser, { end: false })
        this.dataPipe.on('data', this._dataEmitter)

        await new Promise(resolve => {
            // Make sure previous connect timers have been cleared
            clearTimeout(this._connectTimeout)
            this._connectTimeout = setTimeout(this.onTimeout.bind(this, this.host, this.port), this.responseTimeout)
            this.socket.on('connect', () => {
                clearTimeout(this._connectTimeout)
            })
            // Update our resolver if this is an initial connection
            // so the client can await the `connect()` call correctly
            // in case of reconnects
            if (!reconnect) this.connectResolver = resolve
            this.socket.connect(this.port, this.host, this.onConnect.bind(this))
        })
    }
    async close() {
        // Signal the user intentionally closed the socket
        this.userClose = true
        // Prevent additional reconnects
        clearTimeout(this._reconnectTimer)
        if (this.socket) {
            await new Promise(res => this.socket.end(res))
        }
    }
    get ip() {
        console.warn('Device.ip has been deprecated. Please use Device.host instead.')
        return this.host
    }
    onConnect() {
        if (this.connectResolver) this.connectResolver()
        clearTimeout(this._reconnectTimer)
        this.connected = true
        this.emit('connect')
    }
    onDisconnect() {
        this.connected = false
        this.dataPipe.unpipe()
        this.dataPipe.removeAllListeners()
        clearTimeout(this._connectTimeout)
        // Automatically reconnect if we didn't close the connection manually
        if (this.reconnectInterval > 0 && !this.userClose) {
            this.emit('reconnect', `Connection at at ${this.host}:${this.port} lost! Attempting reconnect in ${this.reconnectInterval} seconds...`)
            clearTimeout(this._reconnectTimer)
            this._reconnectTimer = setTimeout(this.connect.bind(this, true), this.reconnectInterval * SECOND)
        }
        this.emit('close')
    }
    onTimeout(host, port) {
        this.emit('timeout')
        this.socket.destroy(new Error(`Timeout connecting to ${host}:${port}`))
    }
    // Make a request and wait for a response
    request(command, expectedResponse, errResponse) {
        const receipt = new Promise((res, rej) => {
            const receiver = msg => {
                msg = msg.toString()
                const success = msg.match(expectedResponse)
                const failure = errResponse ? msg.match(errResponse) : false
                if (!success && !failure) return
                clearTimeout(timeout)
                this.dataPipe.off('data', receiver)
                if (failure) rej(failure)
                else res(success)
            }
            const timeout = setTimeout(() => {
                this.dataPipe.off('data', receiver)
                rej(new Error('Timeout while waiting for response!'))
            }, this.responseTimeout)
            this.dataPipe.on('data', receiver)
        })
        this.send(command)
        return receipt
    }
    send(command) {
        return new Promise(res => this.socket.write(command, res))
    }
}

module.exports = { Device }