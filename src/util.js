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
        return addr.split(".");
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
})();
