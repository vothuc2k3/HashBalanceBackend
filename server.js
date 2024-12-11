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
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));


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
  try {
    const channelName = req.query.channelName;
    if (!channelName) {
      return res.status(400).json({ error: 'Channel name is required' });
    }

    const uid = req.query.uid ? parseInt(req.query.uid) : 0;
    const role = RtcRole.PUBLISHER;
    const expirationTimeInSeconds = 300;
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

    const token = RtcTokenBuilder.buildTokenWithUid(
      APP_ID,
      APP_CERTIFICATE,
      channelName,
      uid,
      role,
      privilegeExpiredTs
    );

    console.log('Generated token:', token);
    return res.json({ token });

  } catch (error) {
    console.error('Error generating Agora token:', error);

    if (error instanceof TypeError) {
      return res.status(500).json({ error: 'Invalid input or configuration error.' });
    } else {
      return res.status(500).json({ error: 'An unexpected error occurred while generating the token.' });
    }
  }
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
  } else if (type === 'membership_invitation') {
    payload.data = { type: data.type, communityId: data.communityId };
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

async function sendPushNotificationInternal({ tokens, message, title, data, type }) {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    throw new Error("Tokens array is required and should not be empty");
  }

  const payload = {
    notification: { title, body: message },
    data: { type, ...data },
  };

  try {
    const responses = await admin.messaging().sendEachForMulticast({ tokens, ...payload });
    const failedTokens = [];

    responses.responses.forEach((response, index) => {
      if (!response.success) {
        failedTokens.push({ token: tokens[index], error: response.error.message || "Unknown error" });
      }
    });

    if (failedTokens.length > 0) {
      console.error("Failed to send some notifications:", failedTokens);
    }

    return true;
  } catch (error) {
    console.error("Error sending push notification:", error.message);
    throw error;
  }
}


async function analyzeImageSafety(base64Image) {
  const API_URL = `https://vision.googleapis.com/v1/images:annotate?key=${process.env.GOOGLE_CLOUD_API_KEY}`;

  try {
    const request = {
      requests: [
        {
          image: { content: base64Image },
          features: [{ type: "SAFE_SEARCH_DETECTION" }],
        },
      ],
    };

    const response = await axios.post(API_URL, request);

    if (response.status !== 200) {
      throw new Error(`Failed to analyze image. Status code: ${response.status}`);
    }

    const safeSearch = response.data.responses[0]?.safeSearchAnnotation || {};
    const isSafe =
      (safeSearch.adult === "VERY_UNLIKELY" || safeSearch.adult === "UNLIKELY") &&
      (safeSearch.violence === "VERY_UNLIKELY" ||
        safeSearch.violence === "UNLIKELY") &&
      (safeSearch.racy === "VERY_UNLIKELY" || safeSearch.racy === "UNLIKELY") &&
      (safeSearch.medical === "VERY_UNLIKELY" ||
        safeSearch.medical === "UNLIKELY") &&
      (safeSearch.spoof === "VERY_UNLIKELY" || safeSearch.spoof === "UNLIKELY");

    return isSafe;
  } catch (error) {
    console.error("Error during single image safety analysis:", error.message);
    throw error;
  }
}


