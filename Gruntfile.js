/* global module, require */

const fs = require('fs');
const path = require('path');


function assert_exists(file) {
    if (!fs.existsSync(file)) {
        throw new Error(`File not found: ${file}`);
    }
    return file;
}


function add_prefix(left, right) {
    return assert_exists(path.join(left, right));
}


module.exports = function(grunt) {
  'use strict';

  const dist = 'dist';

  grunt.loadNpmTasks('grunt-contrib-concat');
  grunt.loadNpmTasks('grunt-contrib-copy');

  grunt.initConfig({
    pkg: grunt.file.readJSON('package.json'),

    concat: {
      lib_relay: {
        src: [
          'init.js',
          'errors.js',
          'crypto.js',
          'protobufs.js',
          'queue_async.js',
          'websocket-resources.js',
          'util.js',
          'ccsm.js',
          'event_target.js',
          'api.js',
          'account_manager.js',
          'message_receiver.js',
          'message_sender.js',
          'outgoing_message.js',
          'ProvisioningCipher.js',
        ].map(x => add_prefix('src', x)),
        dest: `${dist}/relay.js`
      }
    },

    copy: {
      static: {
        nonull: true,
        files: [{
          expand: true,
          src: [
            'protos/**'
          ],
          dest: dist
        }]
      }
    }
  });

  grunt.registerTask('default', ['concat', 'copy']);
};
