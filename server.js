const express = require('express');
const { RtcTokenBuilder, RtcRole } = require('agora-access-token');
const admin = require('firebase-admin');
const cors = require('cors');
const cron = require('node-cron');

const app = express();
const port = process.env.PORT || 3000;

// CONFIG AGORA
const APP_ID = process.env.AGORA_APP_ID;
const APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;

const serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
app.use(cors());
app.use(express.json());

async function calculateUpvotesAndUpdatePoints() {
  try {
    const postsSnapshot = await db.collection('posts').get();
    if (postsSnapshot.empty) {
      console.log('No posts found.');
      return;
    }

    const userActivityPoints = {};

    for (const postDoc of postsSnapshot.docs) {
      const postId = postDoc.id;
      const postData = postDoc.data();
      const userId = postData.uid;

      const postVotesSnapshot = await db
        .collection('posts')
        .doc(postId)
        .collection('post_votes')
        .get();

      if (!postVotesSnapshot.empty) {
        const upvotes = postVotesSnapshot.size;

        if (userActivityPoints[userId]) {
          userActivityPoints[userId] += upvotes;
        } else {
          userActivityPoints[userId] = upvotes;
        }
      }
    }

    const batch = db.batch();
    for (const [userId, points] of Object.entries(userActivityPoints)) {
      const userRef = db.collection('users').doc(userId);
      batch.update(userRef, {
        activityPoint: admin.firestore.FieldValue.increment(points),
      });
    }

    await batch.commit();
    console.log('Successfully updated user activity points.');

  } catch (error) {
    console.error('Error calculating upvotes and updating points:', error);
  }
}

cron.schedule('* * * * *', () => {
  console.log('Running a task to calculate upvotes and update user activity points.');
  calculateUpvotesAndUpdatePoints();
});


async function deleteExpiredSuspensions() {
  const now = admin.firestore.Timestamp.now();
  try {
    const suspendedUsersRef = db.collection('suspendedUsers');
    const expiredSuspensions = await suspendedUsersRef.where('expiresAt', '<=', now).get();

    if (!expiredSuspensions.empty) {
      const batch = db.batch();

      expiredSuspensions.forEach(doc => {
        batch.delete(doc.ref);  
      });

      await batch.commit();
      console.log(`Deleted ${expiredSuspensions.size} expired suspensions.`);
    } else {
      console.log('No expired suspensions found.');
    }
  } catch (error) {
    console.error('Error deleting expired suspensions:', error);
  }
}

cron.schedule('0 0 * * *', () => {
  console.log('Running a task to check and delete expired suspensions');
  deleteExpiredSuspensions();
});

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
  const { tokens, message, title, data, type } = req.body;

  if (!Array.isArray(tokens) || tokens.length === 0) {
    return res.status(400).send('Tokens array is required and should not be empty');
  }

  let payload = {
    notification: {
      title: title,
      body: message,
    },
    data: {
      type: data.type,
      uid: data.uid,
    },
  };

  if (type === 'incoming_call') {
    payload = {
      notification: {
        title: title,
        body: message,
      },
      data: {
        type: data.type,
        callId: data.callId,
        callerUid: data.callerUid,
      },
    };
  } else if (type === 'comment_mention') {
    payload = {
      notification: {
        title: title,
        body: message,
      },
      data: {
        type: data.type,
        commentId: data.commentId,
        postId: data.postId,
      },
    };
  }

  try {
    const responses = await admin.messaging().sendEachForMulticast({
      tokens: tokens,
      ...payload,
    });

    const successfulTokens = [];
    const failedTokens = [];

    responses.responses.forEach((response, index) => {
      if (response.success) {
        successfulTokens.push(tokens[index]);
      } else {
        failedTokens.push({
          token: tokens[index],
          error: response.error.message || 'Unknown error',
        });
      }
    });

    console.log('Successfully sent messages:', successfulTokens);

    if (failedTokens.length > 0) {
      console.error('Failed to send messages:', failedTokens);
    }

    return res.status(200).json({
      success: successfulTokens.length,
      failure: failedTokens.length,
      failedTokens,
    });
  } catch (error) {
    console.error('Error sending messages:', error);
    return res.status(500).send('Notification failed to send');
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
