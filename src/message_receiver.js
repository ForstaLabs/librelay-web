// vim: ts=4:sw=4:expandtab
/* global libsignal dcodeIO */

(function() {

    const ns = self.relay = self.relay || {};

    ns.MessageReceiver = class MessageReceiver extends ns.EventTarget {

        constructor(signal, addr, deviceId, signalingKey, noWebSocket) {
            super();
            console.assert(signal && addr && deviceId && signalingKey);
            this.signal = signal;
            this.addr = addr;
            this.deviceId = deviceId;
            this.signalingKey = signalingKey;
            this.setBusy();
            if (!noWebSocket) {
                const url = this.signal.getMessageWebSocketURL();
                this.wsr = new ns.WebSocketResource(url, {
                    handleRequest: request => ns.queueAsync(this, this.handleRequest.bind(this, request)),
                    keepalive: {
                        path: '/v1/keepalive',
                        disconnect: true
                    }
                });
                this.wsr.addEventListener('close', this.onSocketClose.bind(this));
                this.wsr.addEventListener('error', this.onSocketError.bind(this));
            }
        }

        setBusy() {
            /* Users can await the .idle property to avoid working while incoming
             * messages are being processed. */
            if (this.busy) {
                clearTimeout(this._idleTimeout);
                return;  // Do not perturb existing idle promise.
            }
            this.busy = true;
            console.debug("Message Receiver Busy");
            this.idle = new Promise(resolve => {
                this.setIdle = () => {
                    clearTimeout(this._idleTimeout);
                    this._idleTimeout = setTimeout(() => {
                        this.busy = false;
                        this._idleTimeout = undefined;
                        console.debug("Message Receiver Idle");
                        resolve();
                    }, 1000);
                };
            });
        }

        async checkRegistration() {
            try {
                // possible auth or network issue. Make a request to confirm
                await this.signal.getDevices();
            } catch(e) {
                if (navigator.onLine && !(e instanceof ns.NetworkError)) {
                    console.error("Invalid network state:", e);
                    const ev = new Event('error');
                    ev.error = e;
                    await this.dispatchEvent(ev);
                }
            }
        }

        async connect() {
            if (this._closing) {
                throw new Error("Invalid State: Already Closed");
            }
            if (this._connecting) {
                console.warn("Duplicate connect detected");
            } else {
                this._connecting = (async () => {
                    let attempts = 0;
                    while (!this._closing) {
                        await this.waitTillOnline();
                        try {
                            await this.wsr.connect();
                            if (attempts) {
                                console.info("Reconnected websocket");
                            }
                            return;
                        } catch(e) {
                            await this.checkRegistration();
                            console.warn(`Connect problem (${attempts++} attempts)`);
                        }
                    }
                })();
            }
            await this._connecting;
            this._connecting = null;
        }

        async waitTillOnline() {
            if (navigator.onLine) {
                return;
            }
            await new Promise(resolve => {
                const singleResolve = ev => {
                    resolve(ev);
                    removeEventListener('online', singleResolve);
                };
                addEventListener('online', singleResolve);
            });
        }

        close() {
            this._closing = true;
            this.wsr.close();
        }

        async drain() {
            /* Pop messages directly from the messages API until it's empty. */
            if (this.wsr) {
                throw new TypeError("Fetch is invalid when websocket is in use");
            }
            this.setBusy();
            let more;
            do {
                const data = await this.signal.request({call: 'messages'});
                more = data.more;
                const deleting = [];
                for (const envelope of data.messages) {
                    if (envelope.content) {
                        envelope.content = dcodeIO.ByteBuffer.fromBase64(envelope.content);
                    }
                    if (envelope.message) {
                        envelope.legacyMessage = dcodeIO.ByteBuffer.fromBase64(envelope.message);
                    }
                    await this.handleEnvelope(envelope);
                    deleting.push(this.signal.request({
                        call: 'messages',
                        httpType: 'DELETE',
                        urlParameters: `/${envelope.source}/${envelope.timestamp}`
                    }));
                }
                await Promise.all(deleting);
            } while(more);
            this.setIdle();
        }

        onSocketError(ev) {
            console.warn('Message Receiver WebSocket error:', ev);
        }

        async onSocketClose(ev) {
            if (this._closing) {
                return;
            }
            console.warn('Websocket closed:', ev.code, ev.reason || '');
            await this.checkRegistration();
            if (!this._closing) {
                await this.connect();
            }
        }

        async handleRequest(request) {
            if (request.path === '/api/v1/queue/empty') {
                console.debug("WebSocket queue empty");
                request.respond(200, 'OK');
                this.setIdle();
                return;
            }
            if (request.path !== '/api/v1/message' || request.verb !== 'PUT') {
                console.error("Expected PUT '/api/v1/message', but got:", request.path);
                request.respond(400, 'Invalid Resource');
                throw new Error('Invalid WebSocket resource received');
            }
            this.setBusy();
            try {
                let envelope;
                try {
                    const data = await ns.crypto.decryptWebsocketMessage(request.body, this.signalingKey);
                    envelope = ns.protobuf.Envelope.decode(data);
                    envelope.timestamp = envelope.timestamp.toNumber();
                } catch(e) {
                    console.error("Error handling incoming message:", e);
                    request.respond(500, 'Bad encrypted websocket message');
                    const ev = new Event('error');
                    ev.error = e;
                    await this.dispatchEvent(ev);
                    throw e;
                }
                try {
                    await this.handleEnvelope(envelope);
                } finally {
                    request.respond(200, 'OK');
                }
            } finally {
                this.setIdle();
            }
        }

        async handleEnvelope(envelope, reentrant, forceAcceptKeyChange) {
            let handler;
            if (envelope.type === ns.protobuf.Envelope.Type.RECEIPT) {
                handler = this.handleDeliveryReceipt;
            } else if (envelope.content) {
                handler = this.handleContentMessage;
            } else if (envelope.legacyMessage) {
                handler = this.handleLegacyMessage;
            } else {
                throw new Error('Received message with no content and no legacyMessage');
            }
            try {
                await handler.call(this, envelope);
            } catch(e) {
                if (e.name === 'MessageCounterError') {
                    console.warn("Ignoring MessageCounterError for:", envelope);
                    return;
                } else if (e instanceof ns.IncomingIdentityKeyError && !reentrant) {
                    const keyChangeEvent = new ns.KeyChangeEvent(e, envelope);
                    if (forceAcceptKeyChange) {
                        await keyChangeEvent.accept();
                    } else {
                        await this.dispatchEvent(keyChangeEvent);
                    }
                    if (e.accepted) {
                        envelope.keyChange = true;
                        await this.handleEnvelope(envelope, /*reentrant*/ true);
                    }
                } else if (e instanceof ns.RelayError) {
                    console.warn("Supressing RelayError:", e);
                } else {
                    const ev = new Event('error');
                    ev.error = e;
                    ev.proto = envelope;
                    await this.dispatchEvent(ev);
                    throw e;
                }
            }
        }

        async handleDeliveryReceipt(envelope) {
            const ev = new Event('receipt');
            ev.proto = envelope;
            await this.dispatchEvent(ev);
        }

        unpad(paddedPlaintext) {
            paddedPlaintext = new Uint8Array(paddedPlaintext);
            let plaintext;
            for (let i = paddedPlaintext.length - 1; i; i--) {
                if (paddedPlaintext[i] == 0x80) {
                    plaintext = new Uint8Array(i);
                    plaintext.set(paddedPlaintext.subarray(0, i));
                    plaintext = plaintext.buffer;
                    break;
                } else if (paddedPlaintext[i] !== 0x00) {
                    throw new Error('Invalid padding');
                }
            }
            return plaintext;
        }

        async decrypt(envelope, ciphertext) {
            const addr = new libsignal.SignalProtocolAddress(envelope.source, envelope.sourceDevice);
            const sessionCipher = new libsignal.SessionCipher(ns.store, addr);
            const envTypes = ns.protobuf.Envelope.Type;
            if (envelope.type === envTypes.CIPHERTEXT) {
                return await sessionCipher.decryptWhisperMessage(ciphertext).then(this.unpad);
            } else if (envelope.type === envTypes.PREKEY_BUNDLE) {
                return await this.decryptPreKeyWhisperMessage(ciphertext, sessionCipher, addr);
            } else {
                throw new TypeError("Unknown message type:" + envelope.type);
            }
        }

        async decryptPreKeyWhisperMessage(ciphertext, sessionCipher, address) {
            try {
                return this.unpad(await sessionCipher.decryptPreKeyWhisperMessage(ciphertext));
            } catch(e) {
                if (e.message === 'Unknown identity key') {
                    const cipherBuf = ciphertext instanceof ArrayBuffer ? ciphertext :
                        ciphertext.toArrayBuffer();
                    throw new ns.IncomingIdentityKeyError(address.toString(), cipherBuf,
                                                          e.identityKey);
                }
                throw e;
            }
        }

        async handleSentMessage(sent, envelope) {
            if (sent.message.flags & ns.protobuf.DataMessage.Flags.END_SESSION) {
                await this.handleEndSession(sent.destination);
            }
            await this.processDecrypted(sent.message, this.addr);
            const ev = new Event('sent');
            ev.data = {
                source: envelope.source,
                sourceDevice: envelope.sourceDevice,
                timestamp: sent.timestamp.toNumber(),
                destination: sent.destination,
                message: sent.message
            };
            if (sent.expirationStartTimestamp) {
              ev.data.expirationStartTimestamp = sent.expirationStartTimestamp.toNumber();
            }
            await this.dispatchEvent(ev);
        }

        async handleDataMessage(message, envelope, content) {
            if (message.flags & ns.protobuf.DataMessage.Flags.END_SESSION) {
                await this.handleEndSession(envelope.source);
            }
            await this.processDecrypted(message, envelope.source);
            const ev = new Event('message');
            ev.data = {
                timestamp: envelope.timestamp,
                source: envelope.source,
                sourceDevice: envelope.sourceDevice,
                message,
                keyChange: envelope.keyChange
            };
            await this.dispatchEvent(ev);
        }

        async handleLegacyMessage(envelope) {
            const data = await this.decrypt(envelope, envelope.legacyMessage);
            const message = ns.protobuf.DataMessage.decode(data);
            await this.handleDataMessage(message, envelope);
        }

        async handleContentMessage(envelope) {
            const data = await this.decrypt(envelope, envelope.content);
            const content = ns.protobuf.Content.decode(data);
            if (content.syncMessage) {
                await this.handleSyncMessage(content.syncMessage, envelope, content);
            } else if (content.dataMessage) {
                await this.handleDataMessage(content.dataMessage, envelope, content);
            } else {
                throw new TypeError('Got content message with no dataMessage or syncMessage');
            }
        }

        async handleSyncMessage(message, envelope, content) {
            if (envelope.source !== this.addr) {
                throw new ReferenceError('Received sync message from another addr');
            }
            if (envelope.sourceDevice == this.deviceId) {
                throw new ReferenceError('Received sync message from our own device');
            }
            if (message.sent) {
                await this.handleSentMessage(message.sent, envelope);
            } else if (message.read) {
                await this.handleRead(message.read, envelope);
            } else if (message.contacts) {
                console.error("Deprecated contact sync message:", message, envelope, content);
                throw new TypeError('Deprecated contact sync message');
            } else if (message.groups) {
                console.error("Deprecated group sync message:", message, envelope, content);
                throw new TypeError('Deprecated group sync message');
            } else if (message.blocked) {
                this.handleBlocked(message.blocked, envelope);
            } else if (message.request) {
                console.error("Deprecated group request sync message:", message, envelope, content);
                throw new TypeError('Deprecated group request sync message');
            } else {
                console.error("Empty sync message:", message, envelope, content);
            }
        }

        async handleRead(read, envelope) {
            for (const x of read) {
                const ev = new Event('read');
                ev.timestamp = envelope.timestamp;
                ev.read = {
                    timestamp: x.timestamp.toNumber(),
                    sender: x.sender,
                    source: envelope.source,
                    sourceDevice: envelope.sourceDevice
                };
                await this.dispatchEvent(ev);
            }
        }

        handleBlocked(blocked) {
            throw new Error("UNSUPPORTRED");
        }

        async handleAttachment(attachment) {
            const encData = await this.signal.getAttachment(attachment.id.toString());
            const key = attachment.key.toArrayBuffer();
            attachment.data = await ns.crypto.decryptAttachment(encData, key);
        }

        tryMessageAgain(from, ciphertext) {
            const address = libsignal.SignalProtocolAddress.fromString(from);
            const sessionCipher = new libsignal.SessionCipher(ns.store, address);
            console.warn('retrying prekey whisper message');
            return this.decryptPreKeyWhisperMessage(ciphertext, sessionCipher, address).then(function(plaintext) {
                const finalMessage = ns.protobuf.DataMessage.decode(plaintext);
                let p = Promise.resolve();
                if ((finalMessage.flags & ns.protobuf.DataMessage.Flags.END_SESSION)
                        == ns.protobuf.DataMessage.Flags.END_SESSION &&
                        finalMessage.sync !== null) {
                        p = this.handleEndSession(address.getName());
                }
                return p.then(function() {
                    return this.processDecrypted(finalMessage);
                }.bind(this));
            }.bind(this));
        }

        async handleEndSession(addr) {
            const deviceIds = await ns.store.getDeviceIds(addr);
            await Promise.all(deviceIds.map(deviceId => {
                const address = new libsignal.SignalProtocolAddress(addr, deviceId);
                const sessionCipher = new libsignal.SessionCipher(ns.store, address);
                console.warn('Closing session for', addr, deviceId);
                return sessionCipher.closeOpenSessionForDevice();
            }));
        }

        async processDecrypted(msg, source) {
            // Now that its decrypted, validate the message and clean it up for consumer processing
            // Note that messages may (generally) only perform one action and we ignore remaining fields
            // after the first action.
            if (msg.flags === null) {
                msg.flags = 0;
            }
            if (msg.expireTimer === null) {
                msg.expireTimer = 0;
            }
            if (msg.flags & ns.protobuf.DataMessage.Flags.END_SESSION) {
                return msg;
            }
            if (msg.group) {
                // We should blow up here very soon. XXX
                console.error("Legacy group message detected", msg);
            }
            if (msg.attachments) {
                await Promise.all(msg.attachments.map(this.handleAttachment.bind(this)));
            }
            return msg;
        }
    };
})();
