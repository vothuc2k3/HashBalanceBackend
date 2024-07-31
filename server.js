const express = require('express');
const { RtcTokenBuilder, RtcRole } = require('agora-access-token');
const admin = require('firebase-admin');
const bodyParser = require('body-parser');

// INIT EXPRESS
const app = express();
const port = process.env.PORT || 3000; // Sử dụng cổng từ biến môi trường của Heroku

// CONFIG AGORA
const APP_ID = '8a2ac699a8c84f3f894f59e55e766fa4';
const APP_CERTIFICATE = '4c982f62b66a41e497009008aa7d10d7';

// CONFIG FIREBASE ADMIN SDK
const serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

app.use(bodyParser.json());

// ENDPOINT TO GET TOKEN FROM AGORA
app.get('/access_token', (req, res) => {
  const channelName = req.query.channelName;
  if (!channelName) {
    return res.status(400).json({ 'error': 'Channel name is required' });
  }

  const uid = req.query.uid ? parseInt(req.query.uid) : 0;
  const role = RtcRole.PUBLISHER;

  const expirationTimeInSeconds = 3600;
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

  const token = RtcTokenBuilder.buildTokenWithUid(APP_ID, APP_CERTIFICATE, channelName, uid, role, privilegeExpiredTs);

  return res.json({ 'token': token });
});

// ENDPOINT TO SEND PUSH NOTIFICATION WITH FCM
app.post('/sendPushNotification', async (req, res) => {
  const { tokens, message, title } = req.body;

  if (!Array.isArray(tokens) || tokens.length === 0) {
    return res.status(400).send('Tokens array is required and should not be empty');
  }

  const payload = {
    notification: {
      title: title,
      body: message,
    },
  };

  try {
    const responses = await admin.messaging().sendEachForMulticast({
      tokens: tokens,
      ...payload,
    });

    // Log and return response with detailed results
    const successfulTokens = responses.responses.filter(r => r.success).map((r, i) => tokens[i]);
    const failedTokens = responses.responses.filter(r => !r.success).map((r, i) => tokens[i]);

    console.log('Successfully sent messages:', successfulTokens);
    if (failedTokens.length > 0) {
      console.error('Failed to send messages:', failedTokens);
    }

    return res.status(200).json({
      success: successfulTokens.length,
      failure: failedTokens.length,
    });
  } catch (error) {
    console.error('Error sending messages:', error);
    return res.status(500).send('Notification failed to send');
  }
});

//START THE SERVER
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
