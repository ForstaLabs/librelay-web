/*
 * vim: ts=4:sw=4:expandtab
 */

;(function() {
    'use strict';
    if (chrome && chrome.alarms) {
        chrome.alarms.onAlarm.addListener(function() {
            // nothing to do.
        });
        chrome.alarms.create('awake', {periodInMinutes: 1});
    }
    var open = false;
    chrome.app.window.getAll().forEach(function(appWindow) {
        open = true;
        appWindow.close();
    });

    textsecure.protocol_wrapper.startWorker();

    storage.fetch();
    storage.onready(function() {
        var messageReceiver;

        if (textsecure.registration.isDone()) {
            init();
        }
        extension.on('registration_done', init);

        window.getSocketStatus = function() {
            if (messageReceiver) {
                return messageReceiver.getStatus();
            } else {
                return -1;
            }
        };

        window.addEventListener('textsecure:message', onMessageReceived);
        window.addEventListener('textsecure:receipt', onDeliveryReceipt);
        window.addEventListener('textsecure:contact', onContactReceived);
        window.addEventListener('textsecure:group', onGroupReceived);
        window.addEventListener('textsecure:sent', onSentMessage);
        window.addEventListener('textsecure:error', onError);

        if (open) {
            openInbox();
        }

        function init() {
            if (!textsecure.registration.isDone()) { return; }

            // initialize the socket and start listening for messages
            messageReceiver = new textsecure.MessageReceiver('wss://textsecure-service-staging.whispersystems.org', window);
        }

        function onContactReceived(ev) {
            var contactDetails = ev.contactDetails;
            ConversationController.create({
                name: contactDetails.name,
                id: contactDetails.number,
                avatar: contactDetails.avatar,
                type: 'private'
            }).save();
        }

        function onGroupReceived(ev) {
            var groupDetails = ev.groupDetails;
            ConversationController.create({
                id: groupDetails.id,
                name: groupDetails.name,
                members: groupDetails.members,
                avatar: groupDetails.avatar,
                type: 'group',
            }).save();
        }

        function onMessageReceived(ev) {
            var data = ev.data;
            var message = initIncomingMessage(data.source, data.timestamp);
            message.handleDataMessage(data.message);
        }

        function onSentMessage(ev) {
            var now = new Date().getTime();
            var data = ev.data;

            var message = new Whisper.Message({
                source         : textsecure.storage.user.getNumber(),
                sent_at        : data.timestamp,
                received_at    : now,
                conversationId : data.destination,
                type           : 'outgoing',
                sent           : true
            });

            message.handleDataMessage(data.message);
        }

        function initIncomingMessage(source, timestamp) {
            var now = new Date().getTime();

            var message = new Whisper.Message({
                source         : source,
                sent_at        : timestamp,
                received_at    : now,
                conversationId : source,
                type           : 'incoming'
            });

            var newUnreadCount = storage.get("unreadCount", 0) + 1;
            storage.put("unreadCount", newUnreadCount);
            extension.navigator.setBadgeText(newUnreadCount);

            return message;
        }

        function onError(ev) {
            var e = ev.error;

            if (e.name === 'HTTPError' && (e.code == 401 || e.code == 403)) {
                extension.install();
                return;
            }

            if (e.name === 'HTTPError' && e.code == -1) {
                setTimeout(init, 60000);
                return;
            }

            if (ev.proto) {
                var envelope = ev.proto;
                var message = initIncomingMessage(envelope.source, envelope.timestamp.toNumber());
                if (e.name === 'IncomingIdentityKeyError') {
                    message.save({ errors : [e] }).then(function() {
                        updateInbox();
                        notifyConversation(message);
                    });
                    return;
                } else if (e.message !== 'Bad MAC') {
                    message.save({ errors : [ _.pick(e, ['name', 'message'])]}).then(function() {
                        updateInbox();
                        notifyConversation(message);
                    });
                    return;
                }
            }

            console.error(e);
            throw e;
        }

        // lazy hack
        window.receipts = new Backbone.Collection();

        function updateConversation(conversationId) {
            var conversation = ConversationController.get(conversationId);
            if (conversation) {
                conversation.fetchMessages();
            }
        }

        function onDeliveryReceipt(ev) {
            var pushMessage = ev.proto;
            var timestamp = pushMessage.timestamp.toNumber();
            var messages  = new Whisper.MessageCollection();
            var groups    = new Whisper.ConversationCollection();
            console.log('delivery receipt', pushMessage.source, timestamp);
            messages.fetchSentAt(timestamp).then(function() {
                groups.fetchGroups(pushMessage.source).then(function() {
                    for (var i in messages.where({type: 'outgoing'})) {
                        var message = messages.at(i);
                        var deliveries     = message.get('delivered') || 0;
                        var conversationId = message.get('conversationId');
                        if (conversationId === pushMessage.source || groups.get(conversationId)) {
                            message.save({delivered: deliveries + 1}).then(
                                // notify frontend listeners
                                updateConversation.bind(null, conversationId)
                            );
                            return;
                            // TODO: consider keeping a list of numbers we've
                            // successfully delivered to?
                        }
                    }
                    // if we get here, we didn't find a matching message.
                    // keep the receipt in memory in case it shows up later
                    // as a sync message.
                    receipts.add({ timestamp: timestamp, source: pushMessage.source });
                    return;
                });
            }).fail(function() {
                console.log('got delivery receipt for unknown message', pushMessage.source, timestamp);
            });
        }
    });
})();
