/* vim: ts=4:sw=4:noexpandtab:
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



new Whisper.ConversationListView({el: $('#contacts')});
Whisper.Threads.fetch({reset: true});

textsecure.registerOnLoadFunction(function() {
	if (textsecure.storage.getUnencrypted("number_id") === undefined) {
		extension.navigator.tabs.create("options.html");
	} else {
		textsecure.storage.putUnencrypted("unreadCount", 0);
		extension.navigator.setBadgeText("");
	}
});
