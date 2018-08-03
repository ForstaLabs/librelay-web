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

        async emit(event) {
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

        async emitError(addr, reason, error) {
            if (!error || error instanceof ns.ProtocolError && error.code !== 404) {
                error = new ns.OutgoingMessageError(addr, this.message.toArrayBuffer(),
                                                    this.timestamp, error);
            }
            error.addr = addr;
            error.reason = reason;
            const entry = {
                timestamp: Date.now(),
                error
            };
            this.errors.push(entry);
            await this.emit('error', entry);
        }

        async emitSent(addr) {
            const entry = {
                timestamp: Date.now(),
                addr
            };
            this.sent.push(entry);
            await this.emit('sent', entry);
        }

        async _sendToAddr(addr, recurse) {
            const deviceIds = await ns.store.getDeviceIds(addr);
            return await this.doSendMessage(addr, deviceIds, recurse, {});
        }

        async _handleIdentityKeyError(e, options) {
            options = options || {};
            if (!(e instanceof libsignal.UntrustedIdentityKeyError)) {
                throw new TypeError("UntrustedIdentityKeyError required");
            }
            const keyError = new ns.OutgoingIdentityKeyError(e.addr, this.message.toArrayBuffer(),
                                                             this.timestamp, e.identityKey);
            keyError.stack = e.stack;
            keyError.message = e.message;
            if (!options.forceThrow) {
                await this.emit('keychange', keyError);
            }
            if (!keyError.accepted) {
                throw keyError;
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
                    device.identityKey = response.identityKey; // XXX used anymore?
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

        async transmitMessage(addr, jsonData, timestamp) {
            try {
                return await this.signal.sendMessages(addr, jsonData, timestamp);
            } catch(e) {
                if (e instanceof ns.ProtocolError && (e.code !== 409 && e.code !== 410)) {
                    // 409 and 410 should bubble and be handled by doSendMessage
                    // 404 should throw UnregisteredUserError
                    // all other network errors can be retried later.
                    if (e.code === 404) {
                        throw new ns.UnregisteredUserError(addr, e);
                    }
                    throw new ns.SendMessageError(addr, jsonData, e, timestamp);
                }
                throw e;
            }
        }

        getPaddedMessageLength(messageLength) {
            var messageLengthWithTerminator = messageLength + 1;
            var messagePartCount = Math.floor(messageLengthWithTerminator / 160);
            if (messageLengthWithTerminator % 160 !== 0) {
                messagePartCount++;
            }
            return messagePartCount * 160;
        }

        async doSendMessage(addr, deviceIds, recurse) {
            const ciphers = {};
            const plaintext = this.message.toArrayBuffer();
            const paddedtext = new Uint8Array(this.getPaddedMessageLength(plaintext.byteLength + 1) - 1);
            paddedtext.set(new Uint8Array(plaintext));
            paddedtext[plaintext.byteLength] = 0x80;
            let messages;
            let attempts = 0;
            do {
                try {
                    messages = await Promise.all(deviceIds.map(async id => {
                        const address = new libsignal.ProtocolAddress(addr, id);
                        const sessionCipher = new libsignal.SessionCipher(ns.store, address);
                        ciphers[address.deviceId] = sessionCipher;
                        return this.toJSON(address, await sessionCipher.encrypt(paddedtext.buffer));
                    }));
                } catch(e) {
                    if (e instanceof libsignal.UntrustedIdentityKeyError) {
                        await this._handleIdentityKeyError(e, {forceThrow: !!attempts});
                    } else {
                        this.emitError(addr, "Failed to create message", e);
                        return;
                    }
                }
            } while(!messages && !attempts++);
            try {
                await this.transmitMessage(addr, messages, this.timestamp);
            } catch(e) {
                if (e instanceof ns.ProtocolError && (e.code === 410 || e.code === 409)) {
                    if (!recurse) {
                        this.emitError(addr, "Hit retry limit attempting to reload device list", e);
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
                    this.emitError(addr, "Failed to send message", e);
                    return;
                }
            }
            this.emitSent(addr);
        }

        toJSON(address, encryptedMsg) {
            return {
                type: encryptedMsg.type,
                destinationDeviceId: address.deviceId,
                destinationRegistrationId: encryptedMsg.registrationId,
                content: btoa(encryptedMsg.body)
            };
        }

        async reopenClosedSessions(addr) {
            // Scan the address for devices that have closed sessions and fetch
            // new key material for said devices so we can encrypt messages for
            // them.
            const deviceIds = await ns.store.getDeviceIds(addr);
            if (!deviceIds.length) {
                return;
            }
            const stale = (await Promise.all(deviceIds.map(async id => {
                const address = new libsignal.ProtocolAddress(addr, id);
                const sessionCipher = new libsignal.SessionCipher(ns.store, address);
                return !(await sessionCipher.hasOpenSession()) ? id : null;
            }))).filter(x => x !== null);
            if (stale.length === deviceIds.length) {
                console.debug("Reopening ALL sessions for:", addr);
                await this.getKeysForAddr(addr);  // Get them all at once.
            } else if (stale.length) {
                console.debug(`Reopening ${stale.length} sessions for:`, addr);
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

        async sendToAddr(addr) {
            try {
                await this.reopenClosedSessions(addr);
            } catch(e) {
                this.emitError(addr, "Failed to reopen sessions for: " + addr, e);
                throw e;
            }
            try {
                await this._sendToAddr(addr, /*recurse*/ true);
            } catch(e) {
                this.emitError(addr, "Failed to send to address " + addr, e);
                throw e;
            }
        }
    };
})();
