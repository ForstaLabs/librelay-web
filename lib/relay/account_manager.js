// vim: ts=4:sw=4:expandtab
/* global libsignal getString platform */


(function () {
    'use strict';

    const ns = self.relay = self.relay || {};

    const lastResortKeyId = 0xdeadbeef & ((2 ** 31) - 1); // Must fit inside signed 32bit int.

    ns.AccountManager = class AccountManager extends ns.EventTarget {

        constructor(server) {
            super();
            this.server = server;
            this.preKeyLowWater = 10;  // Add more keys when we get this low.
            this.preKeyHighWater = 100; // Max fill level for prekeys.
        }

        _generateDeviceInfo(identityKeyPair, name) {
            const passwd = btoa(getString(libsignal.crypto.getRandomBytes(16)));
            return {
                name,
                identityKeyPair,
                signalingKey: libsignal.crypto.getRandomBytes(32 + 20),
                registrationId: libsignal.KeyHelper.generateRegistrationId(),
                password: passwd.substring(0, passwd.length - 2)
            };
        }

        async registerAccount() {
            const name = this.makeDeviceName();
            const identity = await libsignal.KeyHelper.generateIdentityKeyPair();
            const devInfo = await this._generateDeviceInfo(identity, name);
            const accountInfo = await this.server.createAccount(devInfo);
            await ns.store.putState('addr', accountInfo.addr);
            await this.saveDeviceState(accountInfo.addr, accountInfo);
            const keys = await this.generateKeys(this.preKeyHighWater);
            await this.server.registerKeys(keys);
            await this.registrationDone();
        }

        registerDevice(setProvisioningUrl, confirmAddress, progressCallback) {
            const returnInterface = {waiting: true};
            const provisioningCipher = new ns.ProvisioningCipher();
            const pubKey = provisioningCipher.getPublicKey();
            let wsr;
            const webSocketWaiter = new Promise((resolve, reject) => {
                const url = this.server.getProvisioningWebSocketURL();
                wsr = new ns.WebSocketResource(url, {
                    keepalive: {path: '/v1/keepalive/provisioning'},
                    handleRequest: request => {
                        if (request.path === "/v1/address" && request.verb === "PUT") {
                            const proto = ns.protobuf.ProvisioningUuid.decode(request.body);
                            const uriPubKey = encodeURIComponent(btoa(getString(pubKey)));
                            request.respond(200, 'OK');
                            const r = setProvisioningUrl(`tsdevice:/?uuid=${proto.uuid}&pub_key=${uriPubKey}`);
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
                wsr.connect();
            });

            returnInterface.done = (async function() {
                const provisionMessage = await provisioningCipher.decrypt(await webSocketWaiter);
                returnInterface.waiting = false;
                await confirmAddress(provisionMessage.addr);
                const name = this.makeDeviceName();
                const devInfo = await this._generateDeviceInfo(provisionMessage.identityKeyPair,
                                                               name);
                await this.server.addDevice(provisionMessage.provisioningCode,
                                            provisionMessage.addr, devInfo);
                await this.saveDeviceState(provisionMessage.addr, devInfo);
                const keys = await this.generateKeys(this.preKeyHighWater, progressCallback);
                await this.server.registerKeys(keys);
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

        async linkDevice(uuid, pubKey) {
            const code = await this.server.getLinkDeviceVerificationCode();
            const ourIdent = await ns.store.getOurIdentity();
            const pMessage = new ns.protobuf.ProvisionMessage();
            pMessage.identityKeyPrivate = ourIdent.privKey;
            pMessage.addr = F.currentUser.id;
            pMessage.userAgent = F.product;
            pMessage.provisioningCode = code;
            const provisioningCipher = new ns.ProvisioningCipher();
            const pEnvelope = await provisioningCipher.encrypt(pubKey, pMessage);
            const pEnvBin = new Uint8Array(pEnvelope.toArrayBuffer());
            const resp = await this.server.fetch('/v1/provisioning/' + uuid, {
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
            const preKeyCount = await this.server.getMyKeys();
            const lastResortKey = await ns.store.loadPreKey(lastResortKeyId);
            if (preKeyCount <= this.preKeyLowWater || !lastResortKey) {
                // The server replaces existing keys so just go to the hilt.
                console.info("Refreshing pre-keys...");
                const keys = await this.generateKeys(this.preKeyHighWater);
                await this.server.registerKeys(keys);
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
            ];
            await Promise.all(stateKeys.map(key => ns.store.removeState(key)));
            // update our own identity key, which may have changed
            // if we're relinking after a reinstall on the master device
            await ns.store.removeIdentityKey(addr);
            await ns.store.putState('addr', addr);
            await ns.store.saveIdentity(addr, info.identityKeyPair.pubKey);
            await ns.store.saveOurIdentity(info.identityKeyPair);
            await Promise.all(stateKeys.map(key => ns.store.putState(key, info[key])));
        }

        async generateKeys(count, progressCallback) {
            if (typeof progressCallback !== 'function') {
                progressCallback = undefined;
            }
            const startId = await ns.store.getState('maxPreKeyId', 1);
            const signedKeyId = await ns.store.getState('signedKeyId', 1);

            if (typeof startId != 'number') {
                throw new Error('Invalid maxPreKeyId');
            }
            if (typeof signedKeyId != 'number') {
                throw new Error('Invalid signedKeyId');
            }

            let lastResortKey = await ns.store.loadPreKey(lastResortKeyId);
            if (!lastResortKey) {
                // Last resort key only used if our prekey pool is drained faster than
                // we refresh it.  This prevents message dropping at the expense of
                // forward secrecy impairment.
                const pk = await libsignal.KeyHelper.generatePreKey(lastResortKeyId);
                await ns.store.storePreKey(lastResortKeyId, pk.keyPair);
                lastResortKey = pk.keyPair;
            }

            const ourIdent = await ns.store.getOurIdentity();
            const result = {
                preKeys: [],
                identityKey: ourIdent.pubKey,
                lastResortKey: {
                    keyId: lastResortKeyId,
                    publicKey: lastResortKey.pubKey
                }
            };

            for (let keyId = startId; keyId < startId + count; ++keyId) {
                const preKey = await libsignal.KeyHelper.generatePreKey(keyId);
                await ns.store.storePreKey(preKey.keyId, preKey.keyPair);
                result.preKeys.push({
                    keyId: preKey.keyId,
                    publicKey: preKey.keyPair.pubKey
                });
                if (progressCallback) {
                    await progressCallback(keyId - startId, (keyId - startId) / count);
                }
            }

            const sprekey = await libsignal.KeyHelper.generateSignedPreKey(ourIdent, signedKeyId);
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
            await this.server.deleteDevice(deviceId);
        }

        makeDeviceName() {
            const machine = platform.product || platform.os.family;
            const name = `${F.product} (${platform.name} on ${machine})`;
            if (name.length >= 50) {
                return name.substring(0, 45) + '...)';
            } else {
                return name;
            }
        }
    };
}());