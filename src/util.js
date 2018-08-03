// vim: ts=4:sw=4:expandtab
/* global dcodeIO */

(function() {
    self.relay = self.relay || {};
    const ns = self.relay.util = {};

    /*********************************
     *** Type conversion utilities ***
     *********************************/
    // Strings/arrays
    //TODO: Throw all this shit in favor of consistent types
    var StaticByteBufferProto = new dcodeIO.ByteBuffer().__proto__;
    var StaticArrayBufferProto = new ArrayBuffer().__proto__;
    var StaticUint8ArrayProto = new Uint8Array().__proto__;

    function getStringable(thing) {
        return (typeof thing == "string" || typeof thing == "number" || typeof thing == "boolean" ||
                (thing === Object(thing) &&
                    (thing.__proto__ == StaticArrayBufferProto ||
                    thing.__proto__ == StaticUint8ArrayProto ||
                    thing.__proto__ == StaticByteBufferProto)));
    }

    function ensureStringed(thing) {
        if (getStringable(thing))
            return ns.getString(thing);
        else if (thing instanceof Array) {
            const res = [];
            for (var i = 0; i < thing.length; i++)
                res[i] = ensureStringed(thing[i]);
            return res;
        } else if (thing === Object(thing)) {
            const res = {};
            for (var key in thing)
                res[key] = ensureStringed(thing[key]);
            return res;
        } else if (thing === null) {
            return null;
        }
        throw new Error("unsure of how to jsonify object of type " + typeof thing);

    }

    ns.getString = function(thing) {
        if (thing === Object(thing)) {
            if (thing.__proto__ == StaticUint8ArrayProto)
                return String.fromCharCode.apply(null, thing);
            if (thing.__proto__ == StaticArrayBufferProto)
                return ns.getString(new Uint8Array(thing));
            if (thing.__proto__ == StaticByteBufferProto)
                return thing.toString("binary");
        }
        return thing;
    };

    ns.unencodeAddr = function(addr) {
        const tuple = addr.split(".");
        if (tuple.length > 2) {
            throw new TypeError("Invalid address format");
        }
        if (tuple[1]) {
            tuple[1] = parseInt(tuple[1]);
        }
        return tuple;
    };

    ns.jsonThing = function(thing) {
        return JSON.stringify(ensureStringed(thing));
    };

    const _maxTimeout = 0x7fffffff;  // `setTimeout` max valid value.
    ns.sleep = async function(seconds) {
        let ms = seconds * 1000;
        while (ms > _maxTimeout) {
            // Support sleeping longer than the javascript max setTimeout...
            await new Promise(resolve => setTimeout(resolve, _maxTimeout));
            ms -= _maxTimeout;
        }
        return await new Promise(resolve => setTimeout(resolve, ms, seconds));
    };

    ns.never = function() {
        return new Promise(() => null);
    };

    ns.StringView = {
        /*
         * These functions from the Mozilla Developer Network
         * and have been placed in the public domain.
         * https://developer.mozilla.org/en-US/docs/Web/API/WindowBase64/Base64_encoding_and_decoding
         * https://developer.mozilla.org/en-US/docs/MDN/About#Copyrights_and_licenses
         */

        b64ToUint6: function(nChr) {
            return nChr > 64 &&
                   nChr < 91 ? nChr - 65 : nChr > 96 &&
                   nChr < 123 ? nChr - 71 : nChr > 47 &&
                   nChr < 58 ? nChr + 4 : nChr === 43 ? 62 : nChr === 47 ? 63 : 0;
        },

        base64ToBytes: function(sBase64, nBlocksSize) {
            var sB64Enc = sBase64.replace(/[^A-Za-z0-9+/]/g, "");
            var nInLen = sB64Enc.length;
            var nOutLen = nBlocksSize ? Math.ceil((nInLen * 3 + 1 >> 2) / nBlocksSize) *
                                        nBlocksSize : nInLen * 3 + 1 >> 2;
            var aBBytes = new ArrayBuffer(nOutLen);
            var taBytes = new Uint8Array(aBBytes);
  
            for (var nMod3, nMod4, nUint24 = 0, nOutIdx = 0, nInIdx = 0; nInIdx < nInLen; nInIdx++) {
                nMod4 = nInIdx & 3;
                nUint24 |= ns.StringView.b64ToUint6(sB64Enc.charCodeAt(nInIdx)) << 18 - 6 * nMod4;
                if (nMod4 === 3 || nInLen - nInIdx === 1) {
                    for (nMod3 = 0; nMod3 < 3 && nOutIdx < nOutLen; nMod3++, nOutIdx++) {
                        taBytes[nOutIdx] = nUint24 >>> (16 >>> nMod3 & 24) & 255;
                    }
                    nUint24 = 0;
                }
            }
            return aBBytes;
        },

        uint6ToB64: function(nUint6) {
            return nUint6 < 26 ? nUint6 + 65 : nUint6 < 52 ? nUint6 + 71 :
                   nUint6 < 62 ? nUint6 - 4 :nUint6 === 62 ? 43 : nUint6 === 63 ? 47 : 65;
        },

        bytesToBase64: function(aBytes) {
            var nMod3, sB64Enc = "";
            for (var nLen = aBytes.length, nUint24 = 0, nIdx = 0; nIdx < nLen; nIdx++) {
                nMod3 = nIdx % 3;
                if (nIdx > 0 && (nIdx * 4 / 3) % 76 === 0) {
                    sB64Enc += "\r\n";
                }
                nUint24 |= aBytes[nIdx] << (16 >>> nMod3 & 24);
                if (nMod3 === 2 || aBytes.length - nIdx === 1) {
                    sB64Enc += String.fromCharCode(
                        ns.StringView.uint6ToB64(nUint24 >>> 18 & 63),
                        ns.StringView.uint6ToB64(nUint24 >>> 12 & 63),
                        ns.StringView.uint6ToB64(nUint24 >>> 6 & 63),
                        ns.StringView.uint6ToB64(nUint24 & 63));
                    nUint24 = 0;
                }
            }
            return sB64Enc.replace(/A(?=A$|$)/g, "=");
        }
    };
})();
