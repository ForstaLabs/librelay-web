// vim: ts=4:sw=4:expandtab
/* global dcodeIO */

(function(){
    'use strict';

    const ns = self.relay = self.relay || {};

    class Request {
        constructor(wsr, options) {
            this.wsr = wsr;
            this.verb = options.verb || options.type;
            this.path = options.path || options.url;
            this.body = options.body || options.data;
            this.success = options.success;
            this.error = options.error;
            this.id = options.id;
            if (!this.id) {
                const bits = new Uint32Array(2);
                crypto.getRandomValues(bits);
                this.id = dcodeIO.Long.fromBits(bits[0], bits[1], true);
            }
            if (this.body === undefined) {
                this.body = null;
            }
        }
    }

    class IncomingWebSocketRequest extends Request {
        respond(status, message) {
            const msg = new ns.protobuf.WebSocketMessage({
                type: ns.protobuf.WebSocketMessage.Type.RESPONSE,
                response: {
                    id: this.id,
                    message,
                    status
                }
            }).encode().toArrayBuffer();
            return this.wsr.send(msg);
        }
    }

    class OutgoingWebSocketRequest extends Request {
        send() {
            const msg = new ns.protobuf.WebSocketMessage({
                type: ns.protobuf.WebSocketMessage.Type.REQUEST,
                request: {
                    verb: this.verb,
                    path: this.path,
                    body: this.body,
                    id: this.id
                }
            }).encode().toArrayBuffer();
            return this.wsr.send(msg);
        }
    }

    class KeepAlive {
        constructor(websocketResource, opts) {
            if (!(websocketResource instanceof WebSocketResource)) {
                throw new TypeError('KeepAlive expected a WebSocketResource');
            }
            opts = opts || {};
            this.path = opts.path;
            if (this.path === undefined) {
                this.path = '/';
            }
            this.disconnect = opts.disconnect;
            if (this.disconnect === undefined) {
                this.disconnect = true;
            }
            this.wsr = websocketResource;
            this._onNeedTickle = this.onNeedTickle.bind(this);
            this._onNeedClose = this.onNeedClose.bind(this);
        }

        clear() {
            clearTimeout(this.tickleTimer);
            clearTimeout(this.closeTimer);
        }

        reset() {
            this.clear();
            this.tickleTimer = setTimeout(this._onNeedTickle, 45000);
        }

        onNeedTickle() {
            this.wsr.sendRequest({
                verb: 'GET',
                path: this.path,
                success: this.reset.bind(this)
            });
            if (this.disconnect) {
                // automatically disconnect if server doesn't ack
                this.closeTimer = setTimeout(this._onNeedClose, 5000);
            } else {
                this.reset();
            }
        }

        onNeedClose() {
            clearTimeout(this.tickleTimer);
            this.wsr.close(3001, 'No response to keepalive request');
        }
    }

    class WebSocketResource {

        constructor(url, opts) {
            this.url = url;
            this.socket = null;
            this._sendQueue = [];
            this._outgoingRequests = new Map();
            this._listeners = [];
            this._connectCount = 0;
            opts = opts || {};
            this.handleRequest = opts.handleRequest;
            if (typeof this.handleRequest !== 'function') {
                this.handleRequest = request => request.respond(404, 'Not found');
            }
            if (opts.keepalive) {
                this.keepalive = new KeepAlive(this, {
                    path: opts.keepalive.path,
                    disconnect: opts.keepalive.disconnect
                });
                this.addEventListener('close', this.keepalive.clear.bind(this.keepalive));
            }
            this.addEventListener('message', this.onMessage.bind(this));
        }

        addEventListener(event, callback) {
            this._listeners.push([event, callback]);
            if (this.socket) {
                this.socket.addEventListener(event, callback);
            }
        }

        removeEventListener(event, callback) {
            if (this.socket) {
                this.socket.removeEventListener(event, callback);
            }
            this._listeners = this._listeners.filter(x => !(x[0] === event && x[1] === callback));
        }

        async connect() {
            this.close();
            this._connectCount++;
            if (this._lastDuration && this._lastDuration < 10000) {
                const delay = Math.max(5, Math.random() * this._connectCount);
                console.warn('Throttling websocket reconnect:', delay);
                await ns.util.sleep(delay);
            }
            const ws = new WebSocket(this.url);
            this._lastConnect = Date.now();
            await new Promise((resolve, reject) => {
                ws.addEventListener('open', resolve);
                ws.addEventListener('error', reject);
            });
            this.socket = ws;
            for (const x of this._listeners) {
                this.socket.addEventListener(x[0], x[1]);
            }
            if (this.keepalive) {
                this.keepalive.reset();
            }
            while (this._sendQueue.length) {
                console.warn("Dequeuing deferred websocket message");
                this.socket.send(this._sendQueue.shift());
            }
        }

        close(code, reason) {
            if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
                if (!code) {
                    code = 3000;
                }
                this._lastDuration = Date.now() - this._lastConnect;
                this.socket.close(code, reason);
            }
            this.socket = null;
        }

        sendRequest(options) {
            const request = new OutgoingWebSocketRequest(this, options);
            this._outgoingRequests.set(request.id.toNumber(), request);
            request.send();
            return request;
        }

        send(data) {
            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                this.socket.send(data);
            } else {
                this._sendQueue.push(data);
            }
        }

        async onMessage(encodedMsg) {
            if (this.keepalive) {
                this.keepalive.reset();
            }
            const reader = new FileReader();
            await new Promise((resolve, reject) => {
                reader.onload = resolve;
                reader.onabort = reader.onerror = reject;
                reader.readAsArrayBuffer(encodedMsg.data);
            });
            const message = ns.protobuf.WebSocketMessage.decode(reader.result);
            if (message.type === ns.protobuf.WebSocketMessage.Type.REQUEST) {
                await this.handleRequest(new IncomingWebSocketRequest(this, {
                    verb: message.request.verb,
                    path: message.request.path,
                    body: message.request.body,
                    id: message.request.id
                }));
            } else if (message.type === ns.protobuf.WebSocketMessage.Type.RESPONSE) {
                const response = message.response;
                const key = response.id.toNumber();
                if (this._outgoingRequests.has(key)) {
                    const request = this._outgoingRequests.get(key);
                    this._outgoingRequests.delete(key);
                    request.response = response;
                    let callback;
                    if (response.status >= 200 && response.status < 300) {
                        callback = request.success;
                    } else {
                        callback = request.error;
                    }
                    if (typeof callback === 'function') {
                        await callback(response.message, response.status, request);
                    }
                } else {
                    console.error('Unmatched websocket response', key, message, encodedMsg);
                    throw ReferenceError('Unmatched WebSocket Response');
                }
            } else {
                throw new TypeError(`Unhandled message type: ${message.type}`);
            }
        }
    }

    ns.WebSocketResource = WebSocketResource;
}());
