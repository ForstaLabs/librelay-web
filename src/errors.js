/*
 * vim: ts=4:sw=4:expandtab
 */

(function() {
    'use strict';

    const ns = self.relay = self.relay || {};

    class RelayError extends Error {}

    class UnregisteredUserError extends RelayError {
        constructor(addr, httpError) {
            super(httpError.message);
            this.name = 'UnregisteredUserError';
            this.addr = addr;
            this.code = httpError.code;
            this.stack = httpError.stack;
        }
    }

    class ProtocolError extends RelayError {
        constructor(code, response) {
            super();
            this.name = 'ProtocolError';
            if (code > 999 || code < 100) {
                code = -1;
            }
            this.code = code;
            this.response = response;
        }
    }

    class NetworkError extends RelayError {
        constructor(a, b, c) {
            super(a, b, c);
            this.name = 'NetworkError';
        }
    }

    ns.UnregisteredUserError = UnregisteredUserError;
    ns.RelayError = RelayError;
    ns.ProtocolError = ProtocolError;
    ns.NetworkError = NetworkError;
})();
