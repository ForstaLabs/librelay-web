// vim: ts=4:sw=4:expandtab
/* global relay */

(function() {
    'use strict';

    self.relay = self.relay || {};
    const ns = self.relay.hub = {};

    function atobJWT(str) {
        /* See: https://github.com/yourkarma/JWT/issues/8 */
        return atob(str.replace(/_/g, '/').replace(/-/g, '+'));
    }

    function validateResponse(response, schema) {
        try {
            for (var i in schema) {
                switch (schema[i]) {
                    case 'object':
                    case 'string':
                    case 'number':
                        if (typeof response[i] !== schema[i]) {
                            return false;
                        }
                        break;
                }
            }
        } catch(ex) {
            return false;
        }
        return true;
    }

    function authHeader(username, password) {
        return "Basic " + btoa(relay.util.getString(username) + ":" + relay.util.getString(password));
    }

    const SIGNAL_URL_CALLS = {
        accounts: "v1/accounts",
        devices: "v1/devices",
        keys: "v2/keys",
        messages: "v1/messages",
        attachment: "v1/attachments"
    };

    const SIGNAL_HTTP_MESSAGES = {
        401: "Invalid authentication or invalidated registration",
        403: "Invalid code",
        404: "Address is not registered",
        413: "Server rate limit exceeded",
        417: "Address already registered"
    };

    ns.SignalServer = function(url, username, password) {
        if (typeof url !== 'string') {
            throw new TypeError('Invalid server url');
        }
        this.url = url;
        this.username = username;
        this.password = password;
        this.attachment_id_regex = RegExp("^https://.*/(\\d+)?");
    };

    ns.SignalServer.prototype = {
        constructor: ns.SignalServer,

        request: async function(param) {
            if (!param.urlParameters) {
                param.urlParameters = '';
            }
            const path = SIGNAL_URL_CALLS[param.call] + param.urlParameters;
            const headers = new Headers();
            if (param.username && param.password) {
                headers.set('Authorization', authHeader(param.username, param.password));
            }
            let resp;
            try {
                resp = await this.fetch(path, {
                    method: param.httpType || 'GET',
                    json: param.jsonData,
                    headers
                });
            } catch(e) {
                /* Fetch throws a very boring TypeError, throw something better.. */
                throw new relay.NetworkError(`${e.message}: ${param.call}`);
            }
            let resp_content;
            if ((resp.headers.get('content-type') || '').startsWith('application/json')) {
                resp_content = await resp.json();
            } else {
                resp_content = await resp.text();
            }
            if (!resp.ok) {
                const e = new relay.ProtocolError(resp.status, resp_content);
                if (SIGNAL_HTTP_MESSAGES.hasOwnProperty(e.code)) {
                    e.message = SIGNAL_HTTP_MESSAGES[e.code];
                } else {
                    e.message = `Status code: ${e.code}`;
                }
                throw e;
            }
            if (resp.status !== 204) {
                if (param.validateResponse &&
                    !validateResponse(resp_content, param.validateResponse)) {
                    throw new relay.ProtocolError(resp.status, resp_content);
                }
                return resp_content;
            }
        },

        fetch: async function(urn, options) {
            /* Thin wrapper around global.fetch to augment json and auth support. */
            options = options || {};
            options.headers = options.headers || new Headers();
            if (!options.headers.has('Authorization')) {
                if (this.username && this.password) {
                    options.headers.set('Authorization', authHeader(this.username, this.password));
                }
            }
            const body = options.json && relay.util.jsonThing(options.json);
            if (body) {
                options.headers.set('Content-Type', 'application/json; charset=utf-8');
                options.body = body;
            }
            return await fetch(`${this.url}/${urn.replace(/^\//, '')}`, options);
        },

        createAccount: async function(info) {
            const json = {
                signalingKey: btoa(relay.util.getString(info.signalingKey)),
                supportsSms: false,
                fetchesMessages: true,
                registrationId: info.registrationId,
                name: info.name,
                password: info.password
            };
            const response = await ns.fetchAtlas('/v1/provision/account', {
                method: 'PUT',
                json,
            });
            info.addr = response.userId;
            info.serverUrl = response.serverUrl;
            info.deviceId = response.deviceId;
            info.instigators = response.instigators;
            /* Save the new creds to our instance for future signal API calls. */
            this.username = info.username = `${info.addr}.${info.deviceId}`;
            this.password = info.password;
            console.info("Created account device:", this.username);
            return info;
        },

        addDevice: async function(code, addr, info) {
            if (!info.password || !addr || !info.signalingKey) {
                throw new ReferenceError("Missing Key(s)");
            }
            console.info("Adding device to:", addr);
            const jsonData = {
                signalingKey: btoa(relay.util.getString(info.signalingKey)),
                supportsSms: false,
                fetchesMessages: true,
                registrationId: info.registrationId,
                name: info.name
            };
            const response = await this.request({
                httpType: 'PUT',
                call: 'devices',
                urlParameters: '/' + code,
                jsonData,
                username: addr,
                password: info.password,
                validateResponse: {deviceId: 'number'}
            });
            Object.assign(info, response);
            /* Save the new creds to our instance for future signal API calls. */
            this.username = info.username = `${addr}.${info.deviceId}`;
            this.password = info.password;
            return info;
        },

        getDevices: async function() {
            const data = await this.request({call: 'devices'});
            return data && data.devices;
        },

        deleteDevice: async function(deviceId) {
            await this.request({
                call: 'devices',
                urlParameters: `/${deviceId}`,
                httpType: 'DELETE'
            });
        },

        getLinkDeviceVerificationCode: async function() {
            const data = await this.request({
                call: 'devices',
                urlParameters: '/provisioning/code'
            });
            return data && data.verificationCode;
        },

        registerKeys: function(genKeys) {
            var jsonData = {};
            jsonData.identityKey = btoa(relay.util.getString(genKeys.identityKey));
            jsonData.signedPreKey = {
                keyId: genKeys.signedPreKey.keyId,
                publicKey: btoa(relay.util.getString(genKeys.signedPreKey.publicKey)),
                signature: btoa(relay.util.getString(genKeys.signedPreKey.signature))
            };
            jsonData.preKeys = [];
            var j = 0;
            for (var i in genKeys.preKeys) {
                jsonData.preKeys[j++] = {
                    keyId: genKeys.preKeys[i].keyId,
                    publicKey: btoa(relay.util.getString(genKeys.preKeys[i].publicKey))
                };
            }
            return this.request({
                call: 'keys',
                httpType: 'PUT',
                jsonData
            });
        },

        getMyKeys: async function() {
            const res = await this.request({
                call: 'keys',
                validateResponse: {count: 'number'}
            });
            return res.count;
        },

        getKeysForAddr: async function(addr, deviceId) {
            if (deviceId === undefined) {
                deviceId = "*";
            }
            const res = await this.request({
                call: 'keys',
                urlParameters: "/" + addr + "/" + deviceId,
                validateResponse: {identityKey: 'string', devices: 'object'}
            });
            if (res.devices.constructor !== Array) {
                throw new TypeError("Invalid response");
            }
            res.identityKey = relay.util.StringView.base64ToBytes(res.identityKey);
            for (const device of res.devices) {
                if (!validateResponse(device, {signedPreKey: 'object'}) ||
                    !validateResponse(device.signedPreKey, {publicKey: 'string', signature: 'string'})) {
                    throw new Error("Invalid signedPreKey");
                }
                if (device.preKey) {
                    if (!validateResponse(device, {preKey: 'object'}) ||
                        !validateResponse(device.preKey, {publicKey: 'string'})) {
                        throw new Error("Invalid preKey");
                    }
                    device.preKey.publicKey = relay.util.StringView.base64ToBytes(device.preKey.publicKey);
                }
                device.signedPreKey.publicKey = relay.util.StringView.base64ToBytes(device.signedPreKey.publicKey);
                device.signedPreKey.signature = relay.util.StringView.base64ToBytes(device.signedPreKey.signature);
            }
            return res;
        },

        sendMessages: function(destination, messageArray, timestamp) {
            var jsonData = {
                messages: messageArray,
                timestamp: timestamp
            };
            return this.request({
                call: 'messages',
                httpType: 'PUT',
                urlParameters: '/' + destination,
                jsonData
            });
        },

        getAttachment: async function(id) {
            // XXX Build in retry handling...
            const response = await this.request({
                call: 'attachment',
                urlParameters: '/' + id,
                validateResponse: {location: 'string'}
            });
            const headers = new Headers({
                'Content-Type': 'application/octet-stream',
            });
            const attachment = await fetch(response.location, {headers});
            if (!attachment.ok) {
                const msg = await attachment.text();
                console.error("Download attachement error:", msg);
                throw new Error('Download Attachment Error: ' + msg);
            }
            return await attachment.arrayBuffer();
        },

        putAttachment: async function(body) {
            // XXX Build in retry handling...
            const ptrResp = await this.request({call: 'attachment'});
            // Extract the id as a string from the location url
            // (workaround for ids too large for Javascript numbers)
            const match = ptrResp.location.match(this.attachment_id_regex);
            if (!match) {
                console.error('Invalid attachment url for outgoing message',
                              ptrResp.location);
                throw new TypeError('Received invalid attachment url');
            }
            const headers = new Headers({
                'Content-Type': 'application/octet-stream',
            });
            const dataResp = await fetch(ptrResp.location, {
                method: "PUT",
                headers,
                body
            });
            if (!dataResp.ok) {
                const msg = await dataResp.text();
                console.error("Upload attachement error:", msg);
                throw new Error('Upload Attachment Error: ' + msg);
            }
            return match[1];
        },

        getMessageWebSocketURL: function() {
            return [
                this.url.replace('https://', 'wss://').replace('http://', 'ws://'),
                '/v1/websocket/?login=', encodeURIComponent(this.username),
                '&password=', encodeURIComponent(this.password)].join('');
        },

        getProvisioningWebSocketURL: function () {
            return this.url.replace('https://', 'wss://').replace('http://', 'ws://') +
                                    '/v1/websocket/provisioning/';
        },

        /* The GCM reg ID configures the data needed for the PushServer to wake us up
         * if this page is not active.  I.e. from our ServiceWorker. */
        updateGcmRegistrationId: async function(gcm_reg_id) {
            return await this.request({
                call: 'accounts',
                httpType: 'PUT',
                urlParameters: '/gcm',
                jsonData: {
                    gcmRegistrationId: gcm_reg_id,
                    webSocketChannel: true
                }
            });
        }
    };

    ns.getAtlasConfig = async function() {
        return await relay.store.getState('atlasConfig');
    };

    ns.setAtlasConfig = async function(data) {
        await relay.store.putState('atlasConfig', data);
    };

    let _atlasUrl = 'https://api.forsta.io';
    ns.getAtlasUrl = () => _atlasUrl;
    ns.setAtlasUrl = url => _atlasUrl = url;

    ns.decodeAtlasToken = function(encoded_token) {
        let token;
        try {
            const parts = encoded_token.split('.').map(atobJWT);
            token = {
                header: JSON.parse(parts[0]),
                payload: JSON.parse(parts[1]),
                secret: parts[2]
            };
        } catch(e) {
            throw new Error('Invalid Token');
        }
        if (!token.payload || !token.payload.exp) {
            throw TypeError("Invalid Token");
        }
        if (token.payload.exp * 1000 <= Date.now()) {
            throw Error("Expired Token");
        }
        return token;
    };

    ns.getEncodedAtlasToken = async function() {
        const config = await ns.getAtlasConfig();
        if (!config || !config.API || !config.API.TOKEN) {
            throw ReferenceError("No Token Found");
        }
        return config.API.TOKEN;
    },

    ns.updateEncodedAtlasToken = async function(encodedToken) {
        const config = await ns.getAtlasConfig();
        if (!config || !config.API || !config.API.TOKEN) {
            throw ReferenceError("No Token Found");
        }
        config.API.TOKEN = encodedToken;
        await ns.setAtlasConfig(config);
    },

    ns.getAtlasToken = async function() {
        return ns.decodeAtlasToken(await ns.getEncodedAtlasToken());
    };

    ns.fetchAtlas = async function(urn, options) {
        options = options || {};
        options.headers = options.headers || new Headers();
        try {
            const encodedToken = await ns.getEncodedAtlasToken();
            options.headers.set('Authorization', `JWT ${encodedToken}`);
        } catch(e) {
            /* Almost certainly will blow up soon (via 400s), but lets not assume
             * all API access requires auth regardless. */
            console.warn("Auth token missing or invalid", e);
        }
        options.headers.set('Content-Type', 'application/json; charset=utf-8');
        if (options.json) {
            options.body = JSON.stringify(options.json);
        }
        const url = [ns.getAtlasUrl(), urn.replace(/^\//, '')].join('/');
        const resp = await fetch(url, options);
        if (!resp.ok) {
            const msg = urn + ` (${await resp.text()})`;
            let error;
            if (resp.status === 404) {
                 error = new ReferenceError(msg);
            } else {
                error = new Error(msg);
            }
            error.code = resp.status;
            throw error;
        }
        return await resp.json();
    };

    ns.maintainAtlasToken = async function(forceRefresh, onRefresh) {
        /* Manage auth token expiration.  This routine will reschedule itself as needed. */
        let token = await ns.getAtlasToken();
        const refreshDelay = t => (t.payload.exp - (Date.now() / 1000)) / 2;
        if (forceRefresh || refreshDelay(token) < 1) {
            let refreshResp;
            try {
                refreshResp = await ns.fetchAtlas('/v1/api-token-refresh/', {
                    method: 'POST',
                    json: {token: await ns.getEncodedAtlasToken()}
                });
            } catch(e) {
                /* This is okay;  The token has an absolute lifetime, so we could be
                 * on the tail end of its life.  This doesn't mean the token is invalid,
                 * just that we can't refresh it any longer.  Eventually it will expire
                 * and some API call will get an auth error and be forced to login again
                 * (by design). */
                console.warn("Unable to refresh atlas token:", e);
            }
            if (refreshResp && refreshResp.token) {
                await ns.updateEncodedAtlasToken(refreshResp.token);
                console.info("Refreshed auth token");
                token = await ns.getAtlasToken();
                if (onRefresh) {
                    try {
                        await onRefresh(token);
                    } catch(e) {
                        console.error('onRefresh callback error:', e);
                    }
                }
            }
        }
        const nextUpdate = refreshDelay(token);
        const updateText = nextUpdate < 86400 ? `${Math.round(nextUpdate)} second(s)` :
                                                `${Math.round(nextUpdate / 86400)} day(s)`;
        console.info('Will recheck auth token in ' + updateText);
        relay.util.sleep(nextUpdate).then(ns.maintainAtlasToken);
    };

    ns.resolveTags = async function(expression) {
        return (await ns.resolveTagsBatch([expression]))[0];
    };

    ns.resolveTagsBatch = async function(expressions) {
        if (!expressions.length) {
            return [];
        }
        const resp = await ns.fetchAtlas('/v1/tagmath/', {
            method: 'POST',
            json: {expressions}
        });
        /* Enhance the warnings a bit. */
        for (let i = 0; i < resp.results.length; i++) {
            const res = resp.results[i];
            const expr = expressions[i];
            for (const w of res.warnings) {
                w.context = expr.substr(w.position, w.length);
            }
        }
        return resp.results;
    };

    ns.sanitizeTags = function(expression) {
        /* Clean up tags a bit. Add @ where needed.
         * NOTE: This does not currently support universal format! */
        const tagSplitRe = /([\s()^&+-]+)/;
        const tags = [];
        for (let tag of expression.trim().split(tagSplitRe)) {
            if (!tag) {
                continue;
            } else if (tag.match(/^[a-zA-Z]/)) {
                tag = '@' + tag;
            }
            tags.push(tag);
        }
        return tags.join(' ');
    };

    ns.getUsers = async function(userIds, onlyDir) {
        const missing = new Set(userIds);
        const users = [];
        if (!onlyDir) {
            const resp = await ns.fetchAtlas('/v1/user/?id_in=' + userIds.join());
            for (const user of resp.results) {
                users.push(user);
                missing.delete(user.id);
            }
        }
        if (missing.size) {
            const resp = await ns.fetchAtlas('/v1/directory/user/?id_in=' +
                                             Array.from(missing).join());
            for (const user of resp.results) {
                users.push(user);
            }
        }
        return users;
    };

    ns.getDevices = async function() {
        try {
            return (await ns.fetchAtlas('/v1/provision/account')).devices;
        } catch(e) {
            if (e instanceof ReferenceError) {
                return undefined;
            } else {
                throw e;
            }
        }
    };
})();
