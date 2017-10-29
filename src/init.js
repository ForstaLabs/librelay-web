// vim: ts=4:sw=4:expandtab

(function() {
    'use strict';

    const ns = self.relay = self.relay || {};

    let _initialized;
    ns.init = async function(store, protoPath, protoQuery) {
        if (_initialized) {
            return;
        }
        await ns.protobuf.load(protoPath, protoQuery);
        ns.store = store;
        _initialized = true;
    };
})();
