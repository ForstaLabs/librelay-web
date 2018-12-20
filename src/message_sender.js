// vim: ts=4:sw=4:expandtab
/* global libsignal */


(function() {

    const ns = self.relay = self.relay || {};

    class Message {

        constructor(options) {
            Object.assign(this, options);
            if (this.expiration !== undefined && this.expiration !== null) {
                if (typeof this.expiration !== 'number' || !(this.expiration >= 0)) {
                    throw new Error('Invalid expiration');
                }
            }
            if (this.attachments) {
                if (!(this.attachments instanceof Array)) {
                    throw new Error('Invalid message attachments');
                }
            }
            if (this.flags !== undefined && typeof this.flags !== 'number') {
                throw new Error('Invalid message flags');
            }
        }

        isEndSession() {
            return (this.flags & ns.protobuf.DataMessage.Flags.END_SESSION);
        }

        toProto() {
            const content = new ns.protobuf.Content();
            const data = content.dataMessage = new ns.protobuf.DataMessage();
            if (this.body) {
                data.body = JSON.stringify(this.body);
            }
            if (this.attachmentPointers && this.attachmentPointers.length) {
                data.attachments = this.attachmentPointers;
            }
            if (this.flags) {
                data.flags = this.flags;
            }
            if (this.expiration) {
                data.expireTimer = this.expiration;
            }
            return content;
        }
    }


    ns.MessageSender = class MessageSender extends ns.EventTarget {

        constructor(signal, addr) {
            super();
            console.assert(signal && addr);
            this.signal = signal;
            this.addr = addr;
        }

        async makeAttachmentPointer(attachment) {
            if (!attachment) {
                console.warn("Attempt to make attachment pointer from nothing:", attachment);
                return;
            }
            const ptr = new ns.protobuf.AttachmentPointer();
            if (attachment.key && attachment.id) {
                ptr.key = attachment.key;
                ptr.id = attachment.id;
                ptr.contentType = attachment.type;
            } else {
                ptr.key = libsignal.crypto.getRandomBytes(64);
                const iv = libsignal.crypto.getRandomBytes(16);
                const encryptedBin = await ns.crypto.encryptAttachment(attachment.data, ptr.key, iv);
                const id = await this.signal.putAttachment(encryptedBin);
                ptr.id = id;
                ptr.contentType = attachment.type;
            }
            return ptr;
        }

        async uploadAttachments(message) {
            const attachments = message.attachments;
            if (!attachments || !attachments.length) {
                message.attachmentPointers = [];
                return;
            }
            const upload_jobs = attachments.map(x => this.makeAttachmentPointer(x));
            message.attachmentPointers = await Promise.all(upload_jobs);
        }

        async send(attrs) {
            console.assert(attrs.threadId && attrs.timestamp && attrs.addrs);
            const includeSelf = attrs.addrs.indexOf(this.addr) !== -1;
            const msg = new Message(attrs);
            await this.uploadAttachments(msg);
            const msgProto = msg.toProto();
            const outMsg = this._send(msgProto, attrs.timestamp, this.scrubSelf(attrs.addrs));
            if (includeSelf) {
                const expirationStart = attrs.expiration && Date.now();
                const syncOutMsg = this._sendSync(msgProto, attrs.timestamp, attrs.threadId,
                                                  expirationStart);
                // Relay events from out message into the normal (non-sync) out-msg.  Even
                // if this message is just for us, it makes the interface consistent.
                syncOutMsg.on('sent', ev => outMsg.emit('sent', ev));
                syncOutMsg.on('error', ev => outMsg.emit('error', ev));
            }
            return outMsg;
        }

        _send(msgproto, timestamp, addrs) {
            console.assert(addrs instanceof Array);
            const outmsg = new ns.OutgoingMessage(this.signal, timestamp, msgproto);
            outmsg.on('keychange', this.onKeyChange.bind(this));
            for (const addr of addrs) {
                ns.queueAsync('message-send-job-' + addr, () =>
                    outmsg.sendToAddr(addr).catch(this.onError.bind(this)));
            }
            return outmsg;
        }

        async onError(e) {
            const ev = new Event('error');
            ev.error = e;
            await this.dispatchEvent(ev);
        }

        async onKeyChange(e) {
            await this.dispatchEvent(new ns.KeyChangeEvent(e));
        }

        _sendSync(content, timestamp, threadId, expirationStartTimestamp) {
            if (!(content instanceof ns.protobuf.Content)) {
                throw new TypeError("Expected Content protobuf");
            }
            const sentMessage = new ns.protobuf.SyncMessage.Sent();
            sentMessage.timestamp = timestamp;
            sentMessage.message = content.dataMessage;
            if (threadId) {
                sentMessage.destination = threadId;
            }
            if (expirationStartTimestamp) {
                sentMessage.expirationStartTimestamp = expirationStartTimestamp;
            }
            const syncMessage = new ns.protobuf.SyncMessage();
            syncMessage.sent = sentMessage;
            const syncContent = new ns.protobuf.Content();
            syncContent.syncMessage = syncMessage;
            return this._send(syncContent, timestamp, [this.addr]);
        }

        async syncReadMessages(reads) {
            if (!reads.length) {
                console.warn("No reads to sync");
            }
            const syncMessage = new ns.protobuf.SyncMessage();
            syncMessage.read = reads.map(r => {
                const read = new ns.protobuf.SyncMessage.Read();
                read.timestamp = r.timestamp;
                read.sender = r.sender;
                return read;
            });
            const content = new ns.protobuf.Content();
            content.syncMessage = syncMessage;
            return this._send(content, Date.now(), [this.addr]);
        }

        scrubSelf(addrs) {
            const nset = new Set(addrs);
            nset.delete(this.addr);
            return Array.from(nset);
        }

        async closeSession(encodedAddr, options) {
            const msg = new Message({
                flags: ns.protobuf.DataMessage.Flags.END_SESSION,
                timestamp: Date.now(),
                body: [{
                    version: 1,
                    messageType: 'control',
                    messageId: 'deadbeef-1111-2222-3333-000000000000', // Avoid breaking clients while prototyping
                    threadId: 'deadbeef-1111-2222-3333-000000000000', // Avoid breaking clients while prototyping
                    data: {
                        control: 'closeSession',
                        retransmit: options.retransmit
                    }
                }]
            });
            const addrTuple = ns.util.unencodeAddr(encodedAddr);
            const addr = addrTuple[0];
            const deviceId = addrTuple[1];
            const deviceIds = deviceId ? [deviceId] :  await ns.store.getDeviceIds(addr);

            async function _closeOpenSessions() {
                await Promise.all(deviceIds.map(deviceId => {
                    const address = new libsignal.ProtocolAddress(addr, deviceId);
                    const sessionCipher = new libsignal.SessionCipher(ns.store, address);
                    return sessionCipher.closeOpenSession();
                }));
            }

            await _closeOpenSessions();  // Clear before so endsession is a prekey bundle
            const outmsg = this._send(msg.toProto(), Date.now(), [encodedAddr]);
            try {
                await new Promise((resolve, reject) => {
                    outmsg.on('sent', resolve);
                    outmsg.on('error', reject);
                });
            } finally {
                await _closeOpenSessions();  // Clear after so don't use the reopened session from the end msg
            }
        }
    };
})();
