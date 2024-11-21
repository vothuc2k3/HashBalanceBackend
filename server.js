const express = require('express');
const { RtcTokenBuilder, RtcRole } = require('agora-access-token');
const admin = require('firebase-admin');
const cors = require('cors');
const cron = require('node-cron');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

// CONFIG AGORA
const APP_ID = process.env.AGORA_APP_ID;
const APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;

// INITIALIZE FIREBASE
const serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// MIDDLEWARE
app.use(cors());
app.use(express.json());

// FUNCTIONS
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

      const postVotesSnapshot = await db.collection('posts').doc(postId).collection('post_votes').get();
      if (!postVotesSnapshot.empty) {
        const upvotes = postVotesSnapshot.size;
        userActivityPoints[userId] = (userActivityPoints[userId] || 0) + upvotes;
      }
    }

    const batch = db.batch();
    for (const [userId, points] of Object.entries(userActivityPoints)) {
      const userRef = db.collection('users').doc(userId);
      batch.update(userRef, {
        activityPoint: points,
      });
    }

    await batch.commit();
    console.log('Successfully updated user activity points.');
  } catch (error) {
    console.error('Error calculating upvotes and updating points:', error);
  }
}

function checkAndDeleteExpiredSuspensions() {
  const now = admin.firestore.Timestamp.now();
  const suspendedUsersRef = db.collection('suspended_users');

  suspendedUsersRef.where('expiresAt', '<=', now).get().then(snapshot => {
    if (!snapshot.empty) {
      const batch = db.batch();

      snapshot.docs.forEach(doc => {
        const uid = String(doc.data().uid).trim();
        const communityId = String(doc.data().communityId).trim();

        const membershipId = `${uid}${communityId}`;

        const communityMembershipRef = db.collection('community_memberships').doc(membershipId);
        batch.update(communityMembershipRef, { status: 'active' });
        batch.delete(doc.ref);
      });

      batch.commit()
        .then(() => console.log(`Deleted ${snapshot.size} expired suspensions and updated statuses.`))
        .catch(error => console.error('Error processing expired suspensions:', error));
    } else {
      console.log('No expired suspensions found.');
    }
  }).catch(error => console.error('Error querying expired suspensions:', error));
}

async function generateAgoraToken(req, res) {
  const channelName = req.query.channelName;
  if (!channelName) {
    return res.status(400).json({ error: 'Channel name is required' });
  }

  const uid = req.query.uid ? parseInt(req.query.uid) : 0;
  const role = RtcRole.PUBLISHER;
  const expirationTimeInSeconds = 300;
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;
  const token = RtcTokenBuilder.buildTokenWithUid(APP_ID, APP_CERTIFICATE, channelName, uid, role, privilegeExpiredTs);

  console.log('Generated token:', token);
  return res.json({ token });
}

async function sendPushNotification(req, res) {
  const { tokens, message, title, data, type } = req.body;

  if (!Array.isArray(tokens) || tokens.length === 0) {
    return res.status(400).send('Tokens array is required and should not be empty');
  }

  let payload = {
    notification: { title, body: message },
    data: { type: data.type, uid: data.uid },
  };

  if (type === 'incoming_call') {
    payload.data = { type: data.type, callId: data.callId, callerUid: data.callerUid };
  } else if (type === 'comment_mention') {
    payload.data = { type: data.type, commentId: data.commentId, postId: data.postId };
  }

  try {
    const responses = await admin.messaging().sendEachForMulticast({ tokens, ...payload });
    const successfulTokens = [];
    const failedTokens = [];

    responses.responses.forEach((response, index) => {
      response.success ? successfulTokens.push(tokens[index]) : failedTokens.push({ token: tokens[index], error: response.error.message || 'Unknown error' });
    });

    console.log('Successfully sent messages:', successfulTokens);
    if (failedTokens.length > 0) console.error('Failed to send messages:', failedTokens);

    return res.status(200).json({ success: successfulTokens.length, failure: failedTokens.length, failedTokens });
  } catch (error) {
    console.error('Error sending messages:', error);
    return res.status(500).send('Notification failed to send');
  }
}

async function detectAdultContent(base64Images) {
  const API_URL = `https://vision.googleapis.com/v1/images:annotate?key=${process.env.GOOGLE_CLOUD_API_KEY}`;

  const requests = base64Images.map((base64Image) => ({
    image: { content: base64Image },
    features: [{ type: 'SAFE_SEARCH_DETECTION' }],
  }));

  try {
    const response = await axios.post(API_URL, { requests });

    const results = response.data.responses.map((result, index) => {
      if (result.safeSearchAnnotation) {
        const { adult, violence, medical, racy } = result.safeSearchAnnotation;
        return {
          imageIndex: index,
          adultLikelihood: adult,
          violenceLikelihood: violence,
          medicalLikelihood: medical,
          racyLikelihood: racy,
        };
      } else {
        return { imageIndex: index, error: 'No safeSearchAnnotation detected' };
      }
    });

    return results;
  } catch (error) {
    console.error('Error detecting content:', error);
    throw new Error('Failed to analyze images.');
  }
}

async function detectToxicity(textList) {
  const API_URL = `https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze?key=${process.env.GOOGLE_CLOUD_API_KEY}`;

  try {
    const requests = textList.map(text => {
      return axios.post(API_URL, {
        comment: { text },
        languages: ['en'],
        requestedAttributes: {
          TOXICITY: {},
          SEVERE_TOXICITY: {},
          INSULT: {},
          PROFANITY: {},
          THREAT: {},
        },
      });
    });

    const responses = await Promise.all(requests);

    const results = responses.map((response, index) => {
      const attributes = response.data.attributeScores;
      const toxicity = attributes.TOXICITY.summaryScore.value;
      const severeToxicity = attributes.SEVERE_TOXICITY.summaryScore.value;
      const insult = attributes.INSULT.summaryScore.value;
      const profanity = attributes.PROFANITY.summaryScore.value;
      const threat = attributes.THREAT.summaryScore.value;

      return {
        textIndex: index,
        text: textList[index],
        scores: {
          toxicity,
          severeToxicity,
          insult,
          profanity,
          threat,
        },
        isToxic:
          toxicity > 0.7 ||
          severeToxicity > 0.5 ||
          insult > 0.6 ||
          profanity > 0.6 ||
          threat > 0.5,
      };
    });

    return results;
  } catch (error) {
    console.error('Error detecting toxicity:', error.response?.data || error.message);
    throw new Error('Failed to analyze text toxicity.');
  }
}


// ROUTES
app.get('/access_token', generateAgoraToken);
app.post('/sendPushNotification', sendPushNotification);
app.post('/detectAdultContent', async (req, res) => {
  const { base64Images } = req.body;
  if (!Array.isArray(base64Images) || base64Images.length === 0) {
    return res.status(400).send('Base64Images array is required and should not be empty');
  }
  try {
    const results = await detectAdultContent(base64Images);
    return res.status(200).json({ results });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});
app.post('/detectToxicity', async (req, res) => {
  const { texts } = req.body;
  if (!Array.isArray(texts) || texts.length === 0) {
    return res.status(400).send('Texts array is required and should not be empty');
  }
  try {
    const results = await detectToxicity(texts);
    return res.status(200).json({ results });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// CRON JOBS
cron.schedule('0 */3 * * *', () => {
  console.log('Running a task to calculate upvotes and update user activity points.');
  calculateUpvotesAndUpdatePoints();
});

cron.schedule('* * * * *', () => {
  console.log('Checking and deleting expired suspensions.');
  checkAndDeleteExpiredSuspensions();
});

// START SERVER
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
