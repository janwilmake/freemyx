# Initial version: 6th of June 2025

- ✅ Fix current redirect bug. identify issue, ensure that never happens (maybe need basic plan, but may be able to do this infinite in different way)
- ✅ Add scientists as group. Make form more fine-grained. Public domain is FULLY LIBERATED. Can't do anything with controlled data provision for now
- Come up with the minimal flow for a third party app to leverage this without oauth provider. there's no data here so no need, they could just use my oauth and ensure there's a proper redirect and message before X OAuth.
- ✅ After approval show ways to help
  - ✅ tweet with `#freemyx`
  - ✅ donate to support the 'data liberation movement'
- ✅ json readability
- ✅ Get back to feedback in `#data-policy`

# Social proof (june 14, 2025)

✅ For Free My X, gather user profile info once at time of unlock (Through twitterapi.io).

✅ Worker with scheduled daily cronjob that augments freemyx.com/list.json with the profile from twitterapi.io (large profile pic url, followers, following, description) and makes it accessible on list.freemyx.com/list.json - It uses R2 for storage of the blob and updates this daily. The worker is called list-calculator.freemyx.com and has no fetch entrypoint, it just calculates the R2 value daily.

✅ Make the calculator closed-source for now to prevent twitter from knownig that we use an illegal api.

✅ Then create a top 10 + cont on the frontpage. This is the social proof that's missing right now.

wall of love (#freemyx) - how though?

Share this with the OMG Discord and ask if they think it's ready for launch. Get the whole OMG community to unlock their data. Try to get a meeting with some of them to demo markdownfeed.
