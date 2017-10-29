// vim: ts=4:sw=4:expandtab
/* global dcodeIO */

(function() {
    'use strict';

    const ns = self.relay = self.relay || {};
    ns.protobuf = {};

    //const path = '/@static/protos/';
    const manifest = [
        'IncomingPushMessageSignal.proto',
        'SubProtocol.proto',
        'DeviceMessages.proto'
    ];

    async function loadProtoBufs(path, filename, query) {
        //const resp = await fetch(path + filename + `?v=${F.env.GIT_COMMIT.substring(0, 8)}`);
        const resp = await fetch(path + filename + (query || ''));
        const data = await resp.text();
        if (!resp.ok) {
            throw new Error(data);
        }
        const buf = dcodeIO.ProtoBuf.loadProto(data);
        const protos = buf.build('relay');
        for (var protoName in protos) {
            ns.protobuf[protoName] = protos[protoName];
        }
    }

    ns.protobuf.load = async function(path, query) {
        await Promise.all(manifest.map(loadProtoBufs));
    };
})();
