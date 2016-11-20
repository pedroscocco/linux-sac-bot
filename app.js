/*
 * Copyright 2016-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* jshint node: true, devel: true */
'use strict';

const
  bodyParser = require('body-parser'),
  crypto = require('crypto'),
  express = require('express'),
  https = require('https'),
  request = require('request');

var pg = require('pg');

var app = express();
app.set('port', process.env.PORT || 5000);
app.set('view engine', 'ejs');
app.use(bodyParser.json({ verify: verifyRequestSignature }));
app.use(express.static('public'));

const APP_SECRET = process.env.MESSENGER_APP_SECRET;

const VALIDATION_TOKEN = process.env.MESSENGER_VALIDATION_TOKEN;

const PAGE_ACCESS_TOKEN = process.env.MESSENGER_PAGE_ACCESS_TOKEN;

const SERVER_URL = process.env.SERVER_URL;

if (!(APP_SECRET && VALIDATION_TOKEN && PAGE_ACCESS_TOKEN && SERVER_URL)) {
  console.error("Missing config values");
  process.exit(1);
}

app.get('/webhook', function(req, res) {
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === VALIDATION_TOKEN) {
    console.log("Validating webhook");
    res.status(200).send(req.query['hub.challenge']);
  } else {
    console.error("Failed validation. Make sure the validation tokens match.");
    res.sendStatus(403);
  }
});

app.post('/webhook', function (req, res) {
  var data = req.body;

  // Make sure this is a page subscription
  if (data.object == 'page') {
    // Iterate over each entry
    // There may be multiple if batched
    data.entry.forEach(function(pageEntry) {
      var pageID = pageEntry.id;
      var timeOfEvent = pageEntry.time;

      // Iterate over each messaging event
      pageEntry.messaging.forEach(function(messagingEvent) {
        if (messagingEvent.optin) {
          receivedAuthentication(messagingEvent);
        } else if (messagingEvent.message) {
          receivedMessage(messagingEvent);
        } else {
          console.log("Webhook received unknown messagingEvent: ", messagingEvent);
        }
      });
    });

    res.sendStatus(200);
  }
});

function verifyRequestSignature(req, res, buf) {
  var signature = req.headers["x-hub-signature"];

  if (!signature) {
    console.error("Couldn't validate the signature.");
  } else {
    var elements = signature.split('=');
    var method = elements[0];
    var signatureHash = elements[1];

    var expectedHash = crypto.createHmac('sha1', APP_SECRET)
                        .update(buf)
                        .digest('hex');

    if (signatureHash != expectedHash) {
      throw new Error("Couldn't validate the request signature.");
    }
  }
}

function receivedAuthentication(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfAuth = event.timestamp;

  var passThroughParam = event.optin.ref;

  console.log("Received authentication for user %d and page %d with pass " +
    "through param '%s' at %d", senderID, recipientID, passThroughParam,
    timeOfAuth);

  sendTextMessage(senderID, "Authentication successful");
}

function receivedMessage(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfMessage = event.timestamp;
  var message = event.message;

  console.log("Received message for user %d and page %d at %d with message:",
    senderID, recipientID, timeOfMessage);
  console.log(JSON.stringify(message));

  var isEcho = message.is_echo;
  var messageId = message.mid;
  var appId = message.app_id;
  var metadata = message.metadata;

  var messageText = message.text;
  var messageAttachments = message.attachments;
  var quickReply = message.quick_reply;

  if (isEcho) {
    console.log("Received echo for message %s and app %d with metadata %s",
      messageId, appId, metadata);
    return;
  }

  if (messageText || quickReply) {
    mainFlow(senderID, messageText || quickReply.payload);
  } else if (messageAttachments) {
    sendTextMessage(senderID, "Message with attachment received");
  }
}

function mainFlow(senderID, text) {
  console.log('============ main flow ============');
  getUser(senderID, function(user) {
    if (user == null) {
      getMessengerProfile(senderID, function(name) {
        addUserToBD(senderID, name);
        var newuser = {name: name, messenger_id: sender_id};
        sendStartMessage(newuser);
      });
    }
    sendStartMessage(user);
  });
}

function getUser(messengerID, callback) {
  console.log('============ get user ============');
  pg.connect(process.env.DATABASE_URL, function(err, client, done) {
    client.query( 'SELECT * FROM users WHERE messenger_id = $1::text', [messengerID], function(err, result) {
      done();
      if (err){
        console.error(err);
      }
      if (result.rows.length > 0) {
        callback(result.rows[0]);
      } else {
        callback(null);
      }
    });
  });
}

function addUserToBD(messengerID, name, callback) {
  console.log('============ add user db ============');
  pg.connect(process.env.DATABASE_URL, function(err, client, done) {
    client.query( 'insert into users (name, messenger_id, current_state) values ($1::text, $2::text, $3::text)', [name, messengerID, 'start'], function(err, result) {
      done();
      if (err){
        console.error(err);
      }
      if (callback) {
        if (result.rows.length > 0) {
          callback(result.rows[0]);
        } else {
          callback(null);
        }
      }
    });
  });
}

function getMessengerProfile(messengerID, callback) {
  console.log('============ messenger profile ============');
  request({
    uri: 'https://graph.facebook.com/v2.6/'+messengerID,
    qs: { fields: 'first_name,last_name', access_token: PAGE_ACCESS_TOKEN },
    method: 'GET',
  }, function (error, response, body) {
    if (!error && response.statusCode == 200) {
      callback(body.first_name + ' ' + body.last_name);
    } else {
      console.log(error);
    }
  });
}

function sendStartMessage(user) {
  console.log('============ send start ============');
  console.log(user);
  sendTextMessage(user.messenger_id, user.name + ', aqui estão suas opções iniciais:');
}

function sendTextMessage(recipientId, messageText) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: messageText,
      metadata: "DEVELOPER_DEFINED_METADATA"
    }
  };

  callSendAPI(messageData);
}

function callSendAPI(messageData) {
  request({
    uri: 'https://graph.facebook.com/v2.6/me/messages',
    qs: { access_token: PAGE_ACCESS_TOKEN },
    method: 'POST',
    json: messageData

  }, function (error, response, body) {
    if (!error && response.statusCode == 200) {
      var recipientId = body.recipient_id;
      var messageId = body.message_id;

      if (messageId) {
        console.log("Successfully sent message with id %s to recipient %s",
          messageId, recipientId);
      } else {
      console.log("Successfully called Send API for recipient %s",
        recipientId);
      }
    } else {
      console.error("Failed calling Send API", response.statusCode, response.statusMessage, body.error);
    }
  });
}

app.listen(app.get('port'), function() {
  console.log('Node app is running on port', app.get('port'));
});

module.exports = app;