async function detectToxicity(text) {
  const API_URL = `https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze?key=${process.env.GOOGLE_CLOUD_API_KEY}`;

  try {
    const response = await axios.post(API_URL, {
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

    const attributes = response.data.attributeScores;
    const toxicity = attributes.TOXICITY.summaryScore.value;
    const severeToxicity = attributes.SEVERE_TOXICITY.summaryScore.value;
    const insult = attributes.INSULT.summaryScore.value;
    const profanity = attributes.PROFANITY.summaryScore.value;
    const threat = attributes.THREAT.summaryScore.value;

    return {
      text,
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
  } catch (error) {
    console.error('Error detecting toxicity:', error.response?.data || error.message);
    throw new Error('Failed to analyze text toxicity.');
  }
}

async function disableUserAccount(req, res) {
  const { uid } = req.body;

  if (!uid || typeof uid !== "string" || uid.length > 128) {
    return res.status(400).json({
      message: "Invalid UID. UID must be a non-empty string with at most 128 characters.",
    });
  }

  try {
    await admin.auth().updateUser(uid, { disabled: true });
    console.log(`User with UID ${uid} has been disabled.`);
    res.status(200).json({ message: "User account disabled successfully" });
  } catch (error) {
    console.error("Error disabling user:", error);
    res.status(500).json({
      message: "Failed to disable user account",
      error: error.message,
    });
  }
}


async function checkAdminRole(req, res) {
  console.log('Checking admin role...');
  const { uid } = req.body;

  if (!uid) {
    return res.status(400).send({ error: 'UID is required' });
  }

  try {
    const user = await admin.auth().getUser(uid);
    console.log(`Fetched user for UID: ${uid}`);

    const isAdmin = user.customClaims?.role === 'admin';

    res.status(200).send({ isAdmin });
  } catch (error) {
    console.error('Error checking admin role:', error);
    res.status(500).send({ error: 'Failed to check admin role' });
  }
}

async function detectAndAwardBadges() {
  try {
    console.log("Detecting users eligible for badges...");

    const badgesSnapshot = await db.collection("badges").get();
    if (badgesSnapshot.empty) {
      console.log("No badges found.");
      return;
    }

    const badges = badgesSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    const usersSnapshot = await db.collection("users").get();
    if (usersSnapshot.empty) {
      console.log("No users found.");
      return;
    }

    const batch = db.batch();
    const notifications = [];

    usersSnapshot.docs.forEach((userDoc) => {
      const userData = userDoc.data();
      const userId = userDoc.id;
      const userActivityPoint = userData.activityPoint || 0;
      const currentBadgeIds = new Set(userData.badgeIds || []);
      const userDevices = userData.userDevices || [];
      const userNotificationsRef = db
        .collection("users")
        .doc(userId)
        .collection("notifications");

      badges.forEach((badge) => {
        if (
          userActivityPoint >= badge.threshold &&
          !currentBadgeIds.has(badge.id)
        ) {
          currentBadgeIds.add(badge.id);

          // Push notification payload
          if (userDevices.length > 0) {
            notifications.push({
              tokens: userDevices,
              message: `Congratulations! You've earned the "${badge.name}" badge! 🎉`,
              title: "New Badge Earned",
              data: { type: "badge_award", badgeId: badge.id, userId },
              type: "badge_award",
            });
          }

          const notificationId = db.collection("notifications").doc().id;
          const notificationData = {
            id: notificationId,
            title: "New Badge Earned",
            message: `You've earned the "${badge.name}" badge!`,
            type: "badge_award",
            targetUid: userId,
            senderUid: "",
            createdAt: admin.firestore.Timestamp.now(),
            isRead: false,
          };

          batch.set(userNotificationsRef.doc(notificationId), notificationData);
        }
      });

      batch.update(db.collection("users").doc(userId), {
        badgeIds: Array.from(currentBadgeIds),
      });
    });

    await batch.commit();
    console.log("Successfully detected and awarded badges.");

    // Send push notifications
    for (const notification of notifications) {
      try {
        await sendPushNotificationInternal(notification);
        console.log(
          `Successfully sent badge notification to user with tokens: ${notification.tokens}`
        );
      } catch (error) {
        console.error("Error sending badge notification:", error.message);
      }
    }
  } catch (error) {
    console.error("Error detecting and awarding badges:", error);
  }
}

async function promoteToAdmin(req, res) {
  const { uid } = req.body;
  await admin.auth().setCustomUserClaims(uid, { role: 'admin' });
  res.status(200).send({ message: 'User promoted to admin' });
}

// ROUTES
app.post('/promoteToAdmin', promoteToAdmin);

app.post('/isAdmin', checkAdminRole);

app.post('/disableUserAccount', disableUserAccount);

app.get('/agoraAccessToken', generateAgoraToken);

app.post('/sendPushNotification', sendPushNotification);

app.post("/analyzeImage", async (req, res) => {
  const { base64Image } = req.body;

  if (!base64Image || typeof base64Image !== "string") {
    return res
      .status(400)
      .json({ error: "A valid Base64Image string is required." });
  }

  try {
    const isSafe = await analyzeImageSafety(base64Image);
    return res.status(200).json({ isSafe });
  } catch (error) {
    console.error("Error during image safety analysis:", error.message);
    return res.status(500).json({ error: error.message });
  }
});

app.post('/detectToxicity', async (req, res) => {
  const { text } = req.body;
  if (!text || typeof text !== 'string') {
    return res.status(400).send('A valid text string is required.');
  }
  try {
    const result = await detectToxicity(text);
    return res.status(200).json({ result });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// CRON JOBS
// This cron job runs every 5 minutes
cron.schedule('*/5 * * * *', () => {
  console.log('Running a task to calculate upvotes and update user activity points.');
  calculateUpvotesAndUpdatePoints();
});

// This cron job runs every minute
cron.schedule('* * * * *', () => {
  console.log('Checking and deleting expired suspensions.');
  checkAndDeleteExpiredSuspensions();
});

// This cron job runs every 5 minutes
cron.schedule('*/5 * * * *', () => {
  console.log('Detecting and awarding badges.');
  detectAndAwardBadges();
});

// START SERVER
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
