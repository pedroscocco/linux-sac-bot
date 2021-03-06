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
var StateMachine = require('javascript-state-machine');
var cool = require('cool-ascii-faces');


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
        var newuser = {name: name, messenger_id: senderID};
        sendStartMessage(newuser);
      });
      return;
    }
    handleUserStateTransition(user, text);
  });
}

function getUser(messengerID, callback) {
  console.log('============ get user ============');
  pg.connect(process.env.DATABASE_URL, function(err, client, done) {
    client.query( 'SELECT * FROM users WHERE messenger_id = $1::text;', [messengerID], function(err, result) {
      done();
      if (err){
        console.error(err);
      }
      if (result.rows.length > 0) {
        console.log(result.rows[0]);
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
    client.query( 'insert into users (name, messenger_id, current_state) values ($1::text, $2::text, $3::text);', [name, messengerID, 'start'], function(err, result) {
      done();
      if (err){
        console.error(err);
      }
      if (callback) {
        if (result && result.rows && result.rows.length > 0) {
          callback(result.rows[0]);
        } else {
          callback(null);
        }
      }
    });
  });
}

function updateUserStateDB(user, state, callback){
  console.log('============ update user db ============');
  pg.connect(process.env.DATABASE_URL, function(err, client, done) {
    client.query( 'UPDATE users SET current_state=$1::text WHERE messenger_id=$2::text;', [state, user.messenger_id], function(err, result) {
      done();
      if (err){
        console.error(err);
      }
      console.log(result);
      if (callback) {
        if (result && result.rows && result.rows.length > 0) {
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

const FSM_DEFAULT_TRANSITIONS = [
  { name: 'Sobre Impressão',  from: 'start',  to: 'print_1' },
  { name: 'Reportar Problema', from: 'start', to: 'problem_1'    },
  { name: 'Tirar Dúvida',  from: 'start',    to: 'doubt_1' },
  { name: 'Próximo', from: 'print_1', to: 'print_2'  },
  { name: 'Próximo', from: 'print_2', to: 'print_3'  },
  { name: 'Recomeçar', from: '*', to: 'start'  }
];

const STATE_CONTENTS = {
  start: 'Vamos recomeçar! O que deseja fazer?',
  print_1: 'Qual minha quota mensal de impressão?\n\n75 páginas.',
  print_2: 'Como faço para saber quantas páginas restantes eu tenho na minha quota?\n\nAbra um terminal e digite:\n$ quotap',
  print_3: 'A impressora não está imprimindo, o que faço?\n\nPrimeiramente, não mande o trabalho de impressão várias vezes, pois isso fará com que você perca quota de impressão.',
  problem_1: 'Comando ainda não suportado.',
  doubt_1: 'Comando ainda não suportado.'
};

function sendStartMessage(user) {
  console.log('============ send start ============');
  var message = user.name + ', aqui estão suas opções iniciais:';
  var fsm = StateMachine.create({
    initial: 'start',
    events: FSM_DEFAULT_TRANSITIONS
  });
  var options = fsm.transitions();
  sendQuickReply(user.messenger_id, message, options);
}

function handleUserStateTransition(user, transition) {
  if (transition == 'cool') {
    var message = 'Say whaaaaaaaat?';
    sendQuickReply(user.messenger_id, message, [cool(), cool(), cool(), cool(), cool()]);
    return;
  }
  console.log('============ handle state ============');
  var fsm = StateMachine.create({
    initial: user.current_state,
    events: FSM_DEFAULT_TRANSITIONS
  });

  if (fsm.cannot(transition)) {
    console.log('============ Unknown transition ============');
    console.log(transition);
    console.log(fsm.transitions());
    var message = 'Não entendi o que você deseja! Aqui estão suas opções:';
    sendQuickReply(user.messenger_id, message, fsm.transitions());
    return;
  }

  console.log(fsm.current);
  fsm[transition]();
  updateUserStateDB(user, fsm.current);
  user.current_state = fsm.current;
  console.log('============ transitioned ============');
  console.log(fsm.current);

  sendTextMessage(user.messenger_id, STATE_CONTENTS[fsm.current]);
  setTimeout(function(){
    sendQuickReply(user.messenger_id, 'Opções:', fsm.transitions());
  }, 1000);
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

function sendQuickReply(recipientId, message, options) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: message,
      quick_replies: options.map(function(option) {
        return {
          "content_type":"text",
          "title": option,
          "payload": option
        };
      })
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
