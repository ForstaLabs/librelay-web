// vim: ts=4:sw=4:expandtab
/* global relay */

(function() {
    'use strict';

    self.relay = self.relay || {};
    const ns = self.relay.ccsm = {};

    function atobJWT(str) {
        /* See: https://github.com/yourkarma/JWT/issues/8 */
        return atob(str.replace(/_/g, '/').replace(/-/g, '+'));
    }

    ns.getConfig = async function() {
        return await relay.store.getState('ccsmConfig');
    };

    ns.setConfig = async function(data) {
        await relay.store.putState('ccsmConfig', data);
    };

    let _url = 'https://api.forsta.io';
    ns.getUrl = () => _url;
    ns.setUrl = url => _url = url;

    ns.decodeAuthToken = function(encoded_token) {
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

    ns.getEncodedAuthToken = async function() {
        const config = await ns.getConfig();
        if (!config || !config.API || !config.API.TOKEN) {
            throw ReferenceError("No Token Found");
        }
        return config.API.TOKEN;
    },

    ns.updateEncodedAuthToken = async function(encodedToken) {
        const config = await ns.getConfig();
        if (!config || !config.API || !config.API.TOKEN) {
            throw ReferenceError("No Token Found");
        }
        config.API.TOKEN = encodedToken;
        await ns.setConfig(config);
    },

    ns.getAuthToken = async function() {
        return ns.decodeAuthToken(await ns.getEncodedAuthToken());
    };

    ns.fetchResource = async function ccsm_fetchResource(urn, options) {
        options = options || {};
        options.headers = options.headers || new Headers();
        try {
            const encodedToken = await ns.getEncodedAuthToken();
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
        const url = [ns.getUrl(), urn.replace(/^\//, '')].join('/');
        const resp = await fetch(url, options);
        if (!resp.ok) {
            const msg = urn + ` (${await resp.text()})`;
            if (resp.status === 401 || resp.status === 403) {
                console.error("Auth token is invalid.  Logging out...");
                await ns.logout();
                throw new Error("logout - unreachable"); // just incase logout blows up.
            } else if (resp.status === 404) {
                throw new ReferenceError(msg);
            } else {
                throw new Error(msg);
            }
        }
        return await resp.json();
    };

    ns.maintainAuthToken = async function(forceRefresh, onRefresh) {
        /* Manage auth token expiration.  This routine will reschedule itself as needed. */
        let token = await ns.getAuthToken();
        const refreshDelay = t => (t.payload.exp - (Date.now() / 1000)) / 2;
        if (forceRefresh || refreshDelay(token) < 1) {
            const encodedToken = await ns.getEncodedAuthToken();
            const resp = await ns.fetchResource('/v1/api-token-refresh/', {
                method: 'POST',
                json: {token: encodedToken}
            });
            if (!resp || !resp.token) {
                throw new TypeError("Token Refresh Error");
            }
            await ns.updateEncodedAuthToken(resp.token);
            console.info("Refreshed auth token");
            token = await ns.getAuthToken();
            if (onRefresh) {
                try {
                    await onRefresh(token);
                } catch(e) {
                    console.error('onRefresh callback error:', e);
                }
            }
        }
        const nextUpdate = refreshDelay(token);
        console.info('Will recheck auth token in ' + nextUpdate + ' seconds');
        relay.util.sleep(nextUpdate).then(ns.maintainAuthToken);
    };

    ns.resolveTags = async function ccsm__resolveTags(expression) {
        expression = expression && expression.trim();
        if (!expression) {
            console.warn("Empty expression detected");
            // Do this while the server doesn't handle empty queries.
            return {
                universal: '',
                pretty: '',
                includedTagids: [],
                excludedTagids: [],
                userids: [],
                warnings: []
            };
        }
        const q = '?expression=' + encodeURIComponent(expression);
        const results = await ns.fetchResource('/v1/directory/user/' + q);
        for (const w of results.warnings) {
            w.context = expression.substring(w.position, w.position + w.length);
        }
        if (results.warnings.length) {
            console.warn("Tag Expression Warning(s):", expression, results.warnings);
        }
        return results;
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

    ns.getUsers = async function(userIds) {
        const missing = [];
        const users = [];
        await Promise.all(userIds.map(id => (async function() {
            try {
                users.push(await ns.fetchResource(`/v1/user/${id}/`));
            } catch(e) {
                if (!(e instanceof ReferenceError)) {
                    throw e;
                }
                missing.push(id);
            }
        })()));
        if (missing.length) {
            const query = '?id_in=' + missing.join(',');
            const resp = await ns.fetchResource('/v1/directory/user/' + query);
            for (const user of resp.results) {
                users.push(user);
            }
        }
        return users;
    };

    ns.getDevices = async function() {
        try {
            return (await ns.fetchResource('/v1/provision/account')).devices;
        } catch(e) {
            if (e instanceof ReferenceError) {
                return undefined;
            } else {
                throw e;
            }
        }
    };
})();
