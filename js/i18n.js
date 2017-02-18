/*
 * vim: ts=4:sw=4:expandtab
 */
(function () {
    'use strict';

    var messages = __relay_locale();

    window.i18n = function(message, substitutions) {
        let entry = messages[message];
        if (entry === undefined) {
            console.warn("Translation missing", message);
            return '';
        }
        let subs = {};
        if (entry.placeholders !== undefined) {
            Object.keys(entry.placeholders).forEach(function(key) {
                let x = entry.placeholders[key];
                if (x.content.indexOf('$') === -1) {
                    subs[key] = x.content;
                } else {
                    let index = Number(x.content.slice(1)) - 1;
                    subs[key] = substitutions[index];
                }
            });
        }
        let parts = [];
        entry.message.split('$').forEach(function(x, i) {
            if (i % 2) {
                if (x === '') {
                    parts.push('$');  // $$ == literal %
                } else {
                    let sub = subs[x];
                    if (sub === undefined) {
                        console.error('Missing substitution:', x, subs);
                        throw 'bad substitution';
                    } else {
                        parts.push(sub);
                    }
                }
            } else {
                parts.push(x);
            }
        });
        return parts.join('');
    };

    i18n.getLocale = function() {
        return navigator.language.split('-')[0];
    };

}());
