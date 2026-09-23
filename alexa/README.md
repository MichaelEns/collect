# Joe's Collection Alexa skill

This custom skill reads the same live family collection as the web app. It
uses the existing four-word sharing code instead of Amazon account linking.
The code is stored in Workers KV under a one-way hash of the Alexa user ID. It
is never placed in the skill source or repeated in a spoken response.

## What to say

After enabling the skill, pair each Amazon account once:

> Alexa, ask Joe's collection to use sharing code [first word] [second word]
> [third word] [fourth word].

Then ask, for example:

> Alexa, ask Joe's collection how many red Death Star guys does Joe need.

> Alexa, ask Joe's collection what's in gray Death Star code I eight.

> Alexa, ask Joe's collection what code is Queen Amidala in the red Death Star.

That reverse lookup returns every recorded code for the named figure, including
separately identified disputed collector reports.

Package color matters. The skill understands gray and red Death Stars, blue
and orange Cargo Drops, the gray AT-AT, and blue, green, and purple Toy Story
backpacks. An uncolored Death Star, Cargo Drop, or backpack prompts for the
color rather than guessing.

## Deploy

1. Deploy the credential check in `worker/src/index.js` with
   `cd worker; npx wrangler deploy`. The same deployment publishes the signed
   Alexa HTTPS endpoint at `/alexa` and makes a well-formed but unallocated
   four-word code fail pairing instead of looking like an empty collection.
2. In the [Alexa Developer Console](https://developer.amazon.com/alexa/console/ask),
   create a **Custom** skill named **Joe's Collection**, choose
   **Provision your own**, and use the **Start from scratch** template.
3. Deploy `skill-package/skill.json` and
   `skill-package/interactionModels/custom/en-US.json`. The manifest points to
   `https://collect-sync.michaelens.workers.dev/alexa`.
4. Set `ALEXA_SKILL_ID` in `worker/wrangler.toml` to the created skill ID and
   redeploy the Worker. No AWS account, Lambda ARN, OAuth client, or new server
   secret is required. The Worker verifies Amazon's signing certificate,
   request signature, timestamp, and skill ID before handling a request.
5. In **Test**, enable development testing and pair a test account. The code is
   validated against the collection worker before it is saved.
6. For the three family households, either invite each Amazon account to a
   90-day beta or publish the skill for durable access. A published listing
   does not expose the collection: without its four-word code the skill has no
   data to read. Use the included privacy-policy and terms URLs during
   certification.

Alexa voice history may retain what was spoken during pairing. Anyone who
learns the four words has the same collection access as a browser with that
code, so use **forget my sharing code** on an account that should no longer
have access.

## Test locally

From the repository root:

```powershell
$tests = @((Get-ChildItem .\tests\*.test.mjs).FullName) +
  @((Get-ChildItem .\tests\*.test.cjs).FullName)
node --test $tests
```

The tests use local fixtures and never read or print a real family code.
