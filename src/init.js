// vim: ts=4:sw=4:expandtab

(function() {
    'use strict';

    const ns = self.relay = self.relay || {};

    let _initializedStore;
    ns.setStore = function(store) {
        if (_initializedStore) {
            return;
        }
        ns.store = store;
        _initializedStore = true;
    };

    let _initializedProtobufs;
    ns.loadProtobufs = async function(protoPath, protoQuery) {
        if (_initializedProtobufs) {
            return;
        }
        await ns.protobuf.load(protoPath, protoQuery);
        _initializedProtobufs = true;
    };
})();
