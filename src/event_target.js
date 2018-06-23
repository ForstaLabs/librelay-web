/*
 * vim: ts=4:sw=4:expandtab
 *
 * Implements EventTarget (with async support)
 * https://developer.mozilla.org/en-US/docs/Web/API/EventTarget
 *
 */

(function () {
    'use strict';

    const ns = self.relay = self.relay || {};

    class KeyChangeEvent {

        constructor(keyError) {
            this.type = 'keychange';
            this.keyError = keyError;
        }

        async accept() {
            await ns.store.removeIdentity(this.keyError.addr);
            await ns.store.saveIdentity(this.keyError.addr, this.keyError.identityKey);
            this.keyError.accepted = true;
        }
    }

    class EventTarget {

        async dispatchEvent(ev) {
            if (!ev.type) {
                throw new TypeError('Expects an event');
            }
            if (!this._listeners || !this._listeners[ev.type]) {
                return;
            }
            for (const callback of this._listeners[ev.type]) {
                try {
                    await callback.call(this, ev);
                } catch(e) {
                    console.error(`Event Listener Exception [${ev.type}]:`, e);
                }
            }
        }

        addEventListener(eventName, callback) {
            if (typeof eventName !== 'string') {
                throw new TypeError('First argument expects a string');
            }
            if (typeof callback !== 'function') {
                throw new TypeError('Second argument expects a function');
            }
            if (!this._listeners) {
                this._listeners = {};
            }
            if (!this._listeners[eventName]) {
                this._listeners[eventName] = [callback];
            } else {
                this._listeners[eventName].push(callback);
            }
        }

        removeEventListener(eventName, callback) {
            if (typeof eventName !== 'string') {
                throw new TypeError('First argument expects a string');
            }
            if (typeof callback !== 'function') {
                throw new TypeError('Second argument expects a function');
            }
            if (!this._listeners[eventName]) {
                return;
            }
            this._listeners[eventName] = this._listeners[eventName].filter(x => x !== callback);
        }
    }

    ns.KeyChangeEvent = KeyChangeEvent;
    ns.EventTarget = EventTarget;
}());
