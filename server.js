const express = require('express');
const { RtcTokenBuilder, RtcRole } = require('agora-access-token');
const admin = require('firebase-admin');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// INIT EXPRESS
const app = express();
const port = process.env.PORT || 3000;

// CONFIG AGORA
const APP_ID = process.env.AGORA_APP_ID;
const APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;

// CONFIG FIREBASE ADMIN SDK
const serviceAccountPath = path.resolve(__dirname, 'firebase.json');

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

  const expirationTimeInSeconds = 300;
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

  const token = RtcTokenBuilder.buildTokenWithUid(APP_ID, APP_CERTIFICATE, channelName, uid, role, privilegeExpiredTs);

  console.log('Generated token:', token);

  return res.json({ 'token': token });
});

// ENDPOINT TO SEND PUSH NOTIFICATION WITH FCM
app.post('/sendPushNotification', async (req, res) => {
  const { token, message, title, data } = req.body;

  if (!token) {
    return res.status(400).send('Token is required');
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
    const response = await admin.messaging().send({
      token: token,
      ...payload,
    });

    // Log and return response with detailed results
    console.log('Successfully sent message:', response);
    return res.status(200).json({
      success: 1,
      failure: 0,
      response,
    });
  } catch (error) {
    console.error('Error sending message:', error);
    return res.status(500).send('Notification failed to send');
  }
});


// START THE SERVER
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
