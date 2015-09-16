/*
 * vim: ts=4:sw=4:expandtab
 */
(function () {
    'use strict';
    var MAX_MESSAGES = 1000;
    var PHONE_REGEX = /\+\d{7,12}(\d{3})/g;
    var debugLog = [];
    if (window.console) {
        console._log = console.log;
        console.log = function(thing){
            console._log(thing);
            if (debugLog.length > MAX_MESSAGES) {
                debugLog.shift();
            }
            var str = ('' + thing).replace(PHONE_REGEX, "+[REDACTED]$1");
            debugLog.push(str);
        };
        console.get = function() {
            return debugLog.join('\n');
        };
        console.post = function(log) {
            if (log === undefined) {
                log = console.get();
            }
            return new Promise(function(resolve) {
                $.post('https://api.github.com/gists', textsecure.utils.jsonThing({
                    "public": true,
                    "files": { "debugLog.txt": { "content": log } }
                })).then(function(response) {
                    console._log('Posted debug log to ', response.html_url);
                    resolve(response.html_url);
                }).fail(resolve);
            });
        };
    }
})();
