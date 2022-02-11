const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

const db = admin.firestore();

const dbTokenCollection = db.doc(functions.config().f1bot.token_collection);

const twitterId = "1489655840156045323";

const TwitterApi = require("twitter-api-v2").default;
const twitterClient = new TwitterApi({
  clientId: functions.config().f1bot.client_id,
  clientSecret: functions.config().f1bot.client_secret,
});

const callbackURL = process.env.FUNCTIONS_EMULATOR ?
  functions.config().f1bot.local_firebase_url :
  functions.config().f1bot.firebase_url;

function presentableDate(date) {
  const dateString = date.toDateString();
  const lastIndex = dateString.lastIndexOf(" ");
  return dateString.substring(0, lastIndex);
}

async function minutesTweetedAgo(client) {
  const now = new Date();
  const tweets = await client.v2.userTimeline(
      twitterId, {
        "tweet.fields": "created_at",
        "exclude": ["replies", "retweets"],
        "max_results": 5,
      },
  );
  const latest = tweets.tweets[0];
  const latestCreatedAt = new Date(latest.created_at);
  return Math.round(Math.abs(now - latestCreatedAt) / 60000);
}

// Step 1
exports.auth = functions.https.onRequest(async (request, response) => {
  const {url, codeVerifier, state} = twitterClient.generateOAuth2AuthLink(
      callbackURL,
      {
        scope: ["tweet.write", "tweet.read", "users.read", "offline.access"],
      },
  );

  // store verifier
  await dbTokenCollection.set({codeVerifier, state});

  response.redirect(url);
});

// Step 2
exports.callback = functions.https.onRequest(async (request, response) => {
  const {state, code} = request.query;

  const dbSnapshot = await dbTokenCollection.get();
  const {codeVerifier, state: storedState} = dbSnapshot.data();

  if (state !== storedState) {
    return response.status(400).send("Stored tokens didn't match!");
  }

  const {
    client: loggedClient,
    accessToken,
    refreshToken,
  } = await twitterClient.loginWithOAuth2({
    code,
    codeVerifier,
    redirectUri: callbackURL,
  });

  await dbTokenCollection.set({accessToken, refreshToken});

  const {data} = await loggedClient.v2.me();
  response.send(data);
});

// Step 3
exports.dailyLaunchReminder = functions.https.onRequest(
    async (request, response) => {
      const {refreshToken} = (await dbTokenCollection.get()).data();

      const {
        client: refreshedClient,
        accessToken,
        refreshToken: newRefreshToken,
      } = await twitterClient.refreshOAuth2Token(refreshToken);

      await dbTokenCollection.set({accessToken, refreshToken: newRefreshToken});

      let msg = "";
      const today = new Date();
      const tomorrow = new Date(today);
      tomorrow.setDate(today.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);

      // if before final livery reveal, announce livery reminder
      const nextLiveryReveals = await db
          .collection("liveries")
          .orderBy("date")
          .where("date", ">", today)
          .limit(4)
          .get();

      if (!nextLiveryReveals.empty) {
      // Announce upcoming livery reveals
        msg = "🚨 Daily F1 Car Launch Reminder 🚨\n\n";

        const todayReveals = await db
            .collection("liveries")
            .orderBy("date")
            .where("date", ">", today)
            .where("date", "<", tomorrow)
            .get();

        if (!todayReveals.empty) {
        // If launches today, list them first
          msg += "Launching today:\n";

          todayReveals.forEach((doc) => {
            msg += `\n${doc.data().team} - ${doc
                .data()
                .date.toDate()
                .toLocaleTimeString()} GMT`;
            if (doc.data().link) {
              msg += `\n${doc.data().link}`;
            }
            nextLiveryReveals.docs.shift();

            if (nextLiveryReveals.docs.length > 0) {
              msg += "\n\nUpcoming:\n";
              nextLiveryReveals.docs.forEach((doc) => {
                msg += `\n${doc.data().team} - ${presentableDate(
                    doc.data().date.toDate(),
                )} (${
                  doc.data().date.toDate().getDate() - today.getDate()
                } days)`;
              });
              nextLiveryReveals.docs.shift();
            }
          });
        } else {
        // Else list all
          msg += "Next launch:\n\n";
          msg += `${nextLiveryReveals.docs[0].data().team} - ${presentableDate(
              nextLiveryReveals.docs[0].data().date.toDate(),
          )} (${
            nextLiveryReveals.docs[0].data().date.toDate().getDate() -
          today.getDate()
          } day(s))\n\n`;

          if (nextLiveryReveals.docs.length > 1) {
            nextLiveryReveals.docs.shift();
            msg += "Following launches:\n";
            nextLiveryReveals.docs.forEach((doc) => {
              msg += `\n${doc.data().team} - ${presentableDate(
                  doc.data().date.toDate(),
              )} (${doc.data().date.toDate().getDate() -
                today.getDate()} days)`;
            });
          }
        }
      }

      msg += "\n\n#F1 @F1";

      const {data} = await refreshedClient.v2.tweet(msg);
      response.send(data);
    },
);

exports.nextLaunchReminder = functions.https.onRequest(
    async (request, response) => {
      const {refreshToken} = (await dbTokenCollection.get()).data();

      const {
        client: refreshedClient,
        accessToken,
        refreshToken: newRefreshToken,
      } = await twitterClient.refreshOAuth2Token(refreshToken);

      await dbTokenCollection.set({accessToken, refreshToken: newRefreshToken});

      let msg = "";
      const today = new Date();
      const tomorrow = new Date(today);
      tomorrow.setDate(today.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);

      // if before final livery reveal, announce livery reminder
      const nextLiveryReveal = await db
          .collection("liveries")
          .orderBy("date")
          .where("date", ">", today)
          .where("date", "<", tomorrow)
          .limit(1)
          .get();

      const tweetedAgo = await minutesTweetedAgo(refreshedClient);

      if (nextLiveryReveal.empty) {
        return response.send(200);
      }

      const doc = nextLiveryReveal.docs[0].data();

      // Announce upcoming livery reveals
      msg = "🚨 F1 Car Launch Reminder 🚨\n\n";

      // Show the time of the launch
      msg += `${doc.team} - ${doc
          .date.toDate()
          .toLocaleTimeString()} GMT\n`;

      // How long left to go
      const hours = Math.round(Math.abs(doc.date.toDate() - today) / 36e5);
      const mins = Math.round(Math.abs(doc.date.toDate() - today) / 60000);

      // If too long away then do not tweet
      if (hours > 3) {
        return response.send(200);
      }

      // Build tweet
      if (hours < 1) {
        if (mins > 36) {
          return response.send(200);
        } else if (mins > 10) {
          msg += `${mins} Minutes To Go`;
        } else {
          msg += "Launch is happening now!";
        }
      } else if (tweetedAgo > 59 && (mins % 60) < 10) {
        msg += `${hours} Hour(s) To Go`;
      } else {
        return response.send(200);
      }

      // Attach link if available
      if (doc.link) {
        msg += `\n\nLink - ${doc.link}`;
      }

      // @ Twitter account
      msg += `\n\n@${doc.twitter_handle}\n#F1 #${doc.team.replace(/\s+/g, "")}`;

      const {data} = await refreshedClient.v2.tweet(msg);
      response.send(data);
    },
);
