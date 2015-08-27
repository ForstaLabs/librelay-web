/* vim: ts=4:sw=4:expandtab
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
(function () {
    'use strict';
    window.Whisper = window.Whisper || {};

    Whisper.MessageListView = Whisper.ListView.extend({
        tagName: 'ul',
        className: 'message-list loading',
        itemView: Whisper.MessageView,
        events: {
            'add': 'onAdd',
            'update *': 'scrollToBottom',
            'scroll': 'measureScrollPosition',
            'reset-scroll': 'resetScrollPosition'
        },
        onAdd: function() {
            this.$el.removeClass('loading');
            this.scrollToBottom();
        },
        measureScrollPosition: function() {
            this.scrollPosition = this.$el.scrollTop() + this.$el.outerHeight();
            this.scrollHeight = this.el.scrollHeight;
            this.shouldStickToBottom = this.scrollPosition === this.scrollHeight;
        },
        resetScrollPosition: function() {
            var scrollPosition = this.scrollPosition;
            if (this.scrollHeight !== this.el.scrollHeight) {
               scrollPosition = this.el.scrollHeight * this.scrollPosition / this.scrollHeight;
            }
            this.$el.scrollTop(scrollPosition - this.$el.outerHeight());
        },
        scrollToBottomIfNeeded: function() {
            if (this.shouldStickToBottom) {
                this.$el.scrollTop(this.scrollHeight);
            }
        },
        scrollToBottom: function() {
            // TODO: Avoid scrolling if user has manually scrolled up?
            this.$el.scrollTop(this.el.scrollHeight);
            this.measureScrollPosition();
        },
        addAll: function() {
            Whisper.ListView.prototype.addAll.apply(this, arguments); // super()
            this.scrollToBottom();
        }
    });
})();
