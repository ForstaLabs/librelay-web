// vim: ts=4:sw=4:expandtab
/* global libsignal */


(function () {
    'use strict';

    const ns = self.relay = self.relay || {};

    ns.AccountManager = class AccountManager extends ns.EventTarget {

        constructor(signal) {
            super();
            this.signal = signal;
            this.preKeyLowWater = 10;  // Add more keys when we get this low.
            this.preKeyHighWater = 100; // Max fill level for prekeys.
        }

        _generateDeviceInfo(identityKeyPair, name) {
            const passwd = btoa(ns.util.getString(libsignal.crypto.getRandomBytes(16)));
            return {
                name,
                identityKeyPair,
                signalingKey: libsignal.crypto.getRandomBytes(32 + 20),
                registrationId: libsignal.keyhelper.generateRegistrationId(),
                password: passwd.substring(0, passwd.length - 2)
            };
        }

        async registerAccount(name) {
            console.assert(typeof name === 'string');
            const identity = libsignal.keyhelper.generateIdentityKeyPair();
            const devInfo = await this._generateDeviceInfo(identity, name);
            const accountInfo = await this.signal.createAccount(devInfo);
            await ns.store.putState('addr', accountInfo.addr);
            await this.saveDeviceState(accountInfo.addr, accountInfo);
            const keys = await this.generateKeys();
            await this.signal.registerKeys(keys);
            await this.registrationDone();
        }

        async registerDevice(name, onProvisionReady, confirmAddress, progressCallback) {
            console.assert(typeof name === 'string');
            const returnInterface = {waiting: true};
            const provisioningCipher = new ns.ProvisioningCipher();
            const pubKey = provisioningCipher.getPublicKey();
            let wsr;
            const webSocketWaiter = new Promise((resolve, reject) => {
                const url = this.signal.getProvisioningWebSocketURL();
                wsr = new ns.WebSocketResource(url, {
                    keepalive: {path: '/v1/keepalive/provisioning'},
                    handleRequest: request => {
                        if (request.path === "/v1/address" && request.verb === "PUT") {
                            const proto = ns.protobuf.ProvisioningUuid.decode(request.body);
                            request.respond(200, 'OK');
                            const r = onProvisionReady(proto.uuid, btoa(ns.util.getString(pubKey)));
                            if (r instanceof Promise) {
                                r.catch(reject);
                            }
                        } else if (request.path === "/v1/message" && request.verb === "PUT") {
                            const msgEnvelope = ns.protobuf.ProvisionEnvelope.decode(request.body, 'binary');
                            request.respond(200, 'OK');
                            wsr.close();
                            resolve(msgEnvelope);
                        } else {
                            reject(new Error('Unknown websocket message ' + request.path));
                        }
                    }
                });
            });
            await wsr.connect();

            returnInterface.done = (async function() {
                const provisionMessage = await provisioningCipher.decrypt(await webSocketWaiter);
                returnInterface.waiting = false;
                await confirmAddress(provisionMessage.addr);
                const devInfo = await this._generateDeviceInfo(provisionMessage.identityKeyPair,
                                                               name);
                await this.signal.addDevice(provisionMessage.provisioningCode,
                                            provisionMessage.addr, devInfo);
                await this.saveDeviceState(provisionMessage.addr, devInfo);
                const keys = await this.generateKeys(progressCallback);
                await this.signal.registerKeys(keys);
                await this.registrationDone();
            }).call(this);

            returnInterface.cancel = async function() {
                wsr.close();
                try {
                    await webSocketWaiter;
                } catch(e) {
                    console.warn("Ignoring web socket error:", e);
                }
            };
            return returnInterface;
        }

        async linkDevice(uuid, pubKey, options) {
            options = options || {};
            const code = await this.signal.getLinkDeviceVerificationCode();
            const ourIdent = await ns.store.getOurIdentity();
            const pMessage = new ns.protobuf.ProvisionMessage();
            pMessage.identityKeyPrivate = ourIdent.privKey;
            pMessage.addr = await ns.store.getState('addr');
            pMessage.userAgent = options.userAgent || 'librelay-web';
            pMessage.provisioningCode = code;
            const provisioningCipher = new ns.ProvisioningCipher();
            const pEnvelope = await provisioningCipher.encrypt(pubKey, pMessage);
            const pEnvBin = new Uint8Array(pEnvelope.toArrayBuffer());
            const resp = await this.signal.fetch('/v1/provisioning/' + uuid, {
                method: 'PUT',
                json: {
                    body: btoa(String.fromCharCode.apply(null, pEnvBin))
                }
            });
            if (!resp.ok) {
                // 404 means someone else handled it already.
                if (resp.status !== 404) {
                    throw new Error(await resp.text());
                }
            }
        }

        async refreshPreKeys() {
            const preKeyCount = await this.signal.getMyKeys();
            if (preKeyCount <= this.preKeyLowWater) {
                // The server replaces existing keys so just go to the hilt.
                console.info("Refreshing pre-keys...");
                const keys = await this.generateKeys();
                await this.signal.registerKeys(keys);
            }
        }

        async saveDeviceState(addr, info) {
            await ns.store.clearSessionStore();
            await ns.store.removeOurIdentity();
            const stateKeys = [
                'deviceId',
                'name',
                'password',
                'registrationId',
                'signalingKey',
                'username',
                'instigators'
            ];
            await Promise.all(stateKeys.map(key => ns.store.removeState(key)));
            // update our own identity key, which may have changed
            // if we're relinking after a reinstall on the master device
            await ns.store.removeIdentity(addr);
            await ns.store.putState('addr', addr);
            await ns.store.saveIdentity(addr, info.identityKeyPair.pubKey);
            await ns.store.saveOurIdentity(info.identityKeyPair);
            await Promise.all(stateKeys.map(key => ns.store.putState(key, info[key])));
        }

        async generateKeys(progressCallback) {
            if (typeof progressCallback !== 'function') {
                progressCallback = undefined;
            }
            const count = this.preKeyHighWater;
            const startId = await ns.store.getState('maxPreKeyId', 1);
            if (typeof startId !== 'number') {
                throw new TypeError('Invalid maxPreKeyId');
            }
            const signedKeyId = await ns.store.getState('signedKeyId', 1);
            if (typeof signedKeyId !== 'number') {
                throw new TypeError('Invalid signedKeyId');
            }
            const ourIdent = await ns.store.getOurIdentity();
            const result = {
                preKeys: [],
                identityKey: ourIdent.pubKey
            };
            for (let keyId = startId; keyId < startId + count; ++keyId) {
                const preKey = libsignal.keyhelper.generatePreKey(keyId);
                await ns.store.storePreKey(preKey.keyId, preKey.keyPair);
                result.preKeys.push({
                    keyId: preKey.keyId,
                    publicKey: preKey.keyPair.pubKey
                });
                if (progressCallback) {
                    await progressCallback(keyId - startId, (keyId - startId) / count);
                }
            }
            const sprekey = libsignal.keyhelper.generateSignedPreKey(ourIdent, signedKeyId);
            await ns.store.storeSignedPreKey(sprekey.keyId, sprekey.keyPair);
            result.signedPreKey = {
                keyId: sprekey.keyId,
                publicKey: sprekey.keyPair.pubKey,
                signature: sprekey.signature
            };
            await ns.store.removeSignedPreKey(signedKeyId - 2);
            await ns.store.putStateDict({
                maxPreKeyId: startId + count,
                signedKeyId: signedKeyId + 1
            });
            return result;
        }

        async registrationDone() {
            await this.dispatchEvent(new Event('registration'));
        }

        async deleteDevice(deviceId) {
            await this.signal.deleteDevice(deviceId);
        }
    };
}());
