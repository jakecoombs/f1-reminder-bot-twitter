const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

const dotenv = require("dotenv");
dotenv.config();

const dbTokenCollection = admin.firestore().doc(process.env.TOKEN_COLLECTION);

const TwitterApi = require("twitter-api-v2").default;
const twitterClient = new TwitterApi({
  clientId: process.env.CLIENT_ID,
  clientSecret: process.env.CLIENT_SECRET,
});

const callbackURL =
  `${process.env.FIREBASE_URL}/${process.env.CALLBACK_PATH}`;

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
exports.tweet = functions.https.onRequest(async (request, response) => {
  const {refreshToken} = (await dbTokenCollection.get()).data();

  const {
    client: refreshedClient,
    accessToken,
    refreshToken: newRefreshToken,
  } = await twitterClient.refreshOAuth2Token(refreshToken);

  await dbTokenCollection.set({accessToken, refreshToken: newRefreshToken});

  // todo: sort logic for sending a tweet
  const nextTweet = "Testing bot.";

  const {data} = await refreshedClient.v2.tweet(nextTweet);
  response.send(data);
});
