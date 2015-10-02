/*
 * vim: ts=4:sw=4:expandtab
 */
(function () {
    'use strict';
    window.Whisper = window.Whisper || {};

    var ContactView = Whisper.View.extend({
        className: 'contact-detail',
        templateName: 'contact-detail',
        initialize: function(options) {
            this.conflict = options.conflict;
            this.errors = _.reject(options.errors, function(e) {
                return (e.name === 'IncomingIdentityKeyError' ||
                        e.name === 'OutgoingIdentityKeyError');
            });
        },
        events: {
            'click .conflict': 'triggerConflict'
        },
        triggerConflict: function() {
            this.$el.trigger('conflict', {conflict: this.conflict});
        },
        render_attributes: function() {
            return {
                name     : this.model.getTitle(),
                avatar   : this.model.getAvatar(),
                conflict : this.conflict,
                errors   : this.errors
            };
        }
    });

    Whisper.MessageDetailView = Backbone.View.extend({
        className: 'message-detail',
        template: $('#message-detail').html(),
        initialize: function(options) {
            this.view = new Whisper.MessageView({model: this.model});
            this.conversation = options.conversation;
            this.errors = _.groupBy(this.model.get('errors'), 'number');

            this.listenTo(this.model, 'change', this.render);
        },
        events: {
            'click .back': 'goBack',
            'conflict': 'conflictDialogue'
        },
        goBack: function() {
            this.trigger('back');
        },
        verify: function(their_key) {
            textsecure.storage.axolotl.getIdentityKey(textsecure.storage.user.getNumber()).then(function(our_key) {
                var view = new Whisper.KeyVerificationView({
                    model: { their_key: their_key, your_key: our_key }
                });
                this.$el.hide();
                view.render().$el.insertAfter(this.el);
                this.listenTo(view, 'back', function() {
                    view.remove();
                    this.$el.show();
                }.bind(this));
            }.bind(this));
        },
        contacts: function() {
            if (this.model.isIncoming()) {
                var number = this.model.get('source');
                return [this.conversation.contactCollection.get(number)];
            } else {
                return this.conversation.contactCollection.models;
            }
        },
        conflictDialogue: function(e, data) {
            var view = new Whisper.KeyConflictDialogueView({
                model: data.conflict,
                conversation: this.conversation
            });
            view.render().$el.appendTo(this.$el);
            this.listenTo(view, 'verify', function(data) {
                this.verify(data.identityKey);
            });
            this.listenTo(view, 'resolve', function() {
                this.render();
            });
        },
        renderContact: function(contact) {
            var v = new ContactView({
                model: contact,
                conflict: this.model.getKeyConflict(contact.id),
                errors: this.errors[contact.id]
            }).render().$el.appendTo(this.$('.contacts'));
        },
        render: function() {
            this.$el.html(Mustache.render(this.template, {
                sent_at     : moment(this.model.get('sent_at')).toString(),
                received_at : moment(this.model.get('received_at')).toString(),
                tofrom      : this.model.isIncoming() ? 'From' : 'To',
                errors      : this.errors['undefined']
            }));
            this.view.render().$el.prependTo(this.$('.message-container'));

            if (this.model.isOutgoing()) {
                this.conversation.contactCollection.each(this.renderContact.bind(this));
            } else {
                this.renderContact(
                    this.conversation.contactCollection.get(this.model.get('source'))
                );
            }
        }
    });

})();
