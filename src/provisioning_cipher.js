// vim: ts=4:sw=4:expandtab
/* global libsignal */

(function() {
    'use strict';

    const ns = self.relay = self.relay || {};

    const secretsInfoMessage = "TextSecure Provisioning Message";

    ns.ProvisioningCipher = class ProvisioningCipher {

        async decrypt(provisionEnvelope) {
            const masterEphemeral = provisionEnvelope.publicKey.toArrayBuffer();
            const message = provisionEnvelope.body.toArrayBuffer();
            if (new Uint8Array(message)[0] != 1) {
                throw new Error("Bad version number on ProvisioningMessage");
            }
            const iv = message.slice(1, 16 + 1);
            const mac = message.slice(message.byteLength - 32, message.byteLength);
            const ivAndCiphertext = message.slice(0, message.byteLength - 32);
            const ciphertext = message.slice(16 + 1, message.byteLength - 32);
            const ecRes = libsignal.curve.calculateAgreement(masterEphemeral, this.keyPair.privKey);
            const secretsInfo = libsignal.util.stringToBytes(secretsInfoMessage).buffer;
            const keys = await libsignal.crypto.deriveSecrets(ecRes, new ArrayBuffer(32), secretsInfo);
            await libsignal.crypto.verifyMAC(ivAndCiphertext, keys[1], mac, 32);
            const plaintext = await libsignal.crypto.decrypt(keys[0], ciphertext, iv);
            const provisionMessage = ns.protobuf.ProvisionMessage.decode(plaintext);
            const privKey = provisionMessage.identityKeyPrivate.toArrayBuffer();
            return {
                identityKeyPair: libsignal.curve.createKeyPair(privKey),
                addr: provisionMessage.addr,
                provisioningCode: provisionMessage.provisioningCode,
                userAgent: provisionMessage.userAgent
            };
        }

        async encrypt(theirPublicKey, message) {
            const ourKeyPair = libsignal.curve.generateKeyPair();
            const sharedSecret = libsignal.curve.calculateAgreement(libsignal.util.stringToArrayBuffer(theirPublicKey),
                                                                    ourKeyPair.privKey);
            const secretsInfo = libsignal.util.stringToBytes(secretsInfoMessage).buffer;
            const keys = await libsignal.crypto.deriveSecrets(sharedSecret, new ArrayBuffer(32), secretsInfo);
            const ivLen = 16;
            const macLen = 32;
            const iv = new Uint8Array(ivLen);
            crypto.getRandomValues(iv);
            const encryptedMsg = await libsignal.crypto.encrypt(keys[0], message.toArrayBuffer(), iv);
            const msgLen = encryptedMsg.byteLength;
            const data = new Uint8Array(1 + ivLen + msgLen);
            data[0] = 1;  // Version
            data.set(iv, 1);
            data.set(new Uint8Array(encryptedMsg), 1 + ivLen);
            const mac = await libsignal.crypto.calculateMAC(keys[1], data.buffer);
            const pEnvelope = new ns.protobuf.ProvisionEnvelope();
            pEnvelope.body = new Uint8Array(data.byteLength + macLen);
            pEnvelope.body.set(data, 0);
            pEnvelope.body.set(new Uint8Array(mac), data.byteLength);
            pEnvelope.publicKey = ourKeyPair.pubKey;
            return pEnvelope;
        }

        getPublicKey() {
            if (!this.keyPair) {
                this.keyPair = libsignal.curve.generateKeyPair();
            }
            return this.keyPair.pubKey;
        }
    };
})();
