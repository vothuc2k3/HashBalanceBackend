const express = require('express');
const { RtcTokenBuilder, RtcRole } = require('agora-access-token');
const admin = require('firebase-admin');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// INIT EXPRESS
const app = express();
const port = process.env.PORT || 3000; // Sử dụng cổng từ biến môi trường của Heroku

// CONFIG AGORA
const APP_ID = process.env.AGORA_APP_ID;
const APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;

// CONFIG FIREBASE ADMIN SDK
const serviceAccountPath = path.resolve(__dirname, 'firebase_admin_sdk.json');

if (!fs.existsSync(serviceAccountPath)) {
  throw new Error(`The service account key file does not exist at path: ${serviceAccountPath}`);
}

const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

app.use(cors());
app.use(bodyParser.json());

// ENDPOINT TO GET TOKEN FROM AGORA
app.get('/access_token', async (req, res) => {
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
  const { tokens, message, title, data } = req.body;

  if (!Array.isArray(tokens) || tokens.length === 0) {
    return res.status(400).send('Tokens array is required and should not be empty');
  }

  const payload = {
    notification: {
      title: title,
      body: message,
    },
    data: {
      type: data.type,
      uid: data.uid,
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

// START THE SERVER
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
