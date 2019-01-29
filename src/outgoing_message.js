// vim: ts=4:sw=4:expandtab
/* global libsignal */

(function () {
    'use strict';

    const ns = self.relay = self.relay || {};

    ns.OutgoingMessage = class OutgoingMessage {

        constructor(signal, timestamp, message) {
            console.assert(message instanceof ns.protobuf.Content);
            this.signal = signal;
            this.timestamp = timestamp;
            this.message = message;
            this.sent = [];
            this.errors = [];
            this.created = Date.now();
            this._listeners = {};
        }

        async getOurAddr() {
            if (this._ourAddr === undefined) {
                this._ourAddr = await ns.store.getState('addr');
            }
            return this._ourAddr;
        }

        async getOurDeviceId() {
            if (this._ourDeviceId === undefined) {
                this._ourDeviceId = await ns.store.getState('deviceId');
            }
            return this._ourDeviceId;
        }

        on(event, callback) {
            let handlers = this._listeners[event];
            if (!handlers) {
                handlers = this._listeners[event] = [];
            }
            handlers.push(callback);
        }

        async _emit(event) {
            const handlers = this._listeners[event];
            if (!handlers) {
                return;
            }
            const args = Array.from(arguments).slice(1);
            for (const callback of handlers) {
                try {
                    await callback.apply(this, args);
                } catch(e) {
                    console.error("Event callback error:", e);
                }
            }
        }

        async _emitError(addr, reason, error) {
            error.addr = addr;
            error.reason = reason;
            await this._emitErrorEntry({
                timestamp: Date.now(),
                error
            });
        }

        async _emitErrorEntry(entry) {
            this.errors.push(entry);
            await this._emit('error', entry);
        }

        async _emitSent(addr) {
            await this._emitSentEntry({
                timestamp: Date.now(),
                addr
            });
        }

        async _emitSentEntry(entry) {
            this.sent.push(entry);
            await this._emit('sent', entry);
        }

        async _handleIdentityKeyError(e, options) {
            options = options || {};
            if (!(e instanceof libsignal.UntrustedIdentityKeyError)) {
                throw new TypeError("UntrustedIdentityKeyError required");
            }
            if (!options.forceThrow) {
                await this._emit('keychange', e);
            }
            if (!e.accepted) {
                throw e;
            }
        }

        async getKeysForAddr(addr, updateDevices, reentrant) {
            const _this = this;
            const isSelf = addr === await this.getOurAddr();
            const ourDeviceId = isSelf ? await this.getOurDeviceId() : null;
            async function handleResult(response) {
                await Promise.all(response.devices.map(async device => {
                    if (isSelf && device.deviceId === ourDeviceId) {
                        console.debug("Skipping prekey processing for self");
                        return;
                    }
                    device.identityKey = response.identityKey;
                    const address = new libsignal.ProtocolAddress(addr, device.deviceId);
                    const builder = new libsignal.SessionBuilder(ns.store, address);
                    try {
                        await builder.initOutgoing(device);
                    } catch(e) {
                        if (e instanceof libsignal.UntrustedIdentityKeyError) {
                            await _this._handleIdentityKeyError(e, {forceThrow: reentrant});
                            await _this.getKeysForAddr(addr, updateDevices, /*reentrant*/ true);
                        } else {
                            throw e;
                        }
                    }
                }));
            }
            if (!updateDevices) {
                try {
                    await handleResult(await this.signal.getKeysForAddr(addr));
                } catch(e) {
                    if (e instanceof ns.ProtocolError && e.code === 404) {
                        console.warn("Unregistered address (no devices):", addr);
                        await _this.removeDeviceIdsForAddr(addr);
                    } else {
                        throw e;
                    }
                }
            } else {
                await Promise.all(updateDevices.map(async device => {
                    try {
                        await handleResult(await _this.signal.getKeysForAddr(addr, device));
                    } catch(e) {
                        if (e instanceof ns.ProtocolError && e.code === 404) {
                            console.warn("Unregistered device:", device);
                            await _this.removeDeviceIdsForAddr(addr, [device]);
                        } else {
                            throw e;
                        }
                    }
                }));
            }
        }

        async transmitMessage(addr, messages, timestamp) {
            try {
                return await this.signal.sendMessages(addr, messages, timestamp);
            } catch(e) {
                if (e instanceof ns.ProtocolError && e.code === 404) {
                    throw new ns.UnregisteredUserError(addr, e);
                }
                throw e;
            }
        }

        getPaddedMessageLength(messageLength) {
            const messageLengthWithTerminator = messageLength + 1;
            let messagePartCount = Math.floor(messageLengthWithTerminator / 160);
            if (messageLengthWithTerminator % 160 !== 0) {
                messagePartCount++;
            }
            return messagePartCount * 160;
        }

        getPaddedMessageBuffer() {
            const messageBuffer = this.message.toArrayBuffer();
            const paddedBytes = new Uint8Array(this.getPaddedMessageLength(messageBuffer.byteLength + 1) - 1);
            paddedBytes.set(new Uint8Array(messageBuffer));
            paddedBytes[messageBuffer.byteLength] = 0x80;
            return paddedBytes.buffer;
        }

        async _sendToAddr(addr, recurse) {
            const deviceIds = await ns.store.getDeviceIds(addr);
            const paddedMessage = this.getPaddedMessageBuffer();
            let messages;
            let attempts = 0;
            const ciphers = {};
            do {
                try {
                    messages = await Promise.all(deviceIds.map(async id => {
                        const address = new libsignal.ProtocolAddress(addr, id);
                        const sessionCipher = new libsignal.SessionCipher(ns.store, address);
                        ciphers[address.deviceId] = sessionCipher;
                        return this.toJSON(address, await sessionCipher.encrypt(paddedMessage));
                    }));
                } catch(e) {
                    if (e instanceof libsignal.UntrustedIdentityKeyError) {
                        await this._handleIdentityKeyError(e, {forceThrow: !!attempts});
                    } else {
                        this._emitError(addr, "Failed to create message", e);
                        return;
                    }
                }
            } while(!messages && !attempts++);
            try {
                await this.transmitMessage(addr, messages, this.timestamp);
            } catch(e) {
                if (e instanceof ns.ProtocolError && (e.code === 410 || e.code === 409)) {
                    if (!recurse) {
                        this._emitError(addr, "Hit retry limit attempting to reload device list", e);
                        return;
                    }
                    if (e.code === 409) {
                        await this.removeDeviceIdsForAddr(addr, e.response.extraDevices);
                    } else {
                        await Promise.all(e.response.staleDevices.map(x => ciphers[x].closeOpenSession()));
                    }
                    const resetDevices = e.code === 410 ? e.response.staleDevices : e.response.missingDevices;
                    // Optimize first-contact key lookup (just get them all at once).
                    const updateDevices = messages.length ? resetDevices : undefined;
                    await this.getKeysForAddr(addr, updateDevices);
                    await this._sendToAddr(addr, /*recurse*/ (e.code === 409));
                } else if (e.code === 401 || e.code === 403) {
                    throw e;
                } else {
                    this._emitError(addr, "Failed to send message", e);
                    return;
                }
            }
            this._emitSent(addr);
        }

        async _sendToDevice(addr, deviceId, recurse) {
            const protoAddr = new libsignal.ProtocolAddress(addr, deviceId);
            const sessionCipher = new libsignal.SessionCipher(ns.store, protoAddr);
            if (!(await sessionCipher.hasOpenSession())) {
                await this.getKeysForAddr(addr, [deviceId]);
            }
            let encryptedMessage;
            let attempts = 0;
            do {
                try {
                    encryptedMessage = await sessionCipher.encrypt(this.getPaddedMessageBuffer());
                } catch(e) {
                    if (e instanceof libsignal.UntrustedIdentityKeyError) {
                        await this._handleIdentityKeyError(e, {forceThrow: !!attempts});
                    } else {
                        this._emitError(addr, "Failed to create message", e);
                        return;
                    }
                }
            } while(!encryptedMessage && !attempts++);
            const messageBundle = this.toJSON(protoAddr, encryptedMessage, this.timestamp);
            try {
                await this.signal.sendMessage(addr, deviceId, messageBundle);
            } catch(e) {
                if (e instanceof ns.ProtocolError && e.code === 410) {
                    sessionCipher.closeOpenSession();  // Force getKeysForAddr on next call.
                    await this._sendToDevice(addr, deviceId, /*recurse*/ false);
                } else if (e.code === 401 || e.code === 403) {
                    throw e;
                } else {
                    this._emitError(addr, "Failed to send message", e);
                    return;
                }
            }
            this._emitSent(addr);
        }

        toJSON(address, encryptedMsg, timestamp) {
            return {
                type: encryptedMsg.type,
                destinationDeviceId: address.deviceId,
                destinationRegistrationId: encryptedMsg.registrationId,
                content: btoa(encryptedMsg.body),
                timestamp
            };
        }

        async initSessions(encodedAddr) {
            // Scan the address for devices that have closed sessions and fetch
            // new key material for said devices so we can encrypt messages for
            // them.
            const addrTuple = ns.util.unencodeAddr(encodedAddr);
            const addr = addrTuple[0];
            const deviceId = addrTuple[1];
            const deviceIds = deviceId ? [deviceId] : await ns.store.getDeviceIds(addr);
            if (!deviceIds.length) {
                return;
            }
            const stale = (await Promise.all(deviceIds.map(async id => {
                const address = new libsignal.ProtocolAddress(addr, id);
                const sessionCipher = new libsignal.SessionCipher(ns.store, address);
                return !(await sessionCipher.hasOpenSession()) ? id : null;
            }))).filter(x => x !== null);
            if (stale.length === deviceIds.length && !deviceId) {
                await this.getKeysForAddr(addr);  // Get them all at once.
            } else if (stale.length) {
                await this.getKeysForAddr(addr, stale);
            }
        }

        async removeDeviceIdsForAddr(addr, deviceIdsToRemove) {
            if (!deviceIdsToRemove) {
                await ns.store.removeAllSessions(addr);
            } else {
                for (const id of deviceIdsToRemove) {
                    const encodedAddr = addr + "." + id;
                    await ns.store.removeSession(encodedAddr);
                }
            }
        }

        async sendToAddr(encodedAddr) {
            try {
                await this.initSessions(encodedAddr);
            } catch(e) {
                this._emitError(encodedAddr, "Failed to init sessions for: " + encodedAddr, e);
                throw e;
            }
            const addrTuple = ns.util.unencodeAddr(encodedAddr);
            const addr = addrTuple[0];
            const deviceId = addrTuple[1];
            try {
                if (deviceId) {
                    await this._sendToDevice(addr, deviceId, /*recurse*/ true);
                } else {
                    await this._sendToAddr(addr, /*recurse*/ true);
                }
            } catch(e) {
                this._emitError(encodedAddr, "Failed to send to address " + encodedAddr, e);
                throw e;
            }
        }
    };
})();
